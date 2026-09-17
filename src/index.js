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

const QUEUE_TIMEOUT = 300;
const MATCH_TIMEOUT = 60;
const HEARTBEAT_TIMEOUT = 15;

const ELO_CHANGE = 25;


// =========================
// HELPERS
// =========================

function json(data, status = 200) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers":
          "Content-Type, Authorization"
      }
    }
  );
}


function normalizeMode(mode) {
  return String(mode || "")
    .toLowerCase()
    .trim();
}


function validMode(mode) {
  return MODES.includes(
    normalizeMode(mode)
  );
}


function normalizeRegion(region) {
  if (!region) {
    return "auto";
  }

  return String(region)
    .toLowerCase()
    .trim();
}


function isValidUUID(uuid) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    uuid
  );
}


function isValidUsername(username) {
  return (
    typeof username === "string" &&
    username.length >= 1 &&
    username.length <= 16 &&
    /^[A-Za-z0-9_]+$/.test(username)
  );
}


function getTierFromElo(elo) {
  elo = Number(elo);

  if (elo >= 2250) return "HT1";
  if (elo >= 2000) return "LT1";
  if (elo >= 1900) return "HT2";
  if (elo >= 1800) return "LT2";
  if (elo >= 1650) return "HT3";
  if (elo >= 1500) return "LT3";
  if (elo >= 1300) return "HT4";
  if (elo >= 1200) return "LT4";
  if (elo >= 1100) return "HT5";
  if (elo >= 1000) return "LT5";

  return "UNRANKED";
}


function generateMatchId() {
  return crypto.randomUUID();
}


// =========================
// CLEANUP
// =========================

async function cleanupStaleData(env) {
  const now =
    Math.floor(Date.now() / 1000);

  await env.DB.prepare(`
    DELETE FROM queue
    WHERE joined_at < ?
  `)
    .bind(
      now - QUEUE_TIMEOUT
    )
    .run();

  await env.DB.prepare(`
    DELETE FROM matches
    WHERE status = 'waiting'
      AND created_at < ?
  `)
    .bind(
      now - MATCH_TIMEOUT
    )
    .run();
}


// =========================
// PLAYER
// =========================

async function getPlayerStats(
  env,
  uuid,
  mode
) {
  return await env.DB.prepare(`
    SELECT
      uuid,
      mode,
      elo,
      wins,
      losses,
      games_played
    FROM player_stats
    WHERE uuid = ?
      AND mode = ?
  `)
    .bind(
      uuid,
      mode
    )
    .first();
}


