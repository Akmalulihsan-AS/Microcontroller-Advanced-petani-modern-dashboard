
import {
    getDB,
    json,
    errorResponse
} from "../_lib/db.js";

import {
    processTelemetry,
    processDiagnostics,
    processStatus
} from "./_utils.js";

export async function onRequestPost({ request, env }) {
    try {
        const db = getDB(env);
        const body = await request.json();

        const topic = String(body.topic || "");
        let payload = body.payload;

        if (!topic) {
            return errorResponse("Topic MQTT tidak ditemukan", 400);
        }

        if (typeof payload === "string") {
            try {
                payload = JSON.parse(payload);
            } catch {
                // Payload status bisa berupa teks biasa.
            }
        }

        const base = "smartfarm/petani-modern/";

        if (!topic.startsWith(base)) {
            return errorResponse("Topic tidak sesuai", 400);
        }

        const type = topic.slice(base.length);

        // TELEMETRY

        if (type === "telemetry") {
            if (!payload || typeof payload !== "object") {
                return errorResponse("Format telemetry tidak valid", 400);
            }

            const reading = await processTelemetry(db, payload);

            return json({
                ok: true,
                type: "telemetry",
                data: reading
            });
        }

        // DIAGNOSTICS

        if (type === "diagnostics") {
            if (!payload || typeof payload !== "object") {
                return errorResponse("Format diagnostics tidak valid", 400);
            }

            await processDiagnostics(db, payload);

            return json({
                ok: true,
                type: "diagnostics"
            });
        }

        // DEVICE STATUS

        if (type === "status") {
            await processStatus(db, payload);

            return json({
                ok: true,
                type: "status",
                status: payload
            });
        }

        return json({
            ok: true,
            ignored: true,
            topic
        });

    } catch (error) {
        return errorResponse(error.message);
    }
}
