var MODES = [
  "sword",
  "axe",
  "mace",
  "pot",
  "uhc",
  "vanilla",
  "smp",
  "nethop"
];

var DEFAULT_ELO = 1e3;
var QUEUE_TIMEOUT = 300;
var MATCH_TIMEOUT = 60;
var HEARTBEAT_TIMEOUT = 15;
var ELO_CHANGE = 25;

function json(data, status = 200) {
  return new Response(
    JSON.stringify(data, null, 2),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
      }
    }
  );
}

__name(json, "json");

function normalizeMode(mode) {
  return String(mode || "").trim().toLowerCase();
}

__name(normalizeMode, "normalizeMode");

function validMode(mode) {
  return MODES.includes(normalizeMode(mode));
}

__name(validMode, "validMode");

function normalizeRegion(region) {
  if (!region) {
    return "auto";
  }

  return String(region).trim().toUpperCase();
}

__name(normalizeRegion, "normalizeRegion");

function isValidUUID(uuid) {
  if (!uuid) {
    return false;
  }

  return /^[0-9a-fA-F-]{36}$/.test(String(uuid));
}

__name(isValidUUID, "isValidUUID");

function isValidUsername(username) {
  if (!username) {
    return false;
  }

  const value = String(username);

  return value.length >= 1 && value.length <= 32;
}

__name(isValidUsername, "isValidUsername");

function getTierFromElo(elo) {
  elo = Number(elo) || 0;

  if (elo >= 2250)
    return "HT1";

  if (elo >= 2000)
    return "LT1";

  if (elo >= 1900)
    return "HT2";

  if (elo >= 1800)
    return "LT2";

  if (elo >= 1650)
    return "HT3";

  if (elo >= 1500)
    return "LT3";

  if (elo >= 1300)
    return "HT4";

  if (elo >= 1200)
    return "LT4";

  if (elo >= 1100)
    return "HT5";

  if (elo >= 1000)
    return "LT5";

  return "UNRANKED";
}

__name(getTierFromElo, "getTierFromElo");

function generateMatchId() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

  let result = "MATCH-";

  for (let i = 0; i < 6; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }

  return result;
}

__name(generateMatchId, "generateMatchId");

async function cleanupStaleData(env) {
  const now = Math.floor(Date.now() / 1e3);

  const queueLimit = now - QUEUE_TIMEOUT;
  const matchLimit = now - MATCH_TIMEOUT;

  await env.DB.batch([
    env.DB.prepare(`
      DELETE FROM queue
      WHERE joined_at < ?
    `).bind(queueLimit),

    env.DB.prepare(`
      DELETE FROM matches
      WHERE
        status = 'waiting'
        AND created_at < ?
    `).bind(matchLimit)
  ]);
}

__name(cleanupStaleData, "cleanupStaleData");

async function getPlayerStats(env, uuid, mode) {
  return await env.DB.prepare(`
    SELECT
      uuid,
      mode,
      elo,
      wins,
      losses,
      games_played
    FROM player_stats
    WHERE
      uuid = ?
      AND mode = ?
  `).bind(
    uuid,
    mode
  ).first();
}

__name(getPlayerStats, "getPlayerStats");

async function ensurePlayer(env, uuid, username) {
  await env.DB.prepare(`
    INSERT INTO players (
      uuid,
      username
    )
    VALUES (?, ?)
    ON CONFLICT(uuid)
    DO UPDATE SET
      username = excluded.username,
      updated_at = unixepoch()
  `).bind(
    uuid,
    username
  ).run();

  for (const mode of MODES) {
    await env.DB.prepare(`
      INSERT OR IGNORE
      INTO player_stats (
        uuid,
        mode,
        elo,
        wins,
        losses,
        games_played
      )
      VALUES (
        ?,
        ?,
        ?,
        0,
        0,
        0
      )
    `).bind(
      uuid,
      mode,
      DEFAULT_ELO
    ).run();
  }
}

__name(ensurePlayer, "ensurePlayer");

