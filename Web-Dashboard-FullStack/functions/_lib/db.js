
export function getDB(env) {
    if (!env.DB) {
        throw new Error("D1 database binding DB tidak ditemukan");
    }

    return env.DB;
}

export function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store"
        }
    });
}

export function errorResponse(message, status = 500) {
    return json({
        ok: false,
        error: message
    }, status);
}

export function getLimit(value, fallback = 100, maximum = 1000) {
    const limit = Number.parseInt(value, 10);

    if (!Number.isFinite(limit) || limit <= 0) {
        return fallback;
    }

    return Math.min(limit, maximum);
}

export function nowISO() {
    return new Date().toISOString();
}
