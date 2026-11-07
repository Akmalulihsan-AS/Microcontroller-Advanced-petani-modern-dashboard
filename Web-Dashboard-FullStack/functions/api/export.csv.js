
import {
    getDB,
    errorResponse
} from "../_lib/db.js";

export async function onRequestGet({ env }) {
    try {
        const db = getDB(env);

        const result = await db.prepare(`
            SELECT
                id,
                timestamp,
                temperature,
                soil_moisture,
                light_lux,
                plant_height,
                distance_cm,
                soil_adc,
                temp_status,
                soil_status,
                light_status,
                height_status
            FROM readings
            ORDER BY id ASC
        `).all();

        const headers = [
            "id",
            "timestamp",
            "temperature",
            "soil_moisture",
            "light_lux",
            "plant_height",
            "distance_cm",
            "soil_adc",
            "temp_status",
            "soil_status",
            "light_status",
            "height_status"
        ];

        function escapeCSV(value) {
            if (value === null || value === undefined) {
                return "";
            }

            const text = String(value);

            return `"${text.replace(/"/g, '""')}"`;
        }

        const lines = [
            headers.join(","),
            ...(result.results || []).map(row =>
                headers.map(key => escapeCSV(row[key])).join(",")
            )
        ];

        return new Response(
            "\uFEFF" + lines.join("\r\n"),
            {
                status: 200,
                headers: {
                    "Content-Type": "text/csv; charset=utf-8",
                    "Content-Disposition":
                        'attachment; filename="petani-modern-readings.csv"',
                    "Cache-Control": "no-store"
                }
            }
        );

    } catch (error) {
        return errorResponse(error.message);
    }
}