async function findMatch(env, player) {
  const now = Math.floor(Date.now() / 1e3);

  const minimumJoinedAt = now - QUEUE_TIMEOUT;

  const candidates = await env.DB.prepare(`
    SELECT
      id,
      uuid,
      username,
      mode,
      region,
      elo,
      joined_at
    FROM queue
    WHERE
      mode = ?
      AND uuid != ?
      AND joined_at >= ?
    ORDER BY
      joined_at ASC
    LIMIT 100
  `).bind(
    player.mode,
    player.uuid,
    minimumJoinedAt
  ).all();

  const playerElo = Number(player.elo);

  for (const candidate of candidates.results) {
    const candidateRegion = normalizeRegion(candidate.region);
    const playerRegion = normalizeRegion(player.region);

    if (
      playerRegion !== "auto" &&
      candidateRegion !== "auto" &&
      playerRegion !== candidateRegion
    ) {
      continue;
    }

    const candidateElo = Number(candidate.elo);

    const difference = Math.abs(
      playerElo - candidateElo
    );

    const waited = now - Number(
      player.joined_at
    );

    let allowedDifference = 100;

    if (waited >= 15)
      allowedDifference = 200;

    if (waited >= 30)
      allowedDifference = 400;

    if (waited >= 60)
      allowedDifference = 600;

    if (waited >= 120)
      allowedDifference = 1000;

    if (difference > allowedDifference) {
      continue;
    }

    return candidate;
  }

  return null;
}

__name(findMatch, "findMatch");

async function findServer(env, region) {
  const now = Math.floor(Date.now() / 1e3);

  const heartbeatLimit = now - HEARTBEAT_TIMEOUT;

  let server;

  if (region && region !== "auto") {
    server = await env.DB.prepare(`
      SELECT
        id,
        name,
        region,
        address,
        online,
        players,
        max_players,
        reserved_players,
        last_heartbeat
      FROM servers
      WHERE
        region = ?
        AND online = 1
        AND last_heartbeat >= ?
        AND (
          players +
          reserved_players
        ) < max_players
      ORDER BY
        players ASC
      LIMIT 1
    `).bind(
      region,
      heartbeatLimit
    ).first();
  } else {
    server = await env.DB.prepare(`
      SELECT
        id,
        name,
        region,
        address,
        online,
        players,
        max_players,
        reserved_players,
        last_heartbeat
      FROM servers
      WHERE
        online = 1
        AND last_heartbeat >= ?
        AND (
          players +
          reserved_players
        ) < max_players
      ORDER BY
        players ASC
      LIMIT 1
    `).bind(
      heartbeatLimit
    ).first();
  }

  return server || null;
}

__name(findServer, "findServer");

async function createMatch(env, player1, player2, server) {
  const matchId = generateMatchId();

  const now = Math.floor(Date.now() / 1e3);

  const mode = normalizeMode(player1.mode);

  await env.DB.batch([
    env.DB.prepare(`
      DELETE FROM queue
      WHERE
        uuid = ?
        AND mode = ?
    `).bind(
      player1.uuid,
      mode
    ),

    env.DB.prepare(`
      DELETE FROM queue
      WHERE
        uuid = ?
        AND mode = ?
    `).bind(
      player2.uuid,
      mode
    ),

    env.DB.prepare(`
      INSERT INTO matches (
        id,
        mode,
        region,
        player1_uuid,
        player1_username,
        player2_uuid,
        player2_username,
        player1_elo,
        player2_elo,
        server_id,
        status,
        winner_uuid,
        created_at,
        finished_at
      )
      VALUES (
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        'waiting',
        NULL,
        ?,
        NULL
      )
    `).bind(
      matchId,
      mode,
      server.region,
      player1.uuid,
      player1.username,
      player2.uuid,
      player2.username,
      Number(player1.elo),
      Number(player2.elo),
      server.id,
      now
    ),

    env.DB.prepare(`
      UPDATE servers
      SET
        reserved_players =
          reserved_players + 2
      WHERE id = ?
    `).bind(
      server.id
    )
  ]);

  return {
    id: matchId,
    mode,
    region: server.region,
    status: "waiting",

    server: {
      id: server.id,
      name: server.name,
      region: server.region,
      address: server.address,
      players: server.players,
      max_players: server.max_players
    },

    players: [
      {
        uuid: player1.uuid,
        username: player1.username,
        elo: Number(player1.elo)
      },
      {
        uuid: player2.uuid,
        username: player2.username,
        elo: Number(player2.elo)
      }
    ],

    winnerUuid: null,
    createdAt: now,
    finishedAt: null
  };
}

