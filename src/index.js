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
const HEARTBEAT_TIMEOUT = 20;

const ELO_K = 32;

function json(data, status = 200) {
    return new Response(
        JSON.stringify(data, null, 2),
        {
            status,
            headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type, X-Server-Key"
            }
        }
    );
}

function normalizeMode(mode) {
    return String(mode || "").trim().toLowerCase();
}

function validMode(mode) {
    return MODES.includes(normalizeMode(mode));
}

function normalizeRegion(region) {
    return String(region || "auto").trim().toUpperCase();
}

function validUUID(uuid) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        String(uuid || "")
    );
}

function validUsername(username) {
    return /^[A-Za-z0-9_]{1,16}$/.test(
        String(username || "")
    );
}

function now() {
    return Math.floor(Date.now() / 1000);
}

function generateMatchId() {
    const chars =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

    let result = "MATCH-";

    for (let i = 0; i < 6; i++) {
        result +=
            chars[Math.floor(Math.random() * chars.length)];
    }

    return result;
}

/*
==================================================
ELO
==================================================
*/

function expectedScore(playerElo, opponentElo) {

    return 1 /
        (
            1 +
            Math.pow(
                10,
                (opponentElo - playerElo) / 400
            )
        );

}

function calculateElo(playerElo, opponentElo, won) {

    const expected =
        expectedScore(
            playerElo,
            opponentElo
        );

    const actual =
        won ? 1 : 0;

    const change =
        Math.round(
            ELO_K *
            (actual - expected)
        );

    return Math.max(
        0,
        playerElo + change
    );

}

function getEloChange(
    playerElo,
    opponentElo,
    won
) {

    const newElo =
        calculateElo(
            playerElo,
            opponentElo,
            won
        );

    return newElo - playerElo;

}

/*
==================================================
TIER
==================================================
*/

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

/*
==================================================
CORS
==================================================
*/

function corsResponse() {

    return new Response(
        null,
        {
            status: 204,
            headers: {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods":
                    "GET, POST, OPTIONS",
                "Access-Control-Allow-Headers":
                    "Content-Type, X-Server-Key"
            }
        }
    );

}

/*
==================================================
PLAYER
==================================================
*/

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
            updated_at = CURRENT_TIMESTAMP
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

/*
==================================================
CLEANUP
==================================================
*/

async function cleanupStaleData(env) {

    const timestamp = now();

    await env.DB.prepare(`
        DELETE FROM queue
        WHERE joined_at < ?
    `)
    .bind(
        timestamp - QUEUE_TIMEOUT
    )
    .run();

    await env.DB.prepare(`
        DELETE FROM matches
        WHERE status = 'waiting'
        AND created_at < ?
    `)
    .bind(
        timestamp - MATCH_TIMEOUT
    )
    .run();

}

/*
==================================================
GET PLAYER ELO
==================================================
*/

async function getPlayerElo(
    env,
    uuid,
    mode
) {

    const result =
        await env.DB.prepare(`
            SELECT elo
            FROM player_stats
            WHERE uuid = ?
            AND mode = ?
        `)
        .bind(
            uuid,
            mode
        )
        .first();

    if (!result) {

        return DEFAULT_ELO;

    }

    return Number(
        result.elo
    ) || DEFAULT_ELO;

}

/*
==================================================
FIND SERVER
==================================================
*/

async function findServer(
    env,
    region
) {

    const timestamp = now();

    let server =
        await env.DB.prepare(`
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

            WHERE region = ?
            AND online = 1
            AND players < max_players
            AND last_heartbeat >= ?

            ORDER BY players ASC

            LIMIT 1
        `)
        .bind(
            region,
            timestamp - HEARTBEAT_TIMEOUT
        )
        .first();

    if (!server) {

        server =
            await env.DB.prepare(`
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

                WHERE online = 1
                AND players < max_players
                AND last_heartbeat >= ?

                ORDER BY players ASC

                LIMIT 1
            `)
            .bind(
                timestamp - HEARTBEAT_TIMEOUT
            )
            .first();

    }

    return server;

}

