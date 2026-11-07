
import {
    getDB,
    json,
    errorResponse
} from "../_lib/db.js";

export async function onRequestGet({ env }) {
    try {
        const db = getDB(env);

        const latest = await db.prepare(`
            SELECT *
            FROM readings
            ORDER BY id DESC
            LIMIT 1
        `).first();

        const device = await db.prepare(`
            SELECT *
            FROM device_state
            WHERE id = 1
        `).first();

        return json({
            ok: true,
            data: latest,
            device: device
        });

    } catch (error) {
        return errorResponse(error.message);
    }
}