__name(createMatch, "createMatch");

async function getMatchByPlayer(env, uuid) {
  const now = Math.floor(Date.now() / 1e3);

  const minimumCreatedAt = now - MATCH_TIMEOUT;

  return await env.DB.prepare(`
    SELECT *
    FROM matches
    WHERE
      status = 'waiting'
      AND created_at >= ?
      AND (
        player1_uuid = ?
        OR player2_uuid = ?
      )
    ORDER BY created_at DESC
    LIMIT 1
  `).bind(
    minimumCreatedAt,
    uuid,
    uuid
  ).first();
}

__name(getMatchByPlayer, "getMatchByPlayer");

async function buildMatchResponse(env, match) {
  const server = await env.DB.prepare(`
    SELECT
      id,
      name,
      region,
      address,
      online,
      players,
      max_players,
      last_heartbeat
    FROM servers
    WHERE id = ?
  `).bind(
    match.server_id
  ).first();

  return {
    id: match.id,
    mode: match.mode,
    region: match.region,
    status: match.status,

    server: server
      ? {
          id: server.id,
          name: server.name,
          region: server.region,
          address: server.address,
          online: server.online,
          players: server.players,
          max_players: server.max_players
        }
      : null,

    players: [
      {
        uuid: match.player1_uuid,
        username: match.player1_username,
        elo: Number(match.player1_elo)
      },
      {
        uuid: match.player2_uuid,
        username: match.player2_username,
        elo: Number(match.player2_elo)
      }
    ],

    winnerUuid: match.winner_uuid,
    createdAt: match.created_at,
    finishedAt: match.finished_at
  };
}

__name(buildMatchResponse, "buildMatchResponse");

