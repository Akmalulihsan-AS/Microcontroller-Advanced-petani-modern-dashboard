
import {
    getDB,
    json,
    errorResponse
} from "../_lib/db.js";

export async function onRequestGet({ request, env }) {
    try {
        const db = getDB(env);
        const url = new URL(request.url);

        const mqttConnected =
            url.searchParams.get("mqtt") === "1";

        const device = await db.prepare(`
            SELECT status, last_seen
            FROM device_state
            WHERE id = 1
        `).first();

        return json({
            ok: true,
            mqtt: mqttConnected,
            topic: "smartfarm/petani-modern/#",
            device: device || {
                status: "offline",
                last_seen: null
            }
        });

    } catch (error) {
        return errorResponse(error.message);
    }
}

