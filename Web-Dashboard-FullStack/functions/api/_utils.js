
import { nowISO } from "../_lib/db.js";

export function normalizeTelemetry(data) {
    const sensorStatus = data.sensor_status || {};

    return {
        timestamp: nowISO(),

        temperature:
            Number(data.temperature_c ?? data.temperature ?? 0),

        soil_moisture:
            Number(data.soil_moisture_pct ?? data.soil_moisture ?? 0),

        light_lux:
            Number(data.light_lux ?? 0),

        plant_height:
            Number(data.plant_height_cm ?? data.plant_height ?? 0),

        distance_cm:
            Number(data.distance_cm ?? 0),

        soil_adc:
            Number(data.soil_adc ?? 0),

        temp_status:
            sensorStatus.temperature ?? data.temp_status ?? "UNKNOWN",

        soil_status:
            sensorStatus.soil ?? data.soil_status ?? "UNKNOWN",

        light_status:
            sensorStatus.light ?? data.light_status ?? "UNKNOWN",

        height_status:
            sensorStatus.height ?? data.height_status ?? "UNKNOWN"
    };
}

export async function createAlarm(db, severity, sensor, message) {
    const existing = await db.prepare(`
        SELECT id
        FROM alarms
        WHERE acknowledged = 0
          AND sensor = ?
          AND message = ?
        LIMIT 1
    `).bind(sensor, message).first();

    if (existing) return;

    await db.prepare(`
        INSERT INTO alarms (
            timestamp,
            severity,
            sensor,
            message,
            acknowledged
        )
        VALUES (?, ?, ?, ?, 0)
    `).bind(
        nowISO(),
        severity,
        sensor,
        message
    ).run();
}

export async function processTelemetry(db, data) {
    const reading = normalizeTelemetry(data);

    await db.prepare(`
        INSERT INTO readings (
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
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
        reading.timestamp,
        reading.temperature,
        reading.soil_moisture,
        reading.light_lux,
        reading.plant_height,
        reading.distance_cm,
        reading.soil_adc,
        reading.temp_status,
        reading.soil_status,
        reading.light_status,
        reading.height_status
    ).run();

    await db.prepare(`
        UPDATE device_state
        SET status = 'online',
            last_seen = ?
        WHERE id = 1
    `).bind(reading.timestamp).run();

    // SENSOR FAULT

    const statuses = [
        ["temperature", reading.temp_status],
        ["soil", reading.soil_status],
        ["light", reading.light_status],
        ["height", reading.height_status]
    ];

    for (const [sensor, status] of statuses) {
        if (status === "FAULT") {
            await createAlarm(
                db,
                "danger",
                sensor,
                `${sensor} sensor mengalami gangguan`
            );
        }

        if (status === "DEGRADED") {
            await createAlarm(
                db,
                "warning",
                sensor,
                `${sensor} sensor mengalami penurunan kinerja`
            );
        }
    }

    // TEMPERATURE WARNING

    if (reading.temperature > 35) {
        await createAlarm(
            db,
            "warning",
            "temperature",
            "Suhu terlalu tinggi"
        );
    }

    // SOIL MOISTURE WARNING

    if (reading.soil_moisture < 30) {
        await createAlarm(
            db,
            "warning",
            "soil",
            "Kelembapan tanah terlalu rendah"
        );
    }

    return reading;
}

export async function processDiagnostics(db, data) {
    await db.prepare(`
        UPDATE device_state
        SET
            status = 'online',
            last_seen = ?,
            ip = ?,
            firmware = ?,
            uptime_s = ?,
            free_heap = ?,
            mqtt_reconnects = ?,
            mqtt_publish_fail = ?,
            missed_ticks = ?,
            max_cycle_us = ?
        WHERE id = 1
    `).bind(
        nowISO(),
        data.ip ?? null,
        data.firmware ?? null,
        data.uptime_s ?? null,
        data.free_heap ?? null,
        data.mqtt_reconnects ?? null,
        data.mqtt_publish_fail ?? null,
        data.missed_ticks ?? null,
        data.max_cycle_us ?? null
    ).run();
}

export async function processStatus(db, status) {
    const value = String(status).toLowerCase();

    if (value !== "online" && value !== "offline") {
        throw new Error("Status perangkat tidak valid");
    }

    await db.prepare(`
        UPDATE device_state
        SET status = ?,
            last_seen = ?
        WHERE id = 1
    `).bind(value, nowISO()).run();
}
