const express = require("express");
const mqtt = require("mqtt");
const Database = require("better-sqlite3");
const path = require("path");

const PORT = Number(process.env.PORT || 3000);
const MQTT_URL = process.env.MQTT_URL || "mqtt://broker.emqx.io:1883";
const DEVICE_ID = process.env.DEVICE_ID || "petani-modern";
const TOPIC_BASE = `smartfarm/${DEVICE_ID}`;
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const db = new Database(path.join(__dirname, "smartfarm.db"));
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS readings (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 timestamp TEXT NOT NULL,
 temperature REAL, soil_moisture REAL, light_lux REAL, plant_height REAL,
 distance_cm REAL, soil_adc INTEGER,
 temp_status TEXT, soil_status TEXT, light_status TEXT, height_status TEXT
);
CREATE INDEX IF NOT EXISTS idx_readings_timestamp ON readings(timestamp);
CREATE TABLE IF NOT EXISTS alarms (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 timestamp TEXT NOT NULL,
 severity TEXT NOT NULL,
 sensor TEXT NOT NULL,
 message TEXT NOT NULL,
 acknowledged INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_alarms_timestamp ON alarms(timestamp);
CREATE TABLE IF NOT EXISTS device_state (
 id INTEGER PRIMARY KEY CHECK (id=1),
 status TEXT, last_seen TEXT, ip TEXT, rssi INTEGER, firmware TEXT,
 uptime_s INTEGER, free_heap INTEGER, mqtt_reconnects INTEGER,
 mqtt_publish_fail INTEGER, missed_ticks INTEGER, max_cycle_us INTEGER
);
INSERT OR IGNORE INTO device_state(id,status) VALUES(1,'offline');
`);

const insertReading = db.prepare(`INSERT INTO readings
(timestamp,temperature,soil_moisture,light_lux,plant_height,distance_cm,soil_adc,
 temp_status,soil_status,light_status,height_status)
VALUES (@timestamp,@temperature,@soil_moisture,@light_lux,@plant_height,@distance_cm,@soil_adc,
 @temp_status,@soil_status,@light_status,@height_status)`);
const insertAlarm = db.prepare(`INSERT INTO alarms(timestamp,severity,sensor,message)
VALUES (?,?,?,?)`);
const updateDevice = db.prepare(`UPDATE device_state SET status=@status,last_seen=@last_seen,
 ip=@ip,rssi=@rssi,firmware=@firmware,uptime_s=@uptime_s,free_heap=@free_heap,
 mqtt_reconnects=@mqtt_reconnects,mqtt_publish_fail=@mqtt_publish_fail,
 missed_ticks=@missed_ticks,max_cycle_us=@max_cycle_us WHERE id=1`);

let latest = null;
const lastAlarmKey = new Map();
function addAlarm(severity, sensor, message) {
  const key = `${severity}:${sensor}:${message}`;
  const now = Date.now();
  if (lastAlarmKey.has(key) && now - lastAlarmKey.get(key) < 60000) return;
  lastAlarmKey.set(key, now);
  insertAlarm.run(new Date().toISOString(), severity, sensor, message);
}
function numeric(v) { return typeof v === "number" && Number.isFinite(v) ? v : null; }
function processTelemetry(data) {
  const s = data.sensor_status || {};
  const row = {
    timestamp: new Date().toISOString(),
    temperature: numeric(data.temperature_c),
    soil_moisture: numeric(data.soil_moisture_pct),
    light_lux: numeric(data.light_lux),
    plant_height: numeric(data.plant_height_cm),
    distance_cm: numeric(data.distance_cm),
    soil_adc: Number.isFinite(data.soil_adc) ? data.soil_adc : null,
    temp_status: s.temperature || "UNKNOWN",
    soil_status: s.soil || "UNKNOWN",
    light_status: s.light || "UNKNOWN",
    height_status: s.height || "UNKNOWN"
  };
  latest = row;
  insertReading.run(row);
  for (const [name, status] of Object.entries({
    Suhu: row.temp_status, Kelembapan: row.soil_status,
    Cahaya: row.light_status, Tinggi: row.height_status
  })) {
    if (status === "FAULT") addAlarm("danger", name, `Sensor ${name.toLowerCase()} mengalami FAULT`);
    else if (status === "DEGRADED") addAlarm("warning", name, `Sensor ${name.toLowerCase()} berstatus DEGRADED`);
  }
  // Batas awal untuk demonstrasi; sesuaikan dengan jenis tanaman dan kalibrasi lapangan.
  if (row.soil_moisture !== null && row.soil_moisture < 30)
    addAlarm("warning", "Kelembapan tanah", `Kelembapan tanah rendah: ${row.soil_moisture.toFixed(1)}%`);
  if (row.temperature !== null && row.temperature > 35)
    addAlarm("warning", "Suhu", `Suhu tinggi: ${row.temperature.toFixed(1)} °C`);
}
const client = mqtt.connect(MQTT_URL, {
  clientId: `webdash_${DEVICE_ID}_${Math.random().toString(16).slice(2,8)}`,
  clean: true, connectTimeout: 10000, reconnectPeriod: 3000
});
client.on("connect", () => {
  console.log(`[MQTT] Connected ${MQTT_URL}; subscribe ${TOPIC_BASE}/#`);
  client.subscribe(`${TOPIC_BASE}/#`, { qos: 0 });
});
client.on("reconnect", () => console.log("[MQTT] Reconnecting..."));
client.on("error", err => console.error("[MQTT]", err.message));
client.on("message", (topic, payload) => {
  const value = payload.toString();
  try {
    if (topic === `${TOPIC_BASE}/telemetry`) processTelemetry(JSON.parse(value));
    else if (topic === `${TOPIC_BASE}/status`) {
      const status = value === "online" ? "online" : "offline";
      db.prepare("UPDATE device_state SET status=?,last_seen=? WHERE id=1")
        .run(status, new Date().toISOString());
      if (status === "offline") addAlarm("danger", "Perangkat", "ESP32 terdeteksi offline");
    } else if (topic === `${TOPIC_BASE}/diagnostics`) {
      const d = JSON.parse(value);
      updateDevice.run({
        status: d.state || "online", last_seen: new Date().toISOString(),
        ip: d.ip || null, rssi: numeric(d.wifi_rssi_dbm),
        firmware: d.firmware || null, uptime_s: numeric(d.uptime_s),
        free_heap: numeric(d.free_heap), mqtt_reconnects: numeric(d.mqtt_reconnects),
        mqtt_publish_fail: numeric(d.mqtt_publish_fail),
        missed_ticks: numeric(d.missed_ticks), max_cycle_us: numeric(d.max_cycle_us)
      });
    }
  } catch (e) { console.error("[MQTT] Invalid message", topic, e.message); }
});