/*
==================================================
FIND MATCH
==================================================
*/

async function findMatch(
    env,
    player
) {

    const opponent =
        await env.DB.prepare(`
            SELECT *
            FROM queue

            WHERE mode = ?
            AND uuid != ?
            AND joined_at >= ?

            ORDER BY
                ABS(elo - ?) ASC,
                joined_at ASC

            LIMIT 1
        `)
        .bind(
            player.mode,
            player.uuid,
            now() - QUEUE_TIMEOUT,
            player.elo
        )
        .first();

    return opponent;

}

/*
==================================================
CREATE MATCH
==================================================
*/

async function createMatch(
    env,
    player1,
    player2,
    server
) {

    const matchId =
        generateMatchId();

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
    `)
    .bind(
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

        now()
    )
    .run();

    await env.DB.prepare(`
        DELETE FROM queue
        WHERE uuid = ?
        AND mode = ?
    `)
    .bind(
        player1.uuid,
        player1.mode
    )
    .run();

    await env.DB.prepare(`
        DELETE FROM queue
        WHERE uuid = ?
        AND mode = ?
    `)
    .bind(
        player2.uuid,
        player2.mode
    )
    .run();

    await env.DB.prepare(`
        UPDATE servers
        SET players = players + 2
        WHERE id = ?
    `)
    .bind(
        server.id
    )
    .run();

    return matchId;

}

/*
==================================================
MATCH STATUS
==================================================
*/

async function getMatchForPlayer(
    env,
    uuid
) {

    return await env.DB.prepare(`
        SELECT
            m.*,

            s.name AS server_name,
            s.region AS server_region,
            s.address AS server_address,
            s.online AS server_online,
            s.players AS server_players,
            s.max_players AS server_max_players

        FROM matches m

        LEFT JOIN servers s
            ON s.id = m.server_id

        WHERE
            (
                m.player1_uuid = ?
                OR
                m.player2_uuid = ?
            )

        AND m.status = 'waiting'

        ORDER BY m.created_at DESC

        LIMIT 1
    `)
    .bind(
        uuid,
        uuid
    )
    .first();

}

/*
==================================================
FINISH MATCH
==================================================
*/

async function finishMatch(
    env,
    match,
    winnerUuid
) {

    if (
        match.status !== "waiting"
    ) {

        return {
            success: false,
            error: "Match already finished"
        };

    }

    const loserUuid =
        match.player1_uuid === winnerUuid
            ? match.player2_uuid
            : match.player1_uuid;

    if (
        winnerUuid !== match.player1_uuid &&
        winnerUuid !== match.player2_uuid
    ) {

        return {
            success: false,
            error: "Winner is not part of match"
        };

    }

    const winnerElo =
        winnerUuid === match.player1_uuid
            ? Number(match.player1_elo)
            : Number(match.player2_elo);

    const loserElo =
        loserUuid === match.player1_uuid
            ? Number(match.player1_elo)
            : Number(match.player2_elo);

    const winnerChange =
        getEloChange(
            winnerElo,
            loserElo,
            true
        );

    const loserChange =
        getEloChange(
            loserElo,
            winnerElo,
            false
        );

    const winnerNewElo =
        winnerElo + winnerChange;

    const loserNewElo =
        Math.max(
            0,
            loserElo + loserChange
        );

    /*
    WINNER
    */

    await env.DB.prepare(`
        UPDATE player_stats

        SET
            elo = ?,
            wins = wins + 1,
            games_played = games_played + 1

        WHERE uuid = ?
        AND mode = ?
    `)
    .bind(
        winnerNewElo,
        winnerUuid,
        match.mode
    )
    .run();

    /*
    LOSER
    */

    await env.DB.prepare(`
        UPDATE player_stats

        SET
            elo = ?,
            losses = losses + 1,
            games_played = games_played + 1

        WHERE uuid = ?
        AND mode = ?
    `)
    .bind(
        loserNewElo,
        loserUuid,
        match.mode
    )
    .run();

    /*
    MATCH
    */

    await env.DB.prepare(`
        UPDATE matches

        SET
            status = 'finished',
            winner_uuid = ?,
            finished_at = ?

        WHERE id = ?
        AND status = 'waiting'
    `)
    .bind(
        winnerUuid,
        now(),
        match.id
    )
    .run();

    /*
    SERVER PLAYER COUNT
    */

    if (match.server_id) {

        await env.DB.prepare(`
            UPDATE servers

            SET players =
                CASE
                    WHEN players >= 2
                    THEN players - 2
                    ELSE 0
                END

            WHERE id = ?
        `)
        .bind(
            match.server_id
        )
        .run();

    }

    return {
        success: true,

        matchId: match.id,

        winner: {
            uuid: winnerUuid,
            oldElo: winnerElo,
            change: winnerChange,
            newElo: winnerNewElo,
            tier: getTierFromElo(
                winnerNewElo
            )
        },

        loser: {
            uuid: loserUuid,
            oldElo: loserElo,
            change: loserChange,
            newElo: loserNewElo,
            tier: getTierFromElo(
                loserNewElo
            )
        }
    };

}

/*
==================================================
KIT DEFAULT
==================================================
*/

const KIT_ITEMS = {

    sword: [
        "diamond_sword",
        "diamond_helmet",
        "diamond_chestplate",
        "diamond_leggings",
        "diamond_boots"
    ],

    axe: [
        "iron_sword",
        "iron_axe",
        "shield",
        "bow",
        "arrow",
        "iron_helmet",
        "iron_chestplate",
        "iron_leggings",
        "iron_boots"
    ],

    mace: [
        "netherite_sword",
        "netherite_axe",
        "mace_density",
        "mace_breach",
        "wind_charge",
        "ender_pearl",
        "shield",
        "totem",
        "strength_potion",
        "speed_potion"
    ],

    pot: [
        "diamond_sword",
        "strength_potion",
        "speed_potion",
        "regeneration_potion",
        "healing_potion",
        "steak"
    ],

    uhc: [
        "diamond_sword",
        "bow",
        "crossbow",
        "arrow",
        "water_bucket",
        "lava_bucket",
        "golden_apple",
        "cobweb",
        "oak_log",
        "cobblestone"
    ],

    nethop: [
        "netherite_sword",
        "netherite_sword_knockback",
        "totem",
        "experience_bottle",
        "golden_apple",
        "strength_potion",
        "speed_potion",
        "regeneration_potion",
        "healing_potion"
    ],

    vanilla: [],

    smp: []

};

function validKitItem(
    mode,
    itemKey
) {

    return KIT_ITEMS[mode]?.includes(
        itemKey
    );

}

/*
==================================================
KIT LAYOUT GET
==================================================
*/

async function getKitLayout(
    env,
    uuid,
    mode
) {

    const result =
        await env.DB.prepare(`
            SELECT
                slot,
                item_key
            FROM kit_layouts

            WHERE uuid = ?
            AND mode = ?

            ORDER BY slot ASC
        `)
        .bind(
            uuid,
            mode
        )
        .all();

    return result.results;

}

/*
==================================================
KIT LAYOUT SAVE
==================================================
*/

async function saveKitLayout(
    env,
    uuid,
    mode,
    layout
) {

    if (!Array.isArray(layout)) {

        throw new Error(
            "layout must be an array"
        );

    }

    /*
    Remove old layout
    */

    await env.DB.prepare(`
        DELETE FROM kit_layouts
        WHERE uuid = ?
        AND mode = ?
    `)
    .bind(
        uuid,
        mode
    )
    .run();

    /*
    Save new layout
    */

    for (const entry of layout) {

        const slot =
            Number(entry.slot);

        const itemKey =
            String(entry.item_key || "");

        if (
            !Number.isInteger(slot) ||
            slot < 0 ||
            slot > 35
        ) {

            continue;

        }

        if (
            !validKitItem(
                mode,
                itemKey
            )
        ) {

            continue;

        }

        await env.DB.prepare(`
            INSERT INTO kit_layouts (
                uuid,
                mode,
                slot,
                item_key
            )

            VALUES (?, ?, ?, ?)
        `)
        .bind(
            uuid,
            mode,
            slot,
            itemKey
        )
        .run();

    }

}

/*
==================================================
SERVER AUTH
==================================================
*/

function checkServerKey(
    request,
    env
) {

    const configuredKey =
        env.SERVER_API_KEY;

    if (!configuredKey) {

        return false;

    }

    const providedKey =
        request.headers.get(
            "X-Server-Key"
        );

    return (
        providedKey &&
        providedKey === configuredKey
    );

}

/*
==================================================
FETCH
==================================================
*/

export default {

    async fetch(
        request,
        env
    ) {

        if (
            request.method === "OPTIONS"
        ) {

            return corsResponse();

        }

        try {

            await cleanupStaleData(
                env
            );

        } catch (error) {

            console.error(
                "Cleanup error:",
                error
            );

        }

        const url =
            new URL(
                request.url
            );

        const path =
            url.pathname;

        const method =
            request.method;

        /*
        ==========================================
        HEALTH
        ==========================================
        */

        if (
            method === "GET" &&
            path === "/health"
        ) {

            return json({
                success: true,
                message:
                    "SpicyTiers Ranked API is online",
                version: "3.0.0",
                database: "D1"
            });

        }

        /*
        ==========================================
        PLAYER SYNC
        ==========================================
        */

        if (
            method === "POST" &&
            path === "/player/sync"
        ) {

            const body =
                await request.json();

            const uuid =
                body.uuid;

            const username =
                body.username;

            if (
                !validUUID(uuid) ||
                !validUsername(username)
            ) {

                return json({
                    success: false,
                    error:
                        "Invalid UUID or username"
                }, 400);

            }

            await ensurePlayer(
                env,
                uuid,
                username
            );

            return json({
                success: true,
                message:
                    "Player synced"
            });

        }

        /*
        ==========================================
        PLAYER PROFILE
        ==========================================
        */

        if (
            method === "GET" &&
            path.startsWith("/player/")
        ) {

            const uuid =
                path.replace(
                    "/player/",
                    ""
                );

            if (!validUUID(uuid)) {

                return json({
                    success: false,
                    error:
                        "Invalid UUID"
                }, 400);

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

                return json({
                    success: false,
                    error:
                        "Player not found"
                }, 404);

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
                `)
                .bind(uuid)
                .all();

            const modes = {};

            let totalElo = 0;

            for (const mode of MODES) {

                const stat =
                    stats.results.find(
                        x =>
                            x.mode === mode
                    );

                const elo =
                    stat
                        ? Number(stat.elo)
                        : 0;

                totalElo += elo;

                modes[mode] = {

                    elo,

                    tier:
                        getTierFromElo(
                            elo
                        ),

                    wins:
                        stat
                            ? Number(stat.wins)
                            : 0,

                    losses:
                        stat
                            ? Number(stat.losses)
                            : 0,

                    games_played:
                        stat
                            ? Number(
                                stat.games_played
                            )
                            : 0

                };

            }

            return json({
                success: true,

                player: {
                    ...player,

                    elo: totalElo,

                    modes
                }
            });

        }

        /*
        ==========================================
        QUEUE JOIN
        ==========================================
        */

        if (
            method === "POST" &&
            path === "/queue/join"
        ) {

            const body =
                await request.json();

            const uuid =
                body.uuid;

            const username =
                body.username;

            const mode =
                normalizeMode(
                    body.mode
                );

            const region =
                normalizeRegion(
                    body.region
                );

            if (!validUUID(uuid)) {

                return json({
                    success: false,
                    error: "Invalid UUID"
                }, 400);

            }

            if (!validUsername(username)) {

                return json({
                    success: false,
                    error:
                        "Invalid username"
                }, 400);

            }

            if (!validMode(mode)) {

                return json({
                    success: false,
                    error:
                        "Invalid gamemode"
                }, 400);

            }

            await ensurePlayer(
                env,
                uuid,
                username
            );

            const elo =
                await getPlayerElo(
                    env,
                    uuid,
                    mode
                );

            const existing =
                await env.DB.prepare(`
                    SELECT *
                    FROM queue
                    WHERE uuid = ?
                    AND mode = ?
                `)
                .bind(
                    uuid,
                    mode
                )
                .first();

            if (existing) {

                if (
                    existing.joined_at <
                    now() - QUEUE_TIMEOUT
                ) {

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

                    return json({
                        success: false,
                        error:
                            "Already in queue"
                    }, 409);

                }

            }

            const player = {
                uuid,
                username,
                mode,
                region,
                elo
            };

            const opponent =
                await findMatch(
                    env,
                    player
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
                `)
                .bind(
                    uuid,
                    username,
                    mode,
                    region,
                    elo,
                    now()
                )
                .run();

                return json({
                    success: true,
                    matched: false,
                    queued: true,
                    mode,
                    elo
                });

            }

            const server =
                await findServer(
                    env,
                    region
                );

            if (!server) {

                return json({
                    success: false,
                    matched: false,
                    error:
                        "No online duel server available"
                }, 503);

            }

            const matchId =
                await createMatch(
                    env,
                    player,
                    opponent,
                    server
                );

            return json({
                success: true,
                matched: true,

                match: {
                    id: matchId,
                    mode,
                    region,

                    server: {
                        id: server.id,
                        name: server.name,
                        region: server.region,
                        address: server.address
                    },

                    players: [
                        {
                            uuid:
                                player.uuid,
                            username:
                                player.username,
                            elo:
                                player.elo
                        },
                        {
                            uuid:
                                opponent.uuid,
                            username:
                                opponent.username,
                            elo:
                                opponent.elo
                        }
                    ]
                }
            });

        }

        /*
        ==========================================
        QUEUE STATUS
        ==========================================
        */

        if (
            method === "GET" &&
            path === "/queue/status"
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
                !validUUID(uuid) ||
                !validMode(mode)
            ) {

                return json({
                    success: false,
                    error:
                        "Invalid UUID or mode"
                }, 400);

            }

            const row =
                await env.DB.prepare(`
                    SELECT
                        uuid,
                        username,
                        mode,
                        region,
                        elo,
                        joined_at
                    FROM queue
                    WHERE uuid = ?
                    AND mode = ?
                `)
                .bind(
                    uuid,
                    mode
                )
                .first();

            return json({
                success: true,
                queued: !!row,
                queue: row || null
            });

        }

        /*
        ==========================================
        QUEUE LEAVE
        ==========================================
        */

        if (
            method === "POST" &&
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
                !validUUID(uuid) ||
                !validMode(mode)
            ) {

                return json({
                    success: false,
                    error:
                        "Invalid UUID or mode"
                }, 400);

            }

            const result =
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

            return json({
                success: true,
                removed:
                    result.meta.changes > 0
            });

        }

        /*
        ==========================================
        MATCH STATUS
        ==========================================
        */

        if (
            method === "GET" &&
            path === "/match/status"
        ) {

            const uuid =
                url.searchParams.get(
                    "uuid"
                );

            if (!validUUID(uuid)) {

                return json({
                    success: false,
                    error:
                        "Invalid UUID"
                }, 400);

            }

            const match =
                await getMatchForPlayer(
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

            return json({
                success: true,
                matched: true,

                match: {

                    id: match.id,

                    mode:
                        match.mode,

                    region:
                        match.region,

                    status:
                        match.status,

                    server: {
                        id:
                            match.server_id,

                        name:
                            match.server_name,

                        region:
                            match.server_region,

                        address:
                            match.server_address,

                        online:
                            match.server_online,

                        players:
                            match.server_players,

                        max_players:
                            match.server_max_players
                    },

                    players: [
                        {
                            uuid:
                                match.player1_uuid,

                            username:
                                match.player1_username,

                            elo:
                                match.player1_elo
                        },

                        {
                            uuid:
                                match.player2_uuid,

                            username:
                                match.player2_username,

                            elo:
                                match.player2_elo
                        }
                    ],

                    winnerUuid:
                        match.winner_uuid,

                    createdAt:
                        match.created_at,

                    finishedAt:
                        match.finished_at

                }

            });

        }

        /*
        ==========================================
        KIT GET
        ==========================================
        */

        if (
            method === "GET" &&
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
                !validUUID(uuid) ||
                !validMode(mode)
            ) {

                return json({
                    success: false,
                    error:
                        "Invalid UUID or mode"
                }, 400);

            }

            const layout =
                await getKitLayout(
                    env,
                    uuid,
                    mode
                );

            return json({
                success: true,
                uuid,
                mode,
                layout
            });

        }

        /*
        ==========================================
        KIT SAVE
        ==========================================
        */

        if (
            method === "POST" &&
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

            if (
                !validUUID(uuid) ||
                !validMode(mode)
            ) {

                return json({
                    success: false,
                    error:
                        "Invalid UUID or mode"
                }, 400);

            }

            await saveKitLayout(
                env,
                uuid,
                mode,
                body.layout
            );

            return json({
                success: true,
                message:
                    "Kit layout saved"
            });

        }

        /*
        ==========================================
        SERVER HEARTBEAT
        ==========================================
        */

        if (
            method === "POST" &&
            path === "/server/heartbeat"
        ) {

            if (
                !checkServerKey(
                    request,
                    env
                )
            ) {

                return json({
                    success: false,
                    error:
                        "Unauthorized"
                }, 401);

            }

            const body =
                await request.json();

            const id =
                Number(body.id);

            const players =
                Math.max(
                    0,
                    Number(body.players) || 0
                );

            if (!id) {

                return json({
                    success: false,
                    error:
                        "Server ID required"
                }, 400);

            }

            await env.DB.prepare(`
                UPDATE servers

                SET
                    online = 1,
                    players = ?,
                    last_heartbeat = ?

                WHERE id = ?
            `)
            .bind(
                players,
                now(),
                id
            )
            .run();

            return json({
                success: true,
                online: true
            });

        }

        /*
        ==========================================
        SERVER MATCH
        ==========================================
        */

        if (
            method === "GET" &&
            path === "/server/match"
        ) {

            if (
                !checkServerKey(
                    request,
                    env
                )
            ) {

                return json({
                    success: false,
                    error:
                        "Unauthorized"
                }, 401);

            }

            const uuid =
                url.searchParams.get(
                    "uuid"
                );

            if (!validUUID(uuid)) {

                return json({
                    success: false,
                    error:
                        "Invalid UUID"
                }, 400);

            }

            const match =
                await env.DB.prepare(`
                    SELECT
                        *
                    FROM matches

                    WHERE
                        (
                            player1_uuid = ?
                            OR
                            player2_uuid = ?
                        )

                    AND status = 'waiting'

                    ORDER BY created_at DESC

                    LIMIT 1
                `)
                .bind(
                    uuid,
                    uuid
                )
                .first();

            if (!match) {

                return json({
                    success: true,
                    matched: false
                });

            }

            return json({
                success: true,
                matched: true,
                match
            });

        }

        /*
        ==========================================
        MATCH START
        ==========================================
        */

        if (
            method === "POST" &&
            path === "/server/match/start"
        ) {

            if (
                !checkServerKey(
                    request,
                    env
                )
            ) {

                return json({
                    success: false,
                    error:
                        "Unauthorized"
                }, 401);

            }

            const body =
                await request.json();

            const matchId =
                body.match_id;

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

                return json({
                    success: false,
                    error:
                        "Match not found"
                }, 404);

            }

            if (
                match.status !== "waiting"
            ) {

                return json({
                    success: false,
                    error:
                        "Match is not waiting"
                }, 409);

            }

            await env.DB.prepare(`
                UPDATE matches
                SET status = 'active'
                WHERE id = ?
            `)
            .bind(
                matchId
            )
            .run();

            return json({
                success: true,
                status: "active"
            });

        }

        /*
        ==========================================
        MATCH RESULT
        ==========================================
        */

        if (
            method === "POST" &&
            path === "/server/match/result"
        ) {

            if (
                !checkServerKey(
                    request,
                    env
                )
            ) {

                return json({
                    success: false,
                    error:
                        "Unauthorized"
                }, 401);

            }

            const body =
                await request.json();

            const matchId =
                body.match_id;

            const winnerUuid =
                body.winner_uuid;

            if (
                !matchId ||
                !validUUID(winnerUuid)
            ) {

                return json({
                    success: false,
                    error:
                        "match_id and winner_uuid required"
                }, 400);

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

                return json({
                    success: false,
                    error:
                        "Match not found"
                }, 404);

            }

            if (
                match.status === "finished"
            ) {

                return json({
                    success: true,
                    alreadyFinished: true,
                    winnerUuid:
                        match.winner_uuid
                });

            }

            return json(
                await finishMatch(
                    env,
                    match,
                    winnerUuid
                )
            );

        }

        /*
        ==========================================
        LEADERBOARD
        ==========================================
        */

        if (
            method === "GET" &&
            path.startsWith(
                "/leaderboard/"
            )
        ) {

            const mode =
                path.replace(
                    "/leaderboard/",
                    ""
                ).toLowerCase();

            if (
                mode === "overall"
            ) {

                const playersResult =
                    await env.DB.prepare(`
                        SELECT
                            uuid,
                            username
                        FROM players
                    `)
                    .all();

                const players = [];

                for (
                    const player
                    of playersResult.results
                ) {

                    const statsResult =
                        await env.DB.prepare(`
                            SELECT
                                mode,
                                elo
                            FROM player_stats
                            WHERE uuid = ?
                        `)
                        .bind(
                            player.uuid
                        )
                        .all();

                    const modes = {};

                    let totalElo = 0;

                    for (
                        const gameMode
                        of MODES
                    ) {

                        const stat =
                            statsResult.results.find(
                                s =>
                                    s.mode ===
                                    gameMode
                            );

                        const elo =
                            stat
                                ? Number(
                                    stat.elo
                                )
                                : 0;

                        totalElo += elo;

                        modes[gameMode] = {
                            elo,
                            tier:
                                getTierFromElo(
                                    elo
                                )
                        };

                    }

                    players.push({
                        username:
                            player.username,

                        uuid:
                            player.uuid,

                        elo:
                            totalElo,

                        modes
                    });

                }

                players.sort(
                    (a, b) =>
                        b.elo - a.elo
                );

                return json({
                    success: true,
                    mode: "overall",
                    players
                });

            }

            if (!validMode(mode)) {

                return json({
                    success: false,
                    error:
                        "Invalid gamemode"
                }, 400);

            }

            const result =
                await env.DB.prepare(`
                    SELECT
                        p.uuid,
                        p.username,
                        s.elo,
                        s.wins,
                        s.losses,
                        s.games_played

                    FROM players p

                    INNER JOIN player_stats s
                        ON p.uuid = s.uuid

                    WHERE s.mode = ?

                    ORDER BY s.elo DESC
                `)
                .bind(
                    mode
                )
                .all();

            const players =
                result.results.map(
                    player => {

                        const elo =
                            Number(
                                player.elo
                            ) || 0;

                        return {
                            username:
                                player.username,

                            uuid:
                                player.uuid,

                            tier:
                                getTierFromElo(
                                    elo
                                ),

                            elo,

                            wins:
                                Number(
                                    player.wins
                                ),

                            losses:
                                Number(
                                    player.losses
                                ),

                            games_played:
                                Number(
                                    player.games_played
                                )
                        };

                    }
                );

            return json({
                success: true,
                mode,
                players
            });

        }

        return json({
            success: false,
            error:
                "Endpoint not found",
            path
        }, 404);

    }

};
