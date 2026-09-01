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

export default {
    async fetch(request, env) {
        try {
            // =========================
            // CORS PREFLIGHT
            // =========================

            if (request.method === "OPTIONS") {
                return new Response(null, {
                    status: 204,
                    headers: corsHeaders()
                });
            }

            const url = new URL(request.url);
            const path = url.pathname;

            // =========================
            // API STATUS
            // =========================

            if (path === "/" && request.method === "GET") {
                return json({
                    success: true,
                    service: "SpicyTiers Ranked API",
                    status: "online",
                    version: "1.0.0"
                });
            }

            // =========================
            // SERVERS
            // =========================

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

            // =========================
            // QUEUE JOIN
            // =========================

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

                // -------------------------
                // VALIDATION
                // -------------------------

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

                // -------------------------
                // CHECK EXISTING QUEUE
                // -------------------------

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
                    `)
                        .bind(uuid, mode)
                        .first();

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

                // -------------------------
                // REGION
                // -------------------------

                let selectedRegion = region;

                if (selectedRegion === "auto") {
                    selectedRegion = "AU";
                } else {
                    selectedRegion = selectedRegion.toUpperCase();
                }

                // -------------------------
                // CHECK SERVER
                // -------------------------

                let server;

                try {
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
                        WHERE region = ?
                          AND online = 1
                        ORDER BY players ASC
                        LIMIT 1
                    `)
                        .bind(selectedRegion)
                        .first();
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

                // -------------------------
                // INSERT QUEUE
                // -------------------------

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
                    `)
                        .bind(
                            uuid,
                            username,
                            mode,
                            1,
                            selectedRegion,
                            elo,
                            joinedAt
                        )
                        .run();
                } catch (error) {
                    console.error("QUEUE INSERT ERROR:", error);

                    return json({
                        success: false,
                        error: "Failed to join queue",
                        details: error.message
                    }, 500);
                }

                // -------------------------
                // GET INSERTED QUEUE ENTRY
                // -------------------------

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
                    `)
                        .bind(uuid, mode)
                        .first();
                } catch (error) {
                    console.error("QUEUE FETCH ERROR:", error);

                    return json({
                        success: false,
                        error: "Failed to fetch queue entry",
                        details: error.message
                    }, 500);
                }

                return json({
                    success: true,
                    message: "Joined ranked queue",
                    queue: queueEntry,
                    server: {
                        name: server.name,
                        region: server.region,
                        address: server.address
                    }
                });
            }

            // =========================
            // QUEUE LEAVE
            // =========================

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
                    `)
                        .bind(uuid, mode)
                        .first();
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
                    `)
                        .bind(uuid, mode)
                        .run();
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

            // =========================
            // QUEUE STATUS
            // =========================

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
                    `)
                        .bind(uuid, mode)
                        .first();
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
                    queue: queueEntry
                });
            }

            // =========================
            // 404
            // =========================

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