async function ensurePlayer(
  env,
  uuid,
  username
) {
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
  `)
    .bind(
      uuid,
      username
    )
    .run();

  for (const mode of MODES) {
    await env.DB.prepare(`
      INSERT OR IGNORE INTO player_stats (
        uuid,
        mode,
        elo,
        wins,
        losses,
        games_played
      )
      VALUES (?, ?, ?, 0, 0, 0)
    `)
      .bind(
        uuid,
        mode,
        DEFAULT_ELO
      )
      .run();
  }
}


// =========================
// MATCHMAKING
// =========================

async function findMatch(
  env,
  uuid,
  mode,
  elo,
  region
) {
  const now =
    Math.floor(Date.now() / 1000);

  console.log(
    "[MATCHMAKING] Searching opponent:",
    {
      uuid,
      mode,
      elo,
      region
    }
  );

  const candidates =
    await env.DB.prepare(`
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
        AND uuid != ?
        AND joined_at >= ?
      ORDER BY joined_at ASC
    `)
      .bind(
        mode,
        uuid,
        now - QUEUE_TIMEOUT
      )
      .all();

  console.log(
    "[MATCHMAKING] Candidates:",
    candidates.results?.length || 0
  );

  for (
    const candidate
    of candidates.results || []
  ) {
    const candidateRegion =
      normalizeRegion(
        candidate.region
      );

    if (
      region !== "auto" &&
      candidateRegion !== "auto" &&
      region !== candidateRegion
    ) {
      console.log(
        "[MATCHMAKING] Region mismatch:",
        region,
        candidateRegion
      );

      continue;
    }

    const waited =
      now -
      Number(candidate.joined_at);

    let allowedDifference = 100;

    if (waited >= 15) {
      allowedDifference = 200;
    }

    if (waited >= 30) {
      allowedDifference = 400;
    }

    if (waited >= 60) {
      allowedDifference = 600;
    }

    if (waited >= 120) {
      allowedDifference = 1000;
    }

    const eloDifference =
      Math.abs(
        Number(elo) -
        Number(candidate.elo)
      );

    console.log(
      "[MATCHMAKING] Candidate:",
      {
        uuid: candidate.uuid,
        username: candidate.username,
        elo: Number(candidate.elo),
        eloDifference,
        allowedDifference,
        waited
      }
    );

    if (
      eloDifference <=
      allowedDifference
    ) {
      console.log(
        "[MATCHMAKING] OPPONENT FOUND:",
        candidate.uuid
      );

      return candidate;
    }
  }

  console.log(
    "[MATCHMAKING] No opponent found."
  );

  return null;
}


// =========================
// SERVER
// =========================

async function findServer(
  env,
  region
) {
  const now =
    Math.floor(Date.now() / 1000);

  let query = `
    SELECT
      id,
      name,
      region,
      address,
      online,
      players,
      max_players,
      last_heartbeat,
      reserved_players
    FROM servers
    WHERE online = 1
      AND last_heartbeat >= ?
      AND (
        players +
        COALESCE(reserved_players, 0)
      ) < max_players
  `;

  const params = [
    now - HEARTBEAT_TIMEOUT
  ];

  if (
    region &&
    region !== "auto"
  ) {
    query += `
      AND region = ?
    `;

    params.push(region);
  }

  query += `
    ORDER BY players ASC
    LIMIT 1
  `;

  const server =
    await env.DB
      .prepare(query)
      .bind(...params)
      .first();

  console.log(
    "[SERVER] findServer:",
    server || "NONE"
  );

  return server;
}


// =========================
// CREATE MATCH
// =========================

async function createMatch(
  env,
  player,
  opponent,
  server
) {
  try {
    console.log(
      "[MATCH] ========================"
    );

    console.log(
      "[MATCH] Creating match..."
    );

    console.log(
      "[MATCH] Player:",
      player
    );

    console.log(
      "[MATCH] Opponent:",
      opponent
    );

    console.log(
      "[MATCH] Server:",
      server
    );

    if (!player) {
      throw new Error(
        "createMatch: player is missing"
      );
    }

    if (!opponent) {
      throw new Error(
        "createMatch: opponent is missing"
      );
    }

    if (!server) {
      throw new Error(
        "createMatch: server is missing"
      );
    }

    if (!player.uuid) {
      throw new Error(
        "createMatch: player.uuid is missing"
      );
    }

    if (!opponent.uuid) {
      throw new Error(
        "createMatch: opponent.uuid is missing"
      );
    }

    if (!player.mode) {
      throw new Error(
        "createMatch: player.mode is missing"
      );
    }

    if (!server.id) {
      throw new Error(
        "createMatch: server.id is missing"
      );
    }

    const matchId =
      generateMatchId();

    const now =
      Math.floor(Date.now() / 1000);

    const matchRegion =
      player.region !== "auto"
        ? player.region
        : opponent.region !== "auto"
          ? opponent.region
          : normalizeRegion(
              server.region
            );

    console.log(
      "[MATCH] Match ID:",
      matchId
    );

    console.log(
      "[MATCH] Region:",
      matchRegion
    );

    console.log(
      "[MATCH] Running atomic D1 batch..."
    );

    const statements = [

      // Remove player 1
      env.DB.prepare(`
        DELETE FROM queue
        WHERE uuid = ?
          AND mode = ?
      `)
        .bind(
          player.uuid,
          player.mode
        ),

      // Remove player 2
      env.DB.prepare(`
        DELETE FROM queue
        WHERE uuid = ?
          AND mode = ?
      `)
        .bind(
          opponent.uuid,
          opponent.mode
        ),

      // Create match
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
          created_at
        )
        VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting', ?
        )
      `)
        .bind(
          matchId,

          player.mode,

          matchRegion,

          player.uuid,
          player.username,

          opponent.uuid,
          opponent.username,

          Number(player.elo),
          Number(opponent.elo),

          Number(server.id),

          now
        ),

      // Reserve two server slots
      env.DB.prepare(`
        UPDATE servers
        SET reserved_players =
          COALESCE(reserved_players, 0) + 2
        WHERE id = ?
      `)
        .bind(
          Number(server.id)
        )
    ];

    const batchResult =
      await env.DB.batch(
        statements
      );

    console.log(
      "[MATCH] D1 batch successful:",
      batchResult
    );

    console.log(
      "[MATCH] Match created:",
      matchId
    );

    return matchId;

  } catch (error) {

    console.error(
      "[MATCH] ========================"
    );

    console.error(
      "[MATCH] createMatch FAILED"
    );

    console.error(
      "[MATCH] Error name:",
      error?.name
    );

    console.error(
      "[MATCH] Error message:",
      error?.message
    );

    console.error(
      "[MATCH] Error stack:",
      error?.stack
    );

    console.error(
      "[MATCH] Error:",
      error
    );

    throw error;
  }
}


// =========================
// GET MATCH
// =========================

async function getMatchByPlayer(
  env,
  uuid
) {
  const now =
    Math.floor(Date.now() / 1000);

  return await env.DB.prepare(`
    SELECT *
    FROM matches
    WHERE status = 'waiting'
      AND created_at >= ?
      AND (
        player1_uuid = ?
        OR player2_uuid = ?
      )
    ORDER BY created_at DESC
    LIMIT 1
  `)
    .bind(
      now - MATCH_TIMEOUT,
      uuid,
      uuid
    )
    .first();
}


