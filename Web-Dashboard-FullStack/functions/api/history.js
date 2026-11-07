
export async function onRequestGet({ request, env }) {
    try {
        const url = new URL(request.url);

        const nodeId = url.searchParams.get("node_id");
        const limit = Math.min(
            Math.max(Number(url.searchParams.get("limit")) || 100, 1),
            1000
        );

        let result;

        if (nodeId !== null) {
            result = await env.DB.prepare(`
                SELECT *
                FROM sensor_data
                WHERE node_id = ?
                ORDER BY id DESC
                LIMIT ?
            `).bind(Number(nodeId), limit).all();
        } else {
            result = await env.DB.prepare(`
                SELECT *
                FROM sensor_data
                ORDER BY id DESC
                LIMIT ?
            `).bind(limit).all();
        }

        return Response.json({
            success: true,
            total: result.results.length,
            data: result.results
        });

    } catch (error) {
        return Response.json({
            success: false,
            message: error.message
        }, { status: 500 });
    }
}

