
export async function onRequestPost({ request, env }) {
    try {
        const data = await request.json();

        const {
            node_id,
            soil_moisture,
            temperature,
            light_intensity
        } = data;

        if (
            node_id === undefined ||
            soil_moisture === undefined ||
            temperature === undefined ||
            light_intensity === undefined
        ) {
            return Response.json({
                success: false,
                message: "Data sensor tidak lengkap"
            }, { status: 400 });
        }

        const result = await env.DB.prepare(`
            INSERT INTO sensor_data (
                node_id,
                soil_moisture,
                temperature,
                light_intensity
            )
            VALUES (?, ?, ?, ?)
        `).bind(
            node_id,
            soil_moisture,
            temperature,
            light_intensity
        ).run();

        return Response.json({
            success: true,
            message: "Data berhasil disimpan",
            id: result.meta.last_row_id
        });

    } catch (error) {
        return Response.json({
            success: false,
            message: error.message
        }, { status: 500 });
    }
}

