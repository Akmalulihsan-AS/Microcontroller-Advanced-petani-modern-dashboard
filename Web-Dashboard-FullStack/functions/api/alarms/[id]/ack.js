
import {
    getDB,
    json,
    errorResponse
} from "../../../../_lib/db.js";

export async function onRequestPost({ request, env, params }) {
    try {
        const db = getDB(env);
        const id = Number(params.id);

        if (!Number.isInteger(id) || id <= 0) {
            return errorResponse("ID alarm tidak valid", 400);
        }

        const result = await db.prepare(`
            UPDATE alarms
            SET acknowledged = 1
            WHERE id = ?
        `).bind(id).run();

        if (!result.meta?.changes) {
            return errorResponse("Alarm tidak ditemukan", 404);
        }

        return json({
            ok: true,
            message: "Alarm berhasil diakui",
            id
        });

    } catch (error) {
        return errorResponse(error.message);
    }
}