var index_default = {
  async fetch(request, env) {

    if (request.method === "OPTIONS") {
      return new Response(
        null,
        {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type"
          }
        }
      );
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      await cleanupStaleData(env);
    } catch (error) {
      console.error(
        "Cleanup error:",
        error
      );
    }

    if (method === "GET" && path === "/") {
      return json({
        success: true,
        name: "SpicyTiers Ranked API",
        version: "3.0.0",
        database: "D1",
        modes: MODES
      });
    }

    if (method === "GET" && path === "/health") {
      return json({
        success: true,
        message: "SpicyTiers API is online",
        version: "3.0.0",
        database: "D1"
      });
    }

    // =========================
    // PLAYER SYNC
    // =========================

    if (method === "POST" && path === "/player/sync") {
      try {
        const body = await request.json();

        const uuid = body.uuid;
        const username = body.username;

        if (
          !isValidUUID(uuid) ||
          !isValidUsername(username)
        ) {
          return json({
            success: false,
            error: "Invalid UUID or username"
          }, 400);
        }

        await ensurePlayer(
          env,
          uuid,
          username
        );

        const player = await env.DB.prepare(`
          SELECT
            uuid,
            username,
            created_at,
            updated_at
          FROM players
          WHERE uuid = ?
        `).bind(
          uuid
        ).first();

        return json({
          success: true,
          message: "Player synced",
          player
        });

      } catch (error) {
        console.error(error);

        return json({
          success: false,
          error: "Failed to sync player"
        }, 500);
      }
    }

    // =========================
    // GET PLAYER
    // =========================

    if (
      method === "GET" &&
      path.startsWith("/player/")
    ) {
      const uuid = path.replace(
        "/player/",
        ""
      );

      if (!isValidUUID(uuid)) {
        return json({
          success: false,
          error: "Invalid UUID"
        }, 400);
      }

      const player = await env.DB.prepare(`
        SELECT
          uuid,
          username,
          created_at,
          updated_at
        FROM players
        WHERE uuid = ?
      `).bind(
        uuid
      ).first();

      if (!player) {
        return json({
          success: false,
          error: "Player not found"
        }, 404);
      }

      const statsResult = await env.DB.prepare(`
        SELECT
          mode,
          elo,
          wins,
          losses,
          games_played
        FROM player_stats
        WHERE uuid = ?
      `).bind(
        uuid
      ).all();

      const modes = {};

      let totalElo = 0;

      for (const mode of MODES) {
        const stats = statsResult.results.find(
          (s) => s.mode === mode
        );

        const elo = stats
          ? Number(stats.elo)
          : 0;

        totalElo += elo;

        modes[mode] = {
          elo,
          tier: getTierFromElo(elo),
          wins: stats
            ? Number(stats.wins)
            : 0,
          losses: stats
            ? Number(stats.losses)
            : 0,
          games_played: stats
            ? Number(stats.games_played)
            : 0
        };
      }

      return json({
        success: true,
        player: {
          username: player.username,
          uuid: player.uuid,
          created_at: player.created_at,
          updated_at: player.updated_at,
          elo: totalElo,
          modes
        }
      });
    }

    // =========================
    // LEADERBOARD
    // =========================

    if (
      method === "GET" &&
      path.startsWith("/leaderboard/")
    ) {
      const mode = path.replace(
        "/leaderboard/",
        ""
      ).toLowerCase();

      if (mode === "overall") {
        const playersResult = await env.DB.prepare(`
          SELECT
            uuid,
            username
          FROM players
          ORDER BY username ASC
        `).all();

        const players2 = [];

        for (const player of playersResult.results) {
          const statsResult = await env.DB.prepare(`
            SELECT
              mode,
              elo
            FROM player_stats
            WHERE uuid = ?
          `).bind(
            player.uuid
          ).all();

          const modes = {};

          let totalElo = 0;

          for (const gameMode of MODES) {
            const stat = statsResult.results.find(
              (s) => s.mode === gameMode
            );

            const elo = stat
              ? Number(stat.elo)
              : 0;

            totalElo += elo;

            modes[gameMode] = {
              elo,
              tier: getTierFromElo(elo)
            };
          }

          players2.push({
            username: player.username,
            uuid: player.uuid,
            elo: totalElo,
            modes
          });
        }

        players2.sort(
          (a, b) => b.elo - a.elo
        );

        return json({
          success: true,
          mode: "overall",
          players: players2
        });
      }

      if (!validMode(mode)) {
        return json({
          success: false,
          error: "Invalid gamemode",
          mode
        }, 400);
      }

      const result = await env.DB.prepare(`
        SELECT
          p.uuid,
          p.username,
          s.elo
        FROM players p
        INNER JOIN player_stats s
          ON p.uuid = s.uuid
        WHERE s.mode = ?
        ORDER BY s.elo DESC
      `).bind(
        mode
      ).all();

      const players = result.results.map(
        (player) => {
          const elo = Number(player.elo);

          return {
            username: player.username,
            uuid: player.uuid,
            tier: getTierFromElo(elo),
            elo
          };
        }
      );

      return json({
        success: true,
        mode,
        players
      });
    }

    // =========================
    // QUEUE JOIN
    // =========================

    if (
      method === "POST" &&
      path === "/queue/join"
    ) {
      try {
        const body = await request.json();

        const uuid = body.uuid;
        const username = body.username;

        const mode = normalizeMode(
          body.mode
        );

        let region = normalizeRegion(
          body.region
        );

        if (!isValidUUID(uuid)) {
          return json({
            success: false,
            error: "Invalid UUID"
          }, 400);
        }

        if (!isValidUsername(username)) {
          return json({
            success: false,
            error: "Invalid username"
          }, 400);
        }

        if (!validMode(mode)) {
          return json({
            success: false,
            error: "Invalid gamemode"
          }, 400);
        }

        await ensurePlayer(
          env,
          uuid,
          username
        );

        const stats = await getPlayerStats(
          env,
          uuid,
          mode
        );

        const elo = stats
          ? Number(stats.elo)
          : DEFAULT_ELO;

        if (region === "auto") {
          const server2 = await findServer(
            env,
            "auto"
          );

          if (server2) {
            region = server2.region;
          }
        }

        const existing = await env.DB.prepare(`
          SELECT *
          FROM queue
          WHERE
            uuid = ?
            AND mode = ?
        `).bind(
          uuid,
          mode
        ).first();

        if (existing) {
          const now = Math.floor(
            Date.now() / 1e3
          );

          if (
            now -
            Number(existing.joined_at) <=
            QUEUE_TIMEOUT
          ) {
            return json({
              success: false,
              error: "Already in queue",
              queue: existing
            }, 409);
          }

          await env.DB.prepare(`
            DELETE FROM queue
            WHERE id = ?
          `).bind(
            existing.id
          ).run();
        }

        const joinedAt = Math.floor(
          Date.now() / 1e3
        );

        const queuePlayer = {
          uuid,
          username,
          mode,
          region,
          elo,
          joined_at: joinedAt
        };

        const opponent = await findMatch(
          env,
          queuePlayer
        );

        if (!opponent) {
          await env.DB.prepare(`
            INSERT INTO queue (
              uuid,
              username,
              mode,
              ranked,
              region,
              elo,
              joined_at
            )
            VALUES (
              ?,
              ?,
              ?,
              1,
              ?,
              ?,
              ?
            )
          `).bind(
            uuid,
            username,
            mode,
            region,
            elo,
            joinedAt
          ).run();

          return json({
            success: true,
            matched: false,
            queued: true,
            mode,
            region,
            elo
          });
        }

        let serverRegion = region;

        if (serverRegion === "auto") {
          serverRegion = opponent.region;
        }

        const server = await findServer(
          env,
          serverRegion
        );

        if (!server) {
          await env.DB.prepare(`
            INSERT INTO queue (
              uuid,
              username,
              mode,
              ranked,
              region,
              elo,
              joined_at
            )
            VALUES (
              ?,
              ?,
              ?,
              1,
              ?,
              ?,
              ?
            )
          `).bind(
            uuid,
            username,
            mode,
            region,
            elo,
            joinedAt
          ).run();

          return json({
            success: true,
            matched: false,
            queued: true,
            waiting_for_server: true,
            mode,
            region,
            elo
          });
        }

        const player1 = queuePlayer;

        const player2 = {
          uuid: opponent.uuid,
          username: opponent.username,
          mode: opponent.mode,
          region: opponent.region,
          elo: Number(opponent.elo),
          joined_at: opponent.joined_at
        };

        const match = await createMatch(
          env,
          player1,
          player2,
          server
        );

        return json({
          success: true,
          matched: true,
          queued: false,
          match
        });

      } catch (error) {
        console.error(error);

        return json({
          success: false,
          error: "Failed to join queue",
          details: error.message
        }, 500);
      }
    }

    // =========================
    // QUEUE STATUS
    // =========================

    if (
      method === "GET" &&
      path === "/queue/status"
    ) {
      const uuid = url.searchParams.get(
        "uuid"
      );

      const mode = normalizeMode(
        url.searchParams.get("mode")
      );

      if (
        !isValidUUID(uuid) ||
        !validMode(mode)
      ) {
        return json({
          success: false,
          error: "Invalid UUID or mode"
        }, 400);
      }

      const queue = await env.DB.prepare(`
        SELECT
          id,
          uuid,
          username,
          mode,
          ranked,
          region,
          elo,
          joined_at
        FROM queue
        WHERE
          uuid = ?
          AND mode = ?
      `).bind(
        uuid,
        mode
      ).first();

      return json({
        success: true,
        queued: !!queue,
        queue: queue || null
      });
    }

    // =========================
    // QUEUE LEAVE
    // =========================

    if (
      method === "POST" &&
      path === "/queue/leave"
    ) {
      try {
        const body = await request.json();

        const uuid = body.uuid;

        const mode = normalizeMode(
          body.mode
        );

        if (
          !isValidUUID(uuid) ||
          !validMode(mode)
        ) {
          return json({
            success: false,
            error: "Invalid UUID or mode"
          }, 400);
        }

        const result = await env.DB.prepare(`
          DELETE FROM queue
          WHERE
            uuid = ?
            AND mode = ?
        `).bind(
          uuid,
          mode
        ).run();

        return json({
          success: true,
          removed:
            Number(result.meta?.changes || 0) > 0
        });

      } catch (error) {
        return json({
          success: false,
          error: "Failed to leave queue"
        }, 500);
      }
    }

    // =========================
    // MATCH STATUS
    // =========================

    if (
      method === "GET" &&
      path === "/match/status"
    ) {
      const uuid = url.searchParams.get(
        "uuid"
      );

      if (!isValidUUID(uuid)) {
        return json({
          success: false,
          error: "Invalid UUID"
        }, 400);
      }

      const match = await getMatchByPlayer(
        env,
        uuid
      );

      if (!match) {
        return json({
          success: true,
          matched: false,
          match: null
        });
      }

      const response =
        await buildMatchResponse(
          env,
          match
        );

      return json({
        success: true,
        matched: true,
        match: response
      });
    }

    // =========================
    // SERVER HEARTBEAT
    // =========================

    if (
      method === "POST" &&
      path === "/server/heartbeat"
    ) {
      try {
        const body = await request.json();

        const serverId = Number(
          body.server_id
        );

        const apiKey = body.api_key;

        const players = Math.max(
          0,
          Number(body.players ?? 0)
        );

        if (!serverId || !apiKey) {
          return json({
            success: false,
            error:
              "server_id and api_key are required"
          }, 400);
        }

        const server = await env.DB.prepare(`
          SELECT
            id,
            name,
            region,
            address,
            api_key,
            max_players
          FROM servers
          WHERE id = ?
        `).bind(
          serverId
        ).first();

        if (!server) {
          return json({
            success: false,
            error: "Server not found"
          }, 404);
        }

        if (server.api_key !== apiKey) {
          return json({
            success: false,
            error: "Invalid server API key"
          }, 401);
        }

        const safePlayers = Math.min(
          players,
          Number(server.max_players)
        );

        const now = Math.floor(
          Date.now() / 1e3
        );

        await env.DB.prepare(`
          UPDATE servers
          SET
            online = 1,
            players = ?,
            last_heartbeat = ?
          WHERE id = ?
        `).bind(
          safePlayers,
          now,
          serverId
        ).run();

        return json({
          success: true,
          online: true,
          players: safePlayers,
          last_heartbeat: now
        });

      } catch (error) {
        console.error(error);

        return json({
          success: false,
          error: "Heartbeat failed"
        }, 500);
      }
    }

    // =========================
    // SERVER OFFLINE
    // =========================

    if (
      method === "POST" &&
      path === "/server/offline"
    ) {
      try {
        const body = await request.json();

        const serverId = Number(
          body.server_id
        );

        const apiKey = body.api_key;

        const server = await env.DB.prepare(`
          SELECT
            id,
            api_key
          FROM servers
          WHERE id = ?
        `).bind(
          serverId
        ).first();

        if (!server) {
          return json({
            success: false,
            error: "Server not found"
          }, 404);
        }

        if (server.api_key !== apiKey) {
          return json({
            success: false,
            error: "Invalid server API key"
          }, 401);
        }

        await env.DB.prepare(`
          UPDATE servers
          SET
            online = 0,
            players = 0,
            reserved_players = 0
          WHERE id = ?
        `).bind(
          serverId
        ).run();

        return json({
          success: true,
          online: false
        });

      } catch (error) {
        return json({
          success: false,
          error: "Failed to mark server offline"
        }, 500);
      }
    }

    // =========================
    // MATCH RESULT
    // =========================

    if (
      method === "POST" &&
      path === "/match/result"
    ) {
      try {
        const body = await request.json();

        const matchId = body.match_id;

        const serverId = Number(
          body.server_id
        );

        const apiKey = body.api_key;

        const winnerUuid =
          body.winner_uuid;

        if (
          !matchId ||
          !serverId ||
          !apiKey ||
          !winnerUuid
        ) {
          return json({
            success: false,
            error: "Missing result data"
          }, 400);
        }

        const server = await env.DB.prepare(`
          SELECT
            id,
            api_key
          FROM servers
          WHERE id = ?
        `).bind(
          serverId
        ).first();

        if (!server) {
          return json({
            success: false,
            error: "Server not found"
          }, 404);
        }

        if (server.api_key !== apiKey) {
          return json({
            success: false,
            error: "Invalid server API key"
          }, 401);
        }

        const match = await env.DB.prepare(`
          SELECT *
          FROM matches
          WHERE id = ?
        `).bind(
          matchId
        ).first();

        if (!match) {
          return json({
            success: false,
            error: "Match not found"
          }, 404);
        }

        if (match.status === "finished") {
          return json({
            success: true,
            already_finished: true,
            match_id: match.id,
            winner_uuid: match.winner_uuid
          });
        }

        if (
          Number(match.server_id) !==
          serverId
        ) {
          return json({
            success: false,
            error:
              "Match belongs to another server"
          }, 403);
        }

        const winnerIsP1 =
          match.player1_uuid === winnerUuid;

        const winnerIsP2 =
          match.player2_uuid === winnerUuid;

        if (!winnerIsP1 && !winnerIsP2) {
          return json({
            success: false,
            error: "Winner is not in match"
          }, 400);
        }

        const loserUuid =
          winnerIsP1
            ? match.player2_uuid
            : match.player1_uuid;

        const winnerOldElo =
          winnerIsP1
            ? Number(match.player1_elo)
            : Number(match.player2_elo);

        const loserOldElo =
          winnerIsP1
            ? Number(match.player2_elo)
            : Number(match.player1_elo);

        const winnerNewElo =
          winnerOldElo + ELO_CHANGE;

        const loserNewElo =
          Math.max(
            0,
            loserOldElo - ELO_CHANGE
          );

        const now = Math.floor(
          Date.now() / 1e3
        );

        const finishResult =
          await env.DB.prepare(`
            UPDATE matches
            SET
              status = 'finished',
              winner_uuid = ?,
              finished_at = ?
            WHERE
              id = ?
              AND status != 'finished'
          `).bind(
            winnerUuid,
            now,
            matchId
          ).run();

        const changes =
          Number(
            finishResult.meta?.changes || 0
          );

        if (changes === 0) {
          const finished =
            await env.DB.prepare(`
              SELECT
                id,
                status,
                winner_uuid
              FROM matches
              WHERE id = ?
            `).bind(
              matchId
            ).first();

          return json({
            success: true,
            already_finished: true,
            match_id: finished?.id,
            winner_uuid:
              finished?.winner_uuid
          });
        }

        await env.DB.batch([
          env.DB.prepare(`
            UPDATE player_stats
            SET
              elo = ?,
              wins = wins + 1,
              games_played =
                games_played + 1
            WHERE
              uuid = ?
              AND mode = ?
          `).bind(
            winnerNewElo,
            winnerUuid,
            match.mode
          ),

          env.DB.prepare(`
            UPDATE player_stats
            SET
              elo = ?,
              losses = losses + 1,
              games_played =
                games_played + 1
            WHERE
              uuid = ?
              AND mode = ?
          `).bind(
            loserNewElo,
            loserUuid,
            match.mode
          ),

          env.DB.prepare(`
            UPDATE servers
            SET
              reserved_players =
                MAX(
                  0,
                  reserved_players - 2
                )
            WHERE id = ?
          `).bind(
            serverId
          )
        ]);

        return json({
          success: true,
          match_id: matchId,
          mode: match.mode,
          winner_uuid: winnerUuid,
          loser_uuid: loserUuid,
          winner_elo_before: winnerOldElo,
          winner_elo_after: winnerNewElo,
          loser_elo_before: loserOldElo,
          loser_elo_after: loserNewElo,
          elo_change: ELO_CHANGE
        });

      } catch (error) {
        console.error(error);

        return json({
          success: false,
          error: "Failed to process match result",
          details: error.message
        }, 500);
      }
    }

    // =========================
    // GET KIT LAYOUT
    // =========================

    if (
      method === "GET" &&
      path === "/kit/layout"
    ) {
      const uuid = url.searchParams.get(
        "uuid"
      );

      const mode = normalizeMode(
        url.searchParams.get("mode")
      );

      if (
        !isValidUUID(uuid) ||
        !validMode(mode)
      ) {
        return json({
          success: false,
          error: "Invalid UUID or mode"
        }, 400);
      }

      const layout = await env.DB.prepare(`
        SELECT
          uuid,
          mode,
          layout,
          updated_at
        FROM kit_layouts
        WHERE
          uuid = ?
          AND mode = ?
      `).bind(
        uuid,
        mode
      ).first();

      return json({
        success: true,
        uuid,
        mode,
        layout: layout
          ? JSON.parse(layout.layout)
          : null,
        updated_at:
          layout
            ? layout.updated_at
            : null
      });
    }

    // =========================
    // SAVE KIT LAYOUT
    // =========================

    if (
      method === "POST" &&
      path === "/kit/layout"
    ) {
      try {
        const body = await request.json();

        const uuid = body.uuid;

        const mode = normalizeMode(
          body.mode
        );

        const layout = body.layout;

        if (
          !isValidUUID(uuid) ||
          !validMode(mode)
        ) {
          return json({
            success: false,
            error: "Invalid UUID or mode"
          }, 400);
        }

        if (
          !layout ||
          typeof layout !== "object"
        ) {
          return json({
            success: false,
            error: "Invalid layout"
          }, 400);
        }

        const cleanLayout = {};

        for (const key of Object.keys(layout)) {
          const slot = Number(key);

          if (
            !Number.isInteger(slot) ||
            slot < 0 ||
            slot > 40
          ) {
            continue;
          }

          const value = layout[key];

          if (typeof value === "string") {
            cleanLayout[String(slot)] = value;
          }
        }

        const now = Math.floor(
          Date.now() / 1e3
        );

        // IMPORTANT:
        // Only create the player if they don't exist.
        // This NEVER overwrites an existing username
        // with "Unknown".
        await env.DB.prepare(`
          INSERT OR IGNORE INTO players (
            uuid,
            username
          )
          VALUES (?, ?)
        `).bind(
          uuid,
          "Unknown"
        ).run();

        await env.DB.prepare(`
          INSERT INTO kit_layouts (
            uuid,
            mode,
            layout,
            updated_at
          )
          VALUES (
            ?,
            ?,
            ?,
            ?
          )
          ON CONFLICT(uuid, mode)
          DO UPDATE SET
            layout =
              excluded.layout,
            updated_at =
              excluded.updated_at
        `).bind(
          uuid,
          mode,
          JSON.stringify(cleanLayout),
          now
        ).run();

        return json({
          success: true,
          uuid,
          mode,
          layout: cleanLayout,
          updated_at: now
        });

      } catch (error) {
        console.error(error);

        return json({
          success: false,
          error: "Failed to save kit layout"
        }, 500);
      }
    }

    // =========================
    // NOT FOUND
    // =========================

    return json({
      success: false,
      error: "Endpoint not found",
      path
    }, 404);
  }
};

export {
  index_default as default
};

//# sourceMappingURL=index.js.map