app.get("/api/latest", (req,res) => res.json({data:latest, device:db.prepare("SELECT * FROM device_state WHERE id=1").get()}));
app.get("/api/readings", (req,res) => {
  const limit = Math.min(Math.max(Number(req.query.limit)||500,1),5000);
  res.json(db.prepare("SELECT * FROM readings ORDER BY id DESC LIMIT ?").all(limit).reverse());
});

// Histori berdasarkan rentang waktu. Statistik dihitung dari seluruh data
// dalam rentang, sedangkan titik grafik di-sampling agar tetap ringan.
app.get("/api/history", (req, res) => {
  const ranges = { "1h": 1, "6h": 6, "24h": 24, "7d": 24 * 7 };
  const range = ranges[req.query.range] ? req.query.range : "24h";
  const hours = ranges[range];
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const stats = db.prepare(`
    SELECT COUNT(*) AS total,
      MIN(temperature) AS temperature_min, MAX(temperature) AS temperature_max, AVG(temperature) AS temperature_avg,
      MIN(soil_moisture) AS soil_moisture_min, MAX(soil_moisture) AS soil_moisture_max, AVG(soil_moisture) AS soil_moisture_avg,
      MIN(light_lux) AS light_lux_min, MAX(light_lux) AS light_lux_max, AVG(light_lux) AS light_lux_avg,
      MIN(plant_height) AS plant_height_min, MAX(plant_height) AS plant_height_max, AVG(plant_height) AS plant_height_avg
    FROM readings WHERE timestamp >= ?
  `).get(since);

  // Maksimal sekitar 1.200 titik grafik, tanpa mengurangi ketelitian statistik.
  const rows = db.prepare(`
    WITH filtered AS (
      SELECT *, ROW_NUMBER() OVER (ORDER BY timestamp, id) AS rn,
             COUNT(*) OVER () AS cnt
      FROM readings WHERE timestamp >= ?
    )
    SELECT id, timestamp, temperature, soil_moisture, light_lux, plant_height,
           temp_status, soil_status, light_status, height_status
    FROM filtered
    WHERE rn = 1 OR rn = cnt OR rn % MAX(1, CAST(cnt / 1200 AS INTEGER)) = 0
    ORDER BY timestamp, id
  `).all(since);

  res.json({ range, since, total: stats.total, stats, rows });
});

app.get("/api/alarms", (req,res) => {
  const limit = Math.min(Math.max(Number(req.query.limit)||200,1),1000);
  res.json(db.prepare("SELECT * FROM alarms ORDER BY id DESC LIMIT ?").all(limit));
});
app.post("/api/alarms/:id/ack", (req,res) => {
  const info = db.prepare("UPDATE alarms SET acknowledged=1 WHERE id=?").run(Number(req.params.id));
  res.json({ok:info.changes>0});
});
app.get("/api/export.csv", (req,res) => {
  const rows = db.prepare("SELECT timestamp,temperature,soil_moisture,light_lux,plant_height,distance_cm,soil_adc,temp_status,soil_status,light_status,height_status FROM readings ORDER BY id").all();
  const headers = Object.keys(rows[0] || {timestamp:"",temperature:"",soil_moisture:"",light_lux:"",plant_height:"",distance_cm:"",soil_adc:"",temp_status:"",soil_status:"",light_status:"",height_status:""});
  const csv = [headers.join(","), ...rows.map(r=>headers.map(k=>{
    const v=r[k] ?? ""; return `"${String(v).replace(/"/g,'""')}"`;
  }).join(","))].join("\r\n");
  res.setHeader("Content-Type","text/csv; charset=utf-8");
  res.setHeader("Content-Disposition",'attachment; filename="data-smart-farming.csv"');
  res.send("\uFEFF"+csv);
});
app.get("/api/health", (req,res)=>res.json({ok:true,mqtt:client.connected,topic:`${TOPIC_BASE}/#`}));
app.listen(PORT, () => console.log(`Dashboard: http://localhost:${PORT}`));
