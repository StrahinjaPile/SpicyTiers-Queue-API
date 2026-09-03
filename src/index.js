const MODES = [
  "sword",
  "axe",
  "mace",
  "pot",
  "uhc",
  "vanilla",
  "smp",
  "nethop"
];

const DEFAULT_ELO = 1000;

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json"
  };
}

function json(data, status = 200) {
  return new Response(
    JSON.stringify(data, null, 2),
    {
      status,
      headers: corsHeaders()
    }
  );
}

function normalizeMode(mode) {
  if (!mode || typeof mode !== "string") {
    return null;
  }

  return mode.toLowerCase().trim();
}

function normalizeRegion(region) {
  if (!region || typeof region !== "string") {
    return "auto";
  }

  return region.toLowerCase().trim();
}

function isValidUUID(uuid) {
  return typeof uuid === "string" && uuid.trim().length > 0;
}

function isValidUsername(username) {
  return (
    typeof username === "string" &&
    username.trim().length >= 1 &&
    username.trim().length <= 32
  );
}

function isValidElo(elo) {
  return Number.isInteger(elo) && elo >= 0;
}

function getEloRange(queueTime) {
  if (queueTime < 10) {
    return 100;
  }

  if (queueTime < 20) {
    return 200;
  }

  if (queueTime < 30) {
    return 300;
  }

  return 500;
}

function generateMatchId() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

  let result = "";

  for (let i = 0; i < 6; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }

  return `MATCH-${result}`;
}

async function findMatch(env, player) {
  const now = Math.floor(Date.now() / 1000);

  const candidates = await env.DB.prepare(`
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
    WHERE mode = ?
      AND region = ?
      AND uuid != ?
    ORDER BY joined_at ASC
  `).bind(
    player.mode,
    player.region,
    player.uuid
  ).all();

  const players = candidates.results || [];

  for (const candidate of players) {
    const candidateQueueTime = Math.max(
      0,
      now - candidate.joined_at
    );

    const playerQueueTime = Math.max(
      0,
      now - player.joined_at
    );

    const playerRange = getEloRange(playerQueueTime);
    const candidateRange = getEloRange(candidateQueueTime);

    const difference = Math.abs(
      Number(player.elo) - Number(candidate.elo)
    );

    const allowedRange = Math.max(
      playerRange,
      candidateRange
    );

    if (difference <= allowedRange) {
      return candidate;
    }
  }

  return null;
}

async function findServer(env, region) {
  const server = await env.DB.prepare(`
    SELECT
      id,
      name,
      region,
      address,
      online,
      players,
      max_players
    FROM servers
    WHERE region = ?
      AND online = 1
      AND players < max_players
    ORDER BY players ASC, id ASC
    LIMIT 1
  `).bind(region).first();

  return server;
}

async function createMatch(env, player1, player2, server) {
  let matchId = null;

  for (let attempt = 0; attempt < 5; attempt++) {
    const possibleId = generateMatchId();

    const existing = await env.DB.prepare(`
      SELECT id
      FROM matches
      WHERE id = ?
      LIMIT 1
    `).bind(possibleId).first();

    if (!existing) {
      matchId = possibleId;
      break;
    }
  }

  if (!matchId) {
    throw new Error("Could not generate unique match ID");
  }

  const createdAt = Math.floor(Date.now() / 1000);

  await env.DB.prepare(`
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
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    matchId,
    player1.mode,
    player1.region,
    player1.uuid,
    player1.username,
    player2.uuid,
    player2.username,
    player1.elo,
    player2.elo,
    server.id,
    "waiting",
    null,
    createdAt,
    null
  ).run();

  return matchId;
}

async function getMatchByPlayer(env, uuid) {
  const match = await env.DB.prepare(`
    SELECT
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
    FROM matches
    WHERE
      player1_uuid = ?
      OR player2_uuid = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).bind(uuid, uuid).first();

  if (!match) {
    return null;
  }

  let server = null;

  if (match.server_id !== null) {
    server = await env.DB.prepare(`
      SELECT
        id,
        name,
        region,
        address,
        online,
        players,
        max_players
      FROM servers
      WHERE id = ?
      LIMIT 1
    `).bind(match.server_id).first();
  }

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
        elo: match.player1_elo
      },
      {
        uuid: match.player2_uuid,
        username: match.player2_username,
        elo: match.player2_elo
      }
    ],

    winnerUuid: match.winner_uuid,
    createdAt: match.created_at,
    finishedAt: match.finished_at
  };
}