async function buildMatchResponse(
  env,
  match
) {
  if (!match) {
    throw new Error(
      "buildMatchResponse: match is null"
    );
  }

  let server = null;

  if (match.server_id) {
    server =
      await env.DB.prepare(`
        SELECT
          id,
          name,
          region,
          address
        FROM servers
        WHERE id = ?
      `)
        .bind(
          Number(match.server_id)
        )
        .first();
  }

  console.log(
    "[MATCH] Building response:",
    {
      matchId: match.id,
      server
    }
  );

  return {
    success: true,
    matched: true,

    match: {
      id: match.id,

      mode: match.mode,

      region: match.region,

      player1: {
        uuid: match.player1_uuid,
        username: match.player1_username,
        elo: Number(
          match.player1_elo
        )
      },

      player2: {
        uuid: match.player2_uuid,
        username: match.player2_username,
        elo: Number(
          match.player2_elo
        )
      },

      status: match.status,

      created_at:
        match.created_at
    },

    server: server
      ? {
          id: server.id,
          name: server.name,
          region: server.region,
          address: server.address
        }
      : null
  };
}


// =========================
// LEADERBOARD
// =========================

async function getOverallLeaderboard(
  env
) {
  const response =
    await env.DB.prepare(`
      SELECT
        p.uuid,
        p.username,

        SUM(ps.elo) AS total_elo,

        SUM(ps.wins) AS wins,
        SUM(ps.losses) AS losses,
        SUM(ps.games_played) AS games_played

      FROM players p

      JOIN player_stats ps
        ON p.uuid = ps.uuid

      GROUP BY
        p.uuid,
        p.username

      ORDER BY total_elo DESC

      LIMIT 100
    `)
      .all();

  const players =
    response.results || [];

  if (
    players.length === 0
  ) {
    return [];
  }

  const placeholders =
    players
      .map(() => "?")
      .join(", ");

  const uuids =
    players.map(
      player => player.uuid
    );

  const statsResponse =
    await env.DB.prepare(`
      SELECT
        uuid,
        mode,
        elo
      FROM player_stats
      WHERE uuid IN (${placeholders})
    `)
      .bind(...uuids)
      .all();

  const statsByPlayer =
    new Map();

  for (
    const stat
    of statsResponse.results || []
  ) {
    if (
      !statsByPlayer.has(
        stat.uuid
      )
    ) {
      statsByPlayer.set(
        stat.uuid,
        {}
      );
    }

    statsByPlayer
      .get(stat.uuid)[stat.mode] = {
        elo: Number(stat.elo),

        tier:
          getTierFromElo(
            Number(stat.elo)
          )
      };
  }

  return players.map(
    (player, index) => {
      const playerModes =
        statsByPlayer.get(
          player.uuid
        ) || {};

      const tiers = {};

      for (
        const mode
        of MODES
      ) {
        const stats =
          playerModes[mode];

        tiers[mode] =
          stats
            ? {
                elo: stats.elo,
                tier: stats.tier
              }
            : {
                elo: DEFAULT_ELO,
                tier:
                  getTierFromElo(
                    DEFAULT_ELO
                  )
              };
      }

      const combinedElo =
        Number(
          player.total_elo
        );

      return {
        rank: index + 1,

        uuid:
          player.uuid,

        username:
          player.username,

        elo:
          combinedElo,

        combined_elo:
          combinedElo,

        wins:
          Number(player.wins),

        losses:
          Number(player.losses),

        games_played:
          Number(
            player.games_played
          ),

        tiers
      };
    }
  );
}


async function getModeLeaderboard(
  env,
  mode
) {
  const response =
    await env.DB.prepare(`
      SELECT
        p.uuid,
        p.username,

        ps.elo,
        ps.wins,
        ps.losses,
        ps.games_played

      FROM players p

      JOIN player_stats ps
        ON p.uuid = ps.uuid

      WHERE ps.mode = ?

      ORDER BY ps.elo DESC

      LIMIT 100
    `)
      .bind(mode)
      .all();

  return (
    response.results || []
  ).map(
    (player, index) => {
      const elo =
        Number(player.elo);

      return {
        rank:
          index + 1,

        uuid:
          player.uuid,

        username:
          player.username,

        elo,

        tier:
          getTierFromElo(elo),

        wins:
          Number(player.wins),

        losses:
          Number(player.losses),

        games_played:
          Number(
            player.games_played
          )
      };
    }
  );
}


// =========================
// FETCH
// =========================

