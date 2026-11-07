
-- =====================================================
-- PETANI MODERN
-- CLOUDFLARE D1 DATABASE SCHEMA
-- =====================================================

-- TABLE 1: SENSOR READINGS

CREATE TABLE IF NOT EXISTS readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    temperature REAL,
    soil_moisture REAL,
    light_lux REAL,
    plant_height REAL,
    distance_cm REAL,
    soil_adc INTEGER,
    temp_status TEXT,
    soil_status TEXT,
    light_status TEXT,
    height_status TEXT
);

CREATE INDEX IF NOT EXISTS idx_readings_timestamp
ON readings(timestamp);


-- TABLE 2: ALARMS

CREATE TABLE IF NOT EXISTS alarms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    severity TEXT NOT NULL,
    sensor TEXT NOT NULL,
    message TEXT NOT NULL,
    acknowledged INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_alarms_timestamp
ON alarms(timestamp);


-- TABLE 3: ESP32 DEVICE STATUS

CREATE TABLE IF NOT EXISTS device_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    status TEXT DEFAULT 'offline',
    last_seen TEXT,
    ip TEXT,
    rssi INTEGER,
    firmware TEXT,
    uptime_s INTEGER,
    free_heap INTEGER,
    mqtt_reconnects INTEGER,
    mqtt_publish_fail INTEGER,
    missed_ticks INTEGER,
    max_cycle_us INTEGER
);

INSERT OR IGNORE INTO device_state (id, status)
VALUES (1, 'offline');
