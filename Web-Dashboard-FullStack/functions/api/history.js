
import {
    getDB,
    json,
    errorResponse
} from "../_lib/db.js";

export async function onRequestGet({ request, env }) {
    try {
        const db = getDB(env);
        const url = new URL(request.url);

        const range = url.searchParams.get("range") || "24h";

        const durations = {
            "1h": 60 * 60 * 1000,
            "6h": 6 * 60 * 60 * 1000,
            "24h": 24 * 60 * 60 * 1000,
            "7d": 7 * 24 * 60 * 60 * 1000,
            "30d": 30 * 24 * 60 * 60 * 1000
        };

        let since = null;
        let rows = [];
        let stats = {};
        let total = 0;

        if (range === "all") {
            since = null;
        } else if (durations[range]) {
            since = new Date(
                Date.now() - durations[range]
            ).toISOString();
        } else {
            return errorResponse("Range histori tidak valid", 400);
        }

        const condition = since
            ? "WHERE timestamp >= ?"
            : "";

        const countQuery = `
            SELECT COUNT(*) AS total
            FROM readings
            ${condition}
        `;

        const statsQuery = `
            SELECT
                AVG(temperature) AS temperature_avg,
                MIN(temperature) AS temperature_min,
                MAX(temperature) AS temperature_max,

                AVG(soil_moisture) AS soil_moisture_avg,
                MIN(soil_moisture) AS soil_moisture_min,
                MAX(soil_moisture) AS soil_moisture_max,

                AVG(light_lux) AS light_lux_avg,
                MIN(light_lux) AS light_lux_min,
                MAX(light_lux) AS light_lux_max,

                AVG(plant_height) AS plant_height_avg,
                MIN(plant_height) AS plant_height_min,
                MAX(plant_height) AS plant_height_max
            FROM readings
            ${condition}
        `;

        const countResult = since
            ? await db.prepare(countQuery).bind(since).first()
            : await db.prepare(countQuery).first();

        const statsResult = since
            ? await db.prepare(statsQuery).bind(since).first()
            : await db.prepare(statsQuery).first();

        total = countResult?.total || 0;
        stats = statsResult || {};

        const dataQuery = `
            SELECT *
            FROM readings
            ${condition}
            ORDER BY id DESC
            LIMIT 1200
        `;

        const dataResult = since
            ? await db.prepare(dataQuery).bind(since).all()
            : await db.prepare(dataQuery).all();

        rows = (dataResult.results || []).reverse();

        return json({
            ok: true,
            range,
            since,
            total,
            stats,
            rows
        });

    } catch (error) {
        return errorResponse(error.message);
    }
}