export default {
  async fetch(
    request,
    env
  ) {
    try {

      // =========================
      // OPTIONS
      // =========================

      if (
        request.method ===
        "OPTIONS"
      ) {
        return new Response(
          null,
          {
            status: 204,

            headers: {
              "Access-Control-Allow-Origin":
                "*",

              "Access-Control-Allow-Methods":
                "GET, POST, OPTIONS",

              "Access-Control-Allow-Headers":
                "Content-Type, Authorization"
            }
          }
        );
      }


      const url =
        new URL(
          request.url
        );

      const path =
        url.pathname;


      // =========================
      // ROOT
      // =========================

      if (
        request.method === "GET" &&
        path === "/"
      ) {
        return json({
          success: true,

          name:
            "SpicyTiers Ranked API",

          version:
            "3.0.0",

          database:
            "D1",

          modes:
            MODES
        });
      }


      // =========================
      // HEALTH
      // =========================

      if (
        request.method === "GET" &&
        path === "/health"
      ) {
        return json({
          success: true,

          status:
            "ok",

          timestamp:
            Math.floor(
              Date.now() / 1000
            )
        });
      }


      // =========================
      // PLAYER SYNC
      // =========================

      if (
        request.method === "POST" &&
        path === "/player/sync"
      ) {
        const body =
          await request.json();

        const uuid =
          body.uuid;

        const username =
          body.username;

        if (
          !isValidUUID(uuid)
        ) {
          return json(
            {
              success: false,
              error:
                "Invalid UUID"
            },
            400
          );
        }

        if (
          !isValidUsername(
            username
          )
        ) {
          return json(
            {
              success: false,
              error:
                "Invalid username"
            },
            400
          );
        }

        await ensurePlayer(
          env,
          uuid,
          username
        );

        return json({
          success: true
        });
      }


      // =========================
      // GET PLAYER
      // =========================

      if (
        request.method === "GET" &&
        path.startsWith(
          "/player/"
        )
      ) {
        const uuid =
          path
            .substring(
              "/player/".length
            )
            .trim();

        if (
          !isValidUUID(uuid)
        ) {
          return json(
            {
              success: false,
              error:
                "Invalid UUID"
            },
            400
          );
        }

        const player =
          await env.DB.prepare(`
            SELECT
              uuid,
              username,
              created_at,
              updated_at
            FROM players
            WHERE uuid = ?
          `)
            .bind(uuid)
            .first();

        if (!player) {
          return json(
            {
              success: false,
              error:
                "Player not found"
            },
            404
          );
        }

        const stats =
          await env.DB.prepare(`
            SELECT
              mode,
              elo,
              wins,
              losses,
              games_played
            FROM player_stats
            WHERE uuid = ?
            ORDER BY elo DESC
          `)
            .bind(uuid)
            .all();

        return json({
          success: true,

          player,

          stats:
            stats.results || []
        });
      }


      // =========================
      // LEADERBOARD
      // =========================

      if (
        request.method === "GET" &&
        path.startsWith(
          "/leaderboard/"
        )
      ) {
        const mode =
          normalizeMode(
            path.substring(
              "/leaderboard/".length
            )
          );

        if (
          mode !== "overall" &&
          !validMode(mode)
        ) {
          return json(
            {
              success: false,
              error:
                "Invalid mode"
            },
            400
          );
        }

        if (
          mode === "overall"
        ) {
          const results =
            await getOverallLeaderboard(
              env
            );

          return json({
            success: true,

            mode:
              "overall",

            leaderboard:
              results
          });
        }

        const results =
          await getModeLeaderboard(
            env,
            mode
          );

        return json({
          success: true,

          mode,

          leaderboard:
            results
        });
      }


      // =========================
      // QUEUE JOIN
      // =========================

      if (
        request.method === "POST" &&
        path === "/queue/join"
      ) {

        try {

          console.log(
            "[QUEUE] ========================"
          );

          console.log(
            "[QUEUE] JOIN REQUEST"
          );

          await cleanupStaleData(
            env
          );

          const body =
            await request.json();

          console.log(
            "[QUEUE] Body:",
            body
          );

          const uuid =
            body.uuid;

          const username =
            body.username;

          const mode =
            normalizeMode(
              body.mode
            );

          const ranked =
            body.ranked !== false;

          const requestedRegion =
            normalizeRegion(
              body.region
            );

          if (
            !isValidUUID(uuid)
          ) {
            return json(
              {
                success: false,
                error:
                  "Invalid UUID"
              },
              400
            );
          }

          if (
            !isValidUsername(
              username
            )
          ) {
            return json(
              {
                success: false,
                error:
                  "Invalid username"
              },
              400
            );
          }

          if (
            !validMode(mode)
          ) {
            return json(
              {
                success: false,
                error:
                  "Invalid mode"
              },
              400
            );
          }

          console.log(
            "[QUEUE] Ensuring player..."
          );

          await ensurePlayer(
            env,
            uuid,
            username
          );

          console.log(
            "[QUEUE] Getting stats..."
          );

          const stats =
            await getPlayerStats(
              env,
              uuid,
              mode
            );

          if (!stats) {
            return json(
              {
                success: false,
                error:
                  "Player stats not found"
              },
              500
            );
          }

          console.log(
            "[QUEUE] Stats:",
            stats
          );

          let region =
            requestedRegion;

          // -------------------------
          // Auto region
          // -------------------------

          if (
            region === "auto"
          ) {
            console.log(
              "[QUEUE] Finding server for auto region..."
            );

            const autoServer =
              await findServer(
                env,
                "auto"
              );

            if (autoServer) {
              region =
                normalizeRegion(
                  autoServer.region
                );
            }

            console.log(
              "[QUEUE] Selected region:",
              region
            );
          }


          // -------------------------
          // Existing queue
          // -------------------------

          console.log(
            "[QUEUE] Checking existing queue..."
          );

          const existingQueue =
            await env.DB.prepare(`
              SELECT *
              FROM queue
              WHERE uuid = ?
                AND mode = ?
              LIMIT 1
            `)
              .bind(
                uuid,
                mode
              )
              .first();

          if (
            existingQueue
          ) {
            console.log(
              "[QUEUE] Player already queued."
            );

            return json({
              success: true,

              queued: true,

              matched: false,

              already_queued:
                true,

              mode,

              elo:
                Number(
                  stats.elo
                ),

              tier:
                getTierFromElo(
                  Number(stats.elo)
                ),

              region:
                existingQueue.region,

              queue_id:
                existingQueue.id
            });
          }


          // -------------------------
          // Existing match
          // -------------------------

          console.log(
            "[QUEUE] Checking existing match..."
          );

          const existingMatch =
            await getMatchByPlayer(
              env,
              uuid
            );

          if (
            existingMatch
          ) {
            console.log(
              "[QUEUE] Existing match found:",
              existingMatch.id
            );

            return await buildMatchResponse(
              env,
              existingMatch
            );
          }


          // -------------------------
          // Current player
          // -------------------------

          const player = {
            uuid,

            username,

            mode,

            ranked,

            region,

            elo:
              Number(
                stats.elo
              )
          };


          // -------------------------
          // Find opponent
          // -------------------------

          console.log(
            "[QUEUE] Searching for opponent..."
          );

          const opponent =
            await findMatch(
              env,
              uuid,
              mode,
              Number(stats.elo),
              region
            );


          // =========================
          // NO OPPONENT
          // =========================

          if (!opponent) {

            console.log(
              "[QUEUE] No opponent. Adding player to queue."
            );

            const now =
              Math.floor(
                Date.now() / 1000
              );

            const result =
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
              `)
                .bind(
                  uuid,
                  username,
                  mode,
                  ranked ? 1 : 0,
                  region,
                  Number(stats.elo),
                  now
                )
                .run();

            console.log(
              "[QUEUE] Player queued:",
              result
            );

            return json({
              success: true,

              queued: true,

              matched: false,

              status:
                "queued",

              mode,

              elo:
                Number(
                  stats.elo
                ),

              tier:
                getTierFromElo(
                  Number(stats.elo)
                ),

              region,

              queue_id:
                result.meta
                  .last_row_id
            });
          }


          // =========================
          // OPPONENT FOUND
          // =========================

          console.log(
            "[QUEUE] Opponent found:",
            opponent
          );

          // -------------------------
          // Find duel server
          // -------------------------

          console.log(
            "[QUEUE] Finding duel server..."
          );

          const server =
            await findServer(
              env,
              region
            );

          if (!server) {

            console.log(
              "[QUEUE] No available duel server."
            );

            const now =
              Math.floor(
                Date.now() / 1000
              );

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
            `)
              .bind(
                uuid,
                username,
                mode,
                ranked ? 1 : 0,
                region,
                Number(stats.elo),
                now
              )
              .run();

            return json({
              success: true,

              queued: true,

              matched: false,

              status:
                "waiting_for_server",

              mode,

              elo:
                Number(
                  stats.elo
                ),

              tier:
                getTierFromElo(
                  Number(stats.elo)
                ),

              region
            });
          }


          console.log(
            "[QUEUE] Duel server found:",
            server
          );


          // -------------------------
          // Create match
          // -------------------------

          const matchId =
            await createMatch(
              env,
              player,
              opponent,
              server
            );


          console.log(
            "[QUEUE] Match created:",
            matchId
          );


          // -------------------------
          // Load match
          // -------------------------

          const match =
            await env.DB.prepare(`
              SELECT *
              FROM matches
              WHERE id = ?
              LIMIT 1
            `)
              .bind(
                matchId
              )
              .first();

          if (!match) {
            throw new Error(
              "Match was created but could not be loaded afterwards: " +
              matchId
            );
          }


          console.log(
            "[QUEUE] Match loaded:",
            match
          );


          // -------------------------
          // Build response
          // -------------------------

          const response =
            await buildMatchResponse(
              env,
              match
            );

          console.log(
            "[QUEUE] MATCH SUCCESS:",
            response
          );

          return json(
            response
          );

        } catch (error) {

          console.error(
            "[QUEUE] ========================"
          );

          console.error(
            "[QUEUE] QUEUE JOIN FAILED"
          );

          console.error(
            "[QUEUE] Error name:",
            error?.name
          );

          console.error(
            "[QUEUE] Error message:",
            error?.message
          );

          console.error(
            "[QUEUE] Error stack:",
            error?.stack
          );

          console.error(
            "[QUEUE] Full error:",
            error
          );

          return json(
            {
              success: false,

              error:
                "Queue matchmaking failed",

              details:
                error?.message ||
                String(error)
            },
            500
          );
        }
      }


      // =========================
      // QUEUE STATUS
      // =========================

      if (
        request.method === "GET" &&
        path === "/queue/status"
      ) {
        const uuid =
          url.searchParams.get(
            "uuid"
          );

        if (
          !isValidUUID(uuid)
        ) {
          return json(
            {
              success: false,
              error:
                "Invalid UUID"
            },
            400
          );
        }

        const queue =
          await env.DB.prepare(`
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
            ORDER BY joined_at DESC
            LIMIT 1
          `)
            .bind(uuid)
            .first();

        if (!queue) {
          return json({
            success: true,
            queued: false
          });
        }

        const now =
          Math.floor(
            Date.now() / 1000
          );

        return json({
          success: true,

          queued: true,

          queue: {
            ...queue,

            wait_time:
              Math.max(
                0,

                now -
                Number(
                  queue.joined_at
                )
              )
          }
        });
      }


      // =========================
      // QUEUE LEAVE
      // =========================

      if (
        request.method === "POST" &&
        path === "/queue/leave"
      ) {
        const body =
          await request.json();

        const uuid =
          body.uuid;

        const mode =
          normalizeMode(
            body.mode
          );

        if (
          !isValidUUID(uuid)
        ) {
          return json(
            {
              success: false,
              error:
                "Invalid UUID"
            },
            400
          );
        }

        if (
          mode &&
          !validMode(mode)
        ) {
          return json(
            {
              success: false,
              error:
                "Invalid mode"
            },
            400
          );
        }

        let result;

        if (mode) {
          result =
            await env.DB.prepare(`
              DELETE FROM queue
              WHERE uuid = ?
                AND mode = ?
            `)
              .bind(
                uuid,
                mode
              )
              .run();
        } else {
          result =
            await env.DB.prepare(`
              DELETE FROM queue
              WHERE uuid = ?
            `)
              .bind(
                uuid
              )
              .run();
        }

        return json({
          success: true,

          removed:
            result.meta.changes ||
            0
        });
      }


      // =========================
      // MATCH STATUS
      // =========================

      if (
        request.method === "GET" &&
        path === "/match/status"
      ) {
        const uuid =
          url.searchParams.get(
            "uuid"
          );

        if (
          !isValidUUID(uuid)
        ) {
          return json(
            {
              success: false,
              error:
                "Invalid UUID"
            },
            400
          );
        }

        const match =
          await getMatchByPlayer(
            env,
            uuid
          );

        if (!match) {
          return json({
            success: true,

            matched: false
          });
        }

        return json(
          await buildMatchResponse(
            env,
            match
          )
        );
      }


      // =========================
      // SERVER HEARTBEAT
      // =========================

      if (
        request.method === "POST" &&
        path === "/server/heartbeat"
      ) {
        const body =
          await request.json();

        const name =
          body.name;

        const region =
          normalizeRegion(
            body.region
          );

        const address =
          body.address;

        const online =
          body.online !== false;

        const players =
          Number(
            body.players || 0
          );

        const maxPlayers =
          Number(
            body.max_players ||
            100
          );

        const apiKey =
          body.api_key ||
          null;

        if (
          typeof name !== "string" ||
          !name.trim()
        ) {
          return json(
            {
              success: false,
              error:
                "Invalid server name"
            },
            400
          );
        }

        if (
          typeof address !== "string" ||
          !address.trim()
        ) {
          return json(
            {
              success: false,
              error:
                "Invalid server address"
            },
            400
          );
        }

        const now =
          Math.floor(
            Date.now() / 1000
          );

        const existing =
          await env.DB.prepare(`
            SELECT id
            FROM servers
            WHERE name = ?
            LIMIT 1
          `)
            .bind(name)
            .first();

        if (existing) {

          await env.DB.prepare(`
            UPDATE servers
            SET
              region = ?,
              address = ?,
              online = ?,
              players = ?,
              max_players = ?,
              last_heartbeat = ?,
              api_key = ?
            WHERE id = ?
          `)
            .bind(
              region,

              address,

              online ? 1 : 0,

              players,

              maxPlayers,

              now,

              apiKey,

              existing.id
            )
            .run();

          return json({
            success: true,

            server_id:
              existing.id
          });
        }

        const result =
          await env.DB.prepare(`
            INSERT INTO servers (
              name,
              region,
              address,
              online,
              players,
              max_players,
              last_heartbeat,
              api_key,
              reserved_players
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
          `)
            .bind(
              name,

              region,

              address,

              online ? 1 : 0,

              players,

              maxPlayers,

              now,

              apiKey
            )
            .run();

        return json({
          success: true,

          server_id:
            result.meta.last_row_id
        });
      }


      // =========================
      // SERVER OFFLINE
      // =========================

      if (
        request.method === "POST" &&
        path === "/server/offline"
      ) {
        const body =
          await request.json();

        const name =
          body.name;

        if (
          typeof name !== "string" ||
          !name.trim()
        ) {
          return json(
            {
              success: false,
              error:
                "Invalid server name"
            },
            400
          );
        }

        await env.DB.prepare(`
          UPDATE servers
          SET online = 0
          WHERE name = ?
        `)
          .bind(name)
          .run();

        return json({
          success: true
        });
      }


      // =========================
      // MATCH RESULT
      // =========================

      if (
        request.method === "POST" &&
        path === "/match/result"
      ) {
        const body =
          await request.json();

        const matchId =
          body.match_id;

        const winnerUUID =
          body.winner_uuid;

        const serverId =
          Number(
            body.server_id
          );

        const apiKey =
          body.api_key;

        if (
          typeof matchId !==
            "string" ||
          !matchId
        ) {
          return json(
            {
              success: false,
              error:
                "Invalid match_id"
            },
            400
          );
        }

        if (
          !isValidUUID(
            winnerUUID
          )
        ) {
          return json(
            {
              success: false,
              error:
                "Invalid winner UUID"
            },
            400
          );
        }

        if (!serverId) {
          return json(
            {
              success: false,
              error:
                "Invalid server_id"
            },
            400
          );
        }

        const server =
          await env.DB.prepare(`
            SELECT *
            FROM servers
            WHERE id = ?
          `)
            .bind(
              serverId
            )
            .first();

        if (!server) {
          return json(
            {
              success: false,
              error:
                "Server not found"
            },
            404
          );
        }

        if (
          server.api_key &&
          server.api_key !== apiKey
        ) {
          return json(
            {
              success: false,
              error:
                "Invalid API key"
            },
            403
          );
        }

        const match =
          await env.DB.prepare(`
            SELECT *
            FROM matches
            WHERE id = ?
          `)
            .bind(
              matchId
            )
            .first();

        if (!match) {
          return json(
            {
              success: false,
              error:
                "Match not found"
            },
            404
          );
        }

        if (
          Number(
            match.server_id
          ) !== serverId
        ) {
          return json(
            {
              success: false,
              error:
                "Invalid server for match"
            },
            403
          );
        }

        if (
          match.status !==
          "waiting"
        ) {
          return json(
            {
              success: false,
              error:
                "Match already finished"
            },
            400
          );
        }

        const isPlayer1 =
          match.player1_uuid ===
          winnerUUID;

        const isPlayer2 =
          match.player2_uuid ===
          winnerUUID;

        if (
          !isPlayer1 &&
          !isPlayer2
        ) {
          return json(
            {
              success: false,
              error:
                "Winner is not in match"
            },
            400
          );
        }

        const loserUUID =
          isPlayer1
            ? match.player2_uuid
            : match.player1_uuid;

        const winnerMode =
          match.mode;

        const winnerStats =
          await getPlayerStats(
            env,
            winnerUUID,
            winnerMode
          );

        const loserStats =
          await getPlayerStats(
            env,
            loserUUID,
            winnerMode
          );

        if (
          !winnerStats ||
          !loserStats
        ) {
          return json(
            {
              success: false,
              error:
                "Player stats not found"
            },
            500
          );
        }

        const winnerOldElo =
          Number(
            winnerStats.elo
          );

        const loserOldElo =
          Number(
            loserStats.elo
          );

        const winnerNewElo =
          winnerOldElo +
          ELO_CHANGE;

        const loserNewElo =
          Math.max(
            0,

            loserOldElo -
            ELO_CHANGE
          );

        const now =
          Math.floor(
            Date.now() / 1000
          );

        await env.DB.prepare(`
          UPDATE matches
          SET
            status = 'finished',
            winner_uuid = ?,
            finished_at = ?
          WHERE id = ?
        `)
          .bind(
            winnerUUID,

            now,

            matchId
          )
          .run();

        await env.DB.prepare(`
          UPDATE player_stats
          SET
            elo = ?,
            wins = wins + 1,
            games_played =
              games_played + 1
          WHERE uuid = ?
            AND mode = ?
        `)
          .bind(
            winnerNewElo,

            winnerUUID,

            winnerMode
          )
          .run();

        await env.DB.prepare(`
          UPDATE player_stats
          SET
            elo = ?,
            losses = losses + 1,
            games_played =
              games_played + 1
          WHERE uuid = ?
            AND mode = ?
        `)
          .bind(
            loserNewElo,

            loserUUID,

            winnerMode
          )
          .run();

        await env.DB.prepare(`
          UPDATE servers
          SET reserved_players =
            MAX(
              0,
              COALESCE(
                reserved_players,
                0
              ) - 2
            )
          WHERE id = ?
        `)
          .bind(
            serverId
          )
          .run();

        return json({
          success: true,

          match_id:
            matchId,

          winner: {
            uuid:
              winnerUUID,

            old_elo:
              winnerOldElo,

            new_elo:
              winnerNewElo,

            elo_change:
              ELO_CHANGE,

            tier:
              getTierFromElo(
                winnerNewElo
              )
          },

          loser: {
            uuid:
              loserUUID,

            old_elo:
              loserOldElo,

            new_elo:
              loserNewElo,

            elo_change:
              -ELO_CHANGE,

            tier:
              getTierFromElo(
                loserNewElo
              )
          }
        });
      }


      // =========================
      // KIT LAYOUT GET
      // =========================

      if (
        request.method === "GET" &&
        path === "/kit/layout"
      ) {
        const uuid =
          url.searchParams.get(
            "uuid"
          );

        const mode =
          normalizeMode(
            url.searchParams.get(
              "mode"
            )
          );

        if (
          !isValidUUID(uuid)
        ) {
          return json(
            {
              success: false,
              error:
                "Invalid UUID"
            },
            400
          );
        }

        if (
          !validMode(mode)
        ) {
          return json(
            {
              success: false,
              error:
                "Invalid mode"
            },
            400
          );
        }

        const layout =
          await env.DB.prepare(`
            SELECT
              uuid,
              mode,
              layout,
              updated_at
            FROM kit_layouts
            WHERE uuid = ?
              AND mode = ?
          `)
            .bind(
              uuid,
              mode
            )
            .first();

        if (!layout) {
          return json({
            success: true,

            found: false,

            layout: null
          });
        }

        let parsedLayout;

        try {
          parsedLayout =
            JSON.parse(
              layout.layout
            );
        } catch {
          parsedLayout = null;
        }

        return json({
          success: true,

          found: true,

          layout:
            parsedLayout,

          updated_at:
            layout.updated_at
        });
      }


      // =========================
      // KIT LAYOUT POST
      // =========================

      if (
        request.method === "POST" &&
        path === "/kit/layout"
      ) {
        const body =
          await request.json();

        const uuid =
          body.uuid;

        const mode =
          normalizeMode(
            body.mode
          );

        const layout =
          body.layout;

        if (
          !isValidUUID(uuid)
        ) {
          return json(
            {
              success: false,
              error:
                "Invalid UUID"
            },
            400
          );
        }

        if (
          !validMode(mode)
        ) {
          return json(
            {
              success: false,
              error:
                "Invalid mode"
            },
            400
          );
        }

        if (
          !layout ||
          typeof layout !==
            "object" ||
          Array.isArray(layout)
        ) {
          return json(
            {
              success: false,
              error:
                "Invalid layout"
            },
            400
          );
        }

        const entries =
          Object.entries(
            layout
          );

        for (
          const [slot, item]
          of entries
        ) {
          const slotNumber =
            Number(slot);

          if (
            !Number.isInteger(
              slotNumber
            ) ||
            slotNumber < 0 ||
            slotNumber > 40
          ) {
            return json(
              {
                success: false,

                error:
                  "Invalid slot: " +
                  slot
              },
              400
            );
          }

          if (
            typeof item !==
            "string"
          ) {
            return json(
              {
                success: false,

                error:
                  "Invalid item at slot " +
                  slot
              },
              400
            );
          }
        }

        await env.DB.prepare(`
          INSERT OR IGNORE INTO players (
            uuid,
            username
          )
          VALUES (?, ?)
        `)
          .bind(
            uuid,
            "Unknown"
          )
          .run();

        const now =
          Math.floor(
            Date.now() / 1000
          );

        await env.DB.prepare(`
          INSERT INTO kit_layouts (
            uuid,
            mode,
            layout,
            updated_at
          )
          VALUES (?, ?, ?, ?)

          ON CONFLICT(uuid, mode)
          DO UPDATE SET
            layout =
              excluded.layout,

            updated_at =
              excluded.updated_at
        `)
          .bind(
            uuid,

            mode,

            JSON.stringify(
              layout
            ),

            now
          )
          .run();

        return json({
          success: true,

          saved: true,

          uuid,

          mode,

          updated_at:
            now
        });
      }


      // =========================
      // 404
      // =========================

      return json(
        {
          success: false,
          error:
            "Not found"
        },
        404
      );

    } catch (error) {

      // =========================
      // GLOBAL ERROR
      // =========================

      console.error(
        "[SpicyTiers API] ========================"
      );

      console.error(
        "[SpicyTiers API] UNHANDLED ERROR"
      );

      console.error(
        "[SpicyTiers API] name:",
        error?.name
      );

      console.error(
        "[SpicyTiers API] message:",
        error?.message
      );

      console.error(
        "[SpicyTiers API] stack:",
        error?.stack
      );

      console.error(
        "[SpicyTiers API] error:",
        error
      );

      let details =
        "Unknown error";

      try {
        details =
          error?.message ||
          String(error);
      } catch {
        details =
          "Failed to read error";
      }

      return json(
        {
          success: false,

          error:
            "Internal server error",

          details
        },
        500
      );
    }
  }
};
