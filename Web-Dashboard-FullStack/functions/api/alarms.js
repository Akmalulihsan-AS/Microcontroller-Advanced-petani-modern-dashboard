
import {
    getDB,
    json,
    errorResponse,
    getLimit
} from "../_lib/db.js";

export async function onRequestGet({ request, env }) {
    try {
        const db = getDB(env);
        const url = new URL(request.url);

        const limit = getLimit(
            url.searchParams.get("limit"),
            200,
            1000
        );

        const result = await db.prepare(`
            SELECT *
            FROM alarms
            ORDER BY id DESC
            LIMIT ?
        `).bind(limit).all();

        return json(result.results || []);

    } catch (error) {
        return errorResponse(error.message);
    }
}