const index_default = {
  async fetch(request, env) {
    try {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: corsHeaders()
        });
      }

      const url = new URL(request.url);
      const path = url.pathname;

      // =========================================================
      // ROOT
      // =========================================================

      if (path === "/" && request.method === "GET") {
        return json({
          success: true,
          service: "SpicyTiers Ranked API",
          status: "online",
          version: "1.1.0"
        });
      }

      // =========================================================
      // SERVERS
      // =========================================================

      if (path === "/servers" && request.method === "GET") {
        try {
          if (!env.DB) {
            return json({
              success: false,
              error: "D1 database binding 'DB' is missing"
            }, 500);
          }

          const result = await env.DB.prepare(`
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
            ORDER BY region, name
          `).all();

          return json({
            success: true,
            servers: result.results || []
          });

        } catch (error) {
          console.error("SERVERS ERROR:", error);

          return json({
            success: false,
            error: "D1 query failed",
            details: error.message
          }, 500);
        }
      }

      // =========================================================
      // QUEUE JOIN
      // =========================================================

      if (path === "/queue/join" && request.method === "POST") {
        let body;

        try {
          body = await request.json();
        } catch {
          return json({
            success: false,
            error: "Invalid JSON body"
          }, 400);
        }

        const uuid = body.uuid?.trim();
        const username = body.username?.trim();
        const mode = normalizeMode(body.mode);
        const region = normalizeRegion(body.region);

        let elo = body.elo;

        if (elo === undefined || elo === null) {
          elo = DEFAULT_ELO;
        }

        // -----------------------------
        // Validation
        // -----------------------------

        if (!isValidUUID(uuid)) {
          return json({
            success: false,
            error: "Invalid uuid"
          }, 400);
        }

        if (!isValidUsername(username)) {
          return json({
            success: false,
            error: "Invalid username"
          }, 400);
        }

        if (!mode || !MODES.includes(mode)) {
          return json({
            success: false,
            error: "Invalid mode",
            validModes: MODES
          }, 400);
        }

        if (!isValidElo(elo)) {
          return json({
            success: false,
            error: "Invalid elo"
          }, 400);
        }

        // -----------------------------
        // Region
        // -----------------------------

        let selectedRegion = region;

        if (selectedRegion === "auto") {
          selectedRegion = "AU";
        } else {
          selectedRegion = selectedRegion.toUpperCase();
        }

        // -----------------------------
        // Check if already in queue
        // -----------------------------

        try {
          const existing = await env.DB.prepare(`
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
            WHERE uuid = ?
              AND mode = ?
            LIMIT 1
          `).bind(uuid, mode).first();

          if (existing) {
            return json({
              success: false,
              error: "Already in queue",
              queue: existing
            }, 409);
          }

        } catch (error) {
          console.error("QUEUE CHECK ERROR:", error);

          return json({
            success: false,
            error: "D1 query failed",
            details: error.message
          }, 500);
        }

        // -----------------------------
        // Check server
        // -----------------------------

        let server;

        try {
          server = await findServer(
            env,
            selectedRegion
          );

        } catch (error) {
          console.error("SERVER CHECK ERROR:", error);

          return json({
            success: false,
            error: "D1 query failed",
            details: error.message
          }, 500);
        }

        if (!server) {
          return json({
            success: false,
            error: "No available server for this region",
            region: selectedRegion
          }, 503);
        }

        // -----------------------------
        // Insert into queue
        // -----------------------------

        const joinedAt = Math.floor(Date.now() / 1000);

        try {
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
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).bind(
            uuid,
            username,
            mode,
            1,
            selectedRegion,
            elo,
            joinedAt
          ).run();

        } catch (error) {
          console.error("QUEUE INSERT ERROR:", error);

          return json({
            success: false,
            error: "Failed to join queue",
            details: error.message
          }, 500);
        }

        // -----------------------------
        // Get our queue entry
        // -----------------------------

        let queueEntry;

        try {
          queueEntry = await env.DB.prepare(`
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
            WHERE uuid = ?
              AND mode = ?
            LIMIT 1
          `).bind(uuid, mode).first();

        } catch (error) {
          console.error("QUEUE FETCH ERROR:", error);

          return json({
            success: false,
            error: "Failed to fetch queue entry",
            details: error.message
          }, 500);
        }

        // =========================================================
        // MATCHMAKING
        // =========================================================

        try {
          const opponent = await findMatch(
            env,
            queueEntry
          );

          // No opponent yet
          if (!opponent) {
            return json({
              success: true,
              matched: false,
              message: "Joined ranked queue",

              queue: queueEntry,

              region: selectedRegion,

              server: {
                id: server.id,
                name: server.name,
                region: server.region,
                address: server.address
              }
            });
          }

          // -----------------------------
          // Make sure server still exists
          // -----------------------------

          const matchServer = await findServer(
            env,
            selectedRegion
          );

          if (!matchServer) {
            return json({
              success: true,
              matched: false,
              message: "Opponent found, waiting for server",
              queue: queueEntry,
              opponent: {
                uuid: opponent.uuid,
                username: opponent.username,
                elo: opponent.elo
              }
            });
          }

          // -----------------------------
          // Create match
          // -----------------------------

          const matchId = await createMatch(
            env,
            queueEntry,
            opponent,
            matchServer
          );

          // -----------------------------
          // Remove both from queue
          // -----------------------------

          await env.DB.prepare(`
            DELETE FROM queue
            WHERE
              uuid = ?
              AND mode = ?
          `).bind(
            queueEntry.uuid,
            queueEntry.mode
          ).run();

          await env.DB.prepare(`
            DELETE FROM queue
            WHERE
              uuid = ?
              AND mode = ?
          `).bind(
            opponent.uuid,
            opponent.mode
          ).run();

          // -----------------------------
          // Get complete match
          // -----------------------------

          const match = await getMatchByPlayer(
            env,
            uuid
          );

          return json({
            success: true,
            matched: true,
            match
          });

        } catch (error) {
          console.error("MATCHMAKING ERROR:", error);

          return json({
            success: false,
            error: "Matchmaking failed",
            details: error.message
          }, 500);
        }
      }

      // =========================================================
      // QUEUE LEAVE
      // =========================================================

      if (path === "/queue/leave" && request.method === "POST") {
        let body;

        try {
          body = await request.json();
        } catch {
          return json({
            success: false,
            error: "Invalid JSON body"
          }, 400);
        }

        const uuid = body.uuid?.trim();
        const mode = normalizeMode(body.mode);

        if (!isValidUUID(uuid)) {
          return json({
            success: false,
            error: "Invalid uuid"
          }, 400);
        }

        if (!mode || !MODES.includes(mode)) {
          return json({
            success: false,
            error: "Invalid mode",
            validModes: MODES
          }, 400);
        }

        let existing;

        try {
          existing = await env.DB.prepare(`
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
            WHERE uuid = ?
              AND mode = ?
            LIMIT 1
          `).bind(uuid, mode).first();

        } catch (error) {
          console.error("QUEUE LEAVE CHECK ERROR:", error);

          return json({
            success: false,
            error: "D1 query failed",
            details: error.message
          }, 500);
        }

        if (!existing) {
          return json({
            success: false,
            error: "Player is not in queue"
          }, 404);
        }

        try {
          await env.DB.prepare(`
            DELETE FROM queue
            WHERE uuid = ?
              AND mode = ?
          `).bind(uuid, mode).run();

        } catch (error) {
          console.error("QUEUE DELETE ERROR:", error);

          return json({
            success: false,
            error: "Failed to leave queue",
            details: error.message
          }, 500);
        }

        return json({
          success: true,
          message: "Left ranked queue",
          queue: existing
        });
      }

      // =========================================================
      // QUEUE STATUS
      // =========================================================

      if (path === "/queue/status" && request.method === "GET") {
        const uuid = url.searchParams.get("uuid");

        const mode = normalizeMode(
          url.searchParams.get("mode")
        );

        if (!isValidUUID(uuid)) {
          return json({
            success: false,
            error: "Invalid uuid"
          }, 400);
        }

        if (!mode || !MODES.includes(mode)) {
          return json({
            success: false,
            error: "Invalid mode",
            validModes: MODES
          }, 400);
        }

        let queueEntry;

        try {
          queueEntry = await env.DB.prepare(`
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
            WHERE uuid = ?
              AND mode = ?
            LIMIT 1
          `).bind(uuid, mode).first();

        } catch (error) {
          console.error("QUEUE STATUS ERROR:", error);

          return json({
            success: false,
            error: "D1 query failed",
            details: error.message
          }, 500);
        }

        if (!queueEntry) {
          return json({
            success: true,
            inQueue: false,
            mode,
            uuid
          });
        }

        const now = Math.floor(Date.now() / 1000);

        const queueTime = Math.max(
          0,
          now - queueEntry.joined_at
        );

        return json({
          success: true,
          inQueue: true,
          mode,
          uuid,
          queueTime,
          eloRange: getEloRange(queueTime),
          queue: queueEntry
        });
      }

      // =========================================================
      // MATCH STATUS
      // =========================================================

      if (path === "/match/status" && request.method === "GET") {
        const uuid = url.searchParams.get("uuid");

        if (!isValidUUID(uuid)) {
          return json({
            success: false,
            error: "Invalid uuid"
          }, 400);
        }

        try {
          const match = await getMatchByPlayer(
            env,
            uuid
          );

          if (!match) {
            return json({
              success: true,
              matched: false,
              uuid
            });
          }

          return json({
            success: true,
            matched: true,
            match
          });

        } catch (error) {
          console.error("MATCH STATUS ERROR:", error);

          return json({
            success: false,
            error: "Failed to get match status",
            details: error.message
          }, 500);
        }
      }

      // =========================================================
      // 404
      // =========================================================

      return json({
        success: false,
        error: "Endpoint not found",
        path,
        method: request.method
      }, 404);

    } catch (error) {
      console.error("GLOBAL ERROR:", error);

      return json({
        success: false,
        error: "Internal server error",
        details: error.message
      }, 500);
    }
  }
};

export default index_default;
