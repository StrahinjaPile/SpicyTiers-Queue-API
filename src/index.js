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

// Increased so players have more time to connect to the duel server.
const MATCH_TIMEOUT = 180;

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

  if (!server) {
    console.log(
      "[SERVER] No server available. Requested region:",
      region
    );

    // Diagnostic information.
    const allServers =
      await env.DB.prepare(`
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
        ORDER BY id ASC
      `)
        .all();

    console.log(
      "[SERVER] All servers:",
      allServers.results || []
    );
  }

  return server;
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


// =========================
// BUILD MATCH RESPONSE
// =========================

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
      JSON.stringify(player)
    );

    console.log(
      "[MATCH] Opponent:",
      JSON.stringify(opponent)
    );

    console.log(
      "[MATCH] Server:",
      JSON.stringify(server)
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

    if (!player.username) {
      throw new Error(
        "createMatch: player.username is missing"
      );
    }

    if (!opponent.username) {
      throw new Error(
        "createMatch: opponent.username is missing"
      );
    }

    if (!player.mode) {
      throw new Error(
        "createMatch: player.mode is missing"
      );
    }

    if (!opponent.mode) {
      throw new Error(
        "createMatch: opponent.mode is missing"
      );
    }

    if (
      player.mode !==
      opponent.mode
    ) {
      throw new Error(
        "createMatch: player/opponent modes differ: " +
        player.mode +
        " vs " +
        opponent.mode
      );
    }

    if (!server.id) {
      throw new Error(
        "createMatch: server.id is missing"
      );
    }

    if (!server.address) {
      throw new Error(
        "createMatch: server.address is missing"
      );
    }

    const matchId =
      generateMatchId();

    const now =
      Math.floor(
        Date.now() / 1000
      );

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
// TRY MATCH
// =========================
//
// IMPORTANT:
//
// This is the main fix.
//
// Previously:
//
// Player 1 -> queue
// Player 2 -> finds Player 1
// No server -> waiting_for_server
//
// Then /match/status only checked matches.
// It NEVER retried matchmaking.
//
// Now every /match/status request can retry:
// queue -> opponent -> server -> create match
//
// =========================

async function tryMatch(
  env,
  uuid
) {
  console.log(
    "[RETRY MATCH] ========================"
  );

  console.log(
    "[RETRY MATCH] Trying match for:",
    uuid
  );

  // -------------------------
  // Existing match
  // -------------------------

  const existingMatch =
    await getMatchByPlayer(
      env,
      uuid
    );

  if (existingMatch) {
    console.log(
      "[RETRY MATCH] Existing match:",
      existingMatch.id
    );

    return await buildMatchResponse(
      env,
      existingMatch
    );
  }

  // -------------------------
  // Get queue
  // -------------------------

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
    console.log(
      "[RETRY MATCH] Player is not queued."
    );

    return {
      success: true,
      matched: false,
      queued: false
    };
  }

  const now =
    Math.floor(Date.now() / 1000);

  if (
    Number(queue.joined_at) <
    now - QUEUE_TIMEOUT
  ) {
    console.log(
      "[RETRY MATCH] Queue entry expired."
    );

    await env.DB.prepare(`
      DELETE FROM queue
      WHERE id = ?
    `)
      .bind(
        queue.id
      )
      .run();

    return {
      success: true,
      matched: false,
      queued: false
    };
  }

  const mode =
    normalizeMode(
      queue.mode
    );

  const region =
    normalizeRegion(
      queue.region
    );

  const elo =
    Number(queue.elo);

  const player = {
    uuid: queue.uuid,
    username: queue.username,
    mode,
    ranked:
      Number(queue.ranked) !== 0,
    region,
    elo
  };

  console.log(
    "[RETRY MATCH] Queue player:",
    player
  );

  // -------------------------
  // Find opponent
  // -------------------------

  const opponent =
    await findMatch(
      env,
      uuid,
      mode,
      elo,
      region
    );

  if (!opponent) {
    console.log(
      "[RETRY MATCH] No opponent yet."
    );

    return {
      success: true,
      matched: false,
      queued: true,
      status: "searching",
      mode,
      elo,
      tier:
        getTierFromElo(elo),
      region
    };
  }

  console.log(
    "[RETRY MATCH] Opponent found:",
    opponent
  );

  // -------------------------
  // Find server
  // -------------------------

  const server =
    await findServer(
      env,
      region
    );

  if (!server) {
    console.log(
      "[RETRY MATCH] Opponent found but no server available."
    );

    return {
      success: true,
      matched: false,
      queued: true,
      status: "waiting_for_server",
      mode,
      elo,
      tier:
        getTierFromElo(elo),
      region,
      opponent: {
        uuid:
          opponent.uuid,
        username:
          opponent.username,
        elo:
          Number(opponent.elo)
      }
    };
  }

  console.log(
    "[RETRY MATCH] Server found:",
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
    "[RETRY MATCH] Match created:",
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

  return await buildMatchResponse(
    env,
    match
  );
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
        p.usernam
