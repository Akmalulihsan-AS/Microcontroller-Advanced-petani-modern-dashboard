#include <Arduino.h>
#include <Wire.h>
#include <WiFi.h>
#include <PubSubClient.h>
#include <BH1750.h>
#include "MAX6675.h"
#include "esp_timer.h"
#include "esp_task_wdt.h"

// =====================================================
// ADVANCED SENSOR SYSTEM + MQTT - ESP32 (Arduino Core 3.x)
//
// Arsitektur:
//   Hardware Timer (10 ms) --ISR--> sensorTask (Core 1, prio 3)
//   sensorTask --Queue--> loggerTask (Core 0, prio 1)   [Serial log]
//   sensorTask --Mutex--> latestSnapshot
//   latestSnapshot --> mqttTask (Core 0, prio 2)        [WiFi + MQTT]
//
// Library tambahan: "PubSubClient" by Nick O'Leary
// =====================================================

// =====================================================
// 0. WIFI & MQTT CONFIGURATION  (EDIT BAGIAN INI)
// =====================================================

#define WIFI_SSID       "wlan"
#define WIFI_PASSWORD   "12345678"

#define MQTT_HOST       "broker.emqx.io"
#define MQTT_PORT       1883
#define MQTT_USER       nullptr        // broker publik: tidak perlu
#define MQTT_PASS       nullptr

// Broker EMQX publik itu terbuka untuk semua orang.
// Ganti DEVICE_ID dengan nama unik supaya topikmu tidak bentrok / dibaca orang lain.
#define DEVICE_ID       "petani-modern"
#define TOPIC_BASE      "smartfarm/" DEVICE_ID

// Topik yang dipakai:
//   smartfarm/<id>/telemetry     JSON semua data sensor
//   smartfarm/<id>/temperature   angka tunggal (opsional)
//   smartfarm/<id>/soil          angka tunggal (opsional)
//   smartfarm/<id>/light         angka tunggal (opsional)
//   smartfarm/<id>/height        angka tunggal (opsional)
//   smartfarm/<id>/status        "online" / "offline" (retained + LWT)
//   smartfarm/<id>/diagnostics   JSON kesehatan ESP32 (retained)

#define TELEMETRY_INTERVAL_MS    2000UL
#define DIAGNOSTICS_INTERVAL_MS  30000UL
#define PUBLISH_INDIVIDUAL_TOPICS 1       // 1 = kirim juga topik per-sensor

#define MQTT_RECONNECT_MIN_MS    2000UL
#define MQTT_RECONNECT_MAX_MS    30000UL
#define WIFI_RETRY_MS            10000UL

#define FIRMWARE_VERSION "1.0.0"

// =====================================================
// 1. PIN CONFIGURATION
// =====================================================

// BH1750
#define SDA_PIN 21
#define SCL_PIN 22

// Soil Moisture
#define SOIL_PIN 34
#define DRY_VALUE 3000
#define WET_VALUE 1200
#define SOIL_OVERSAMPLE 8

// MAX6675
#define MAX6675_SO  19
#define MAX6675_CS  5
#define MAX6675_SCK 18

// Ultrasonic UART
#define SONIC_RX 17
#define SONIC_TX 16
#define SONIC_BAUD 9600

// =====================================================
// 2. SYSTEM CONFIGURATION
// =====================================================

#define TIMER_PERIOD_US 10000UL

#define SAMPLE_LIGHT_MS  500
#define SAMPLE_SOIL_MS   500
#define SAMPLE_TEMP_MS   500
#define SAMPLE_SONIC_MS  500

#define SONIC_MIN_WAIT_MS  150
#define SONIC_TIMEOUT_MS   400

// ---- Tinggi tanaman ----
// Sensor ultrasonik dipasang di ATAS tanaman menghadap ke bawah.
// Tinggi tanaman = tinggi pemasangan sensor dari tanah - jarak terukur.
#define SENSOR_MOUNT_HEIGHT_CM  100.0f   // jarak sensor ke permukaan tanah (cm) -> KALIBRASI
// Nilai mentah asli kamu dibagi 10000. Jika satuan hasilnya ternyata bukan cm,
// ubah faktor ini (misal 1000.0f jika hasilnya sebenarnya mm).
#define DISTANCE_DIVISOR        10000.0f

#define AVERAGE_SIZE 3

#define PRINT_INTERVAL_MS 1000

// Fault tolerance
#define FAIL_DEGRADED_THRESHOLD 1
#define FAIL_FAULT_THRESHOLD    5
#define I2C_RECOVER_EVERY       3
#define I2C_TIMEOUT_MS          50

// Task
#define SENSOR_TASK_STACK 6144
#define LOGGER_TASK_STACK 6144
#define MQTT_TASK_STACK   8192
#define WDT_TIMEOUT_S     5

#define DEBUG 1

// =====================================================
// 3. TYPES
// =====================================================

enum SensorId : uint8_t {
    SENSOR_LIGHT = 0,
    SENSOR_SOIL,
    SENSOR_TEMP,
    SENSOR_DISTANCE,
    SENSOR_COUNT
};

enum SensorStatus : uint8_t {
    STATUS_INIT = 0,
    STATUS_GOOD,
    STATUS_DEGRADED,
    STATUS_FAULT
};

static const char *SENSOR_NAME[SENSOR_COUNT] = {
    "LIGHT", "SOIL", "TEMP", "DISTANCE"
};

static const char *statusToString(SensorStatus s) {
    switch (s) {
        case STATUS_INIT:     return "INIT";
        case STATUS_GOOD:     return "OK";
        case STATUS_DEGRADED: return "DEGRADED";
        case STATUS_FAULT:    return "FAULT";
    }
    return "?";
}

struct SensorSnapshot {
    uint32_t timestampMs;

    float raw[SENSOR_COUNT];
    float avg[SENSOR_COUNT];

    uint16_t soilAdc;

    SensorStatus status[SENSOR_COUNT];
    uint32_t totalFail[SENSOR_COUNT];

    uint32_t missedTicks;
    uint32_t maxCycleUs;
};

// =====================================================
// 4. MOVING AVERAGE (3 SAMPEL)
// =====================================================

struct MovingAverage {

    float values[AVERAGE_SIZE] = {0};

    uint8_t index = 0;
    uint8_t count = 0;

    void add(float value) {

        if (!isfinite(value)) {
            return;
        }

        values[index] = value;

        index = (index + 1) % AVERAGE_SIZE;

        if (count < AVERAGE_SIZE) {
            count++;
        }
    }

    float getAverage() const {

        if (count == 0) {
            return NAN;
        }

        float sum = 0;

        for (uint8_t i = 0; i < count; i++) {
            sum += values[i];
        }

        return sum / count;
    }

    void reset() {

        for (uint8_t i = 0; i < AVERAGE_SIZE; i++) {
            values[i] = 0;
        }

        index = 0;
        count = 0;
    }
};

// =====================================================
// 5. SENSOR CHANNEL
// =====================================================

struct SensorChannel {

    MovingAverage filter;

    float raw = NAN;
    float avg = NAN;

    SensorStatus status = STATUS_INIT;

    uint16_t consecutiveFail = 0;
    uint32_t totalFail = 0;
    uint32_t lastOkMs = 0;

    void reportOk(float value, uint32_t nowMs) {

        raw = value;

        filter.add(value);
        avg = filter.getAverage();

        consecutiveFail = 0;
        lastOkMs = nowMs;
        status = STATUS_GOOD;
    }

    void reportFail() {

        consecutiveFail++;
        totalFail++;

        if (consecutiveFail >= FAIL_FAULT_THRESHOLD) {

            status = STATUS_FAULT;

            filter.reset();
            raw = NAN;
            avg = NAN;

        } else if (consecutiveFail >= FAIL_DEGRADED_THRESHOLD) {

            status = STATUS_DEGRADED;
        }
    }
};

// =====================================================
// 6. GLOBAL OBJECTS
// =====================================================

BH1750 lightMeter;

MAX6675 thermocouple(
    MAX6675_CS,
    MAX6675_SO,
    MAX6675_SCK
);

hw_timer_t *samplingTimer = nullptr;

TaskHandle_t sensorTaskHandle = nullptr;
TaskHandle_t loggerTaskHandle = nullptr;
TaskHandle_t mqttTaskHandle = nullptr;

QueueHandle_t logQueue = nullptr;
SemaphoreHandle_t snapshotMutex = nullptr;

volatile uint32_t systemTicks = 0;

SensorChannel channels[SENSOR_COUNT];

uint16_t soilAdcLast = 0;

SensorSnapshot latestSnapshot;

uint32_t missedTicks = 0;
uint32_t maxCycleUs = 0;

// MQTT
WiFiClient wifiClient;
PubSubClient mqttClient(wifiClient);

char mqttClientId[40];
char topicTelemetry[96];
char topicDiagnostics[96];
char topicStatus[96];
char topicTemp[96];
char topicSoil[96];
char topicLight[96];
char topicHeight[96];

volatile uint32_t mqttReconnectCount = 0;
volatile uint32_t mqttPublishFail = 0;

// =====================================================
// 7. TIME HELPERS
// =====================================================

static inline uint32_t nowMs() {
    return (uint32_t)(esp_timer_get_time() / 1000ULL);
}

static inline bool isDue(uint32_t now, uint32_t &previous, uint32_t period) {

    if (now - previous >= period) {
        previous = now;
        return true;
    }

    return false;
}

// =====================================================
// 8. HARDWARE TIMER ISR
// =====================================================

void ARDUINO_ISR_ATTR onTimerInterrupt() {

    systemTicks++;

    if (sensorTaskHandle == nullptr) {
        return;
    }

    BaseType_t higherPriorityTaskWoken = pdFALSE;

    vTaskNotifyGiveFromISR(
        sensorTaskHandle,
        &higherPriorityTaskWoken
    );

    if (higherPriorityTaskWoken) {
        portYIELD_FROM_ISR();
    }
}

// =====================================================
// 9. I2C RECOVERY
// =====================================================

void recoverI2C() {

#if DEBUG
    Serial.println("[RECOVERY] Re-init I2C + BH1750");
#endif

    Wire.end();

    vTaskDelay(pdMS_TO_TICKS(5));

    Wire.begin(SDA_PIN, SCL_PIN);
    Wire.setTimeOut(I2C_TIMEOUT_MS);

    lightMeter.begin(BH1750::CONTINUOUS_HIGH_RES_MODE);
}

// =====================================================
// 10. SENSOR SAMPLING FUNCTIONS
// =====================================================

void sampleLight(uint32_t now) {

    SensorChannel &ch = channels[SENSOR_LIGHT];

    float value = lightMeter.readLightLevel();

    if (!isfinite(value) || value < 0) {

        ch.reportFail();

        if (ch.consecutiveFail >= I2C_RECOVER_EVERY &&
            ch.consecutiveFail % I2C_RECOVER_EVERY == 0) {

            recoverI2C();
        }

        return;
    }

    ch.reportOk(value, now);
}

void sampleSoil(uint32_t now) {

    SensorChannel &ch = channels[SENSOR_SOIL];

    uint32_t total = 0;

    for (uint8_t i = 0; i < SOIL_OVERSAMPLE; i++) {
        total += analogRead(SOIL_PIN);
    }

    uint16_t adc = total / SOIL_OVERSAMPLE;

    soilAdcLast = adc;

    if (adc == 0 || adc >= 4095) {
        ch.reportFail();
        return;
    }

    float percent =
        ((float)adc - DRY_VALUE) * 100.0f /
        ((float)WET_VALUE - DRY_VALUE);

    percent = constrain(percent, 0.0f, 100.0f);

    ch.reportOk(percent, now);
}

void sampleTemperature(uint32_t now) {

    SensorChannel &ch = channels[SENSOR_TEMP];

    uint8_t status = thermocouple.read();

    float value = thermocouple.getCelsius();

    if (status != STATUS_OK ||
        !isfinite(value) ||
        value < -50.0f ||
        value > 1024.0f) {

        ch.reportFail();
        return;
    }

    ch.reportOk(value, now);
}

// =====================================================
// 11. ULTRASONIC UART STATE MACHINE (non-blocking)
// =====================================================

enum SonicState : uint8_t {
    SONIC_IDLE = 0,
    SONIC_WAITING
};

SonicState sonicState = SONIC_IDLE;

uint32_t sonicTriggerTime = 0;
uint32_t sonicLastCycle = 0;

void readUltrasonic(uint32_t now) {

    SensorChannel &ch = channels[SENSOR_DISTANCE];

    switch (sonicState) {

        case SONIC_IDLE:

            if (now - sonicLastCycle >= SAMPLE_SONIC_MS) {

                while (Serial2.available()) {
                    Serial2.read();
                }

                Serial2.write(0xA0);

                sonicTriggerTime = now;
                sonicState = SONIC_WAITING;
            }

            break;

        case SONIC_WAITING:

            if (now - sonicTriggerTime < SONIC_MIN_WAIT_MS) {
                break;
            }

            if (Serial2.available() >= 3) {

                uint32_t byteH = Serial2.read();
                uint32_t byteM = Serial2.read();
                uint32_t byteL = Serial2.read();

                uint32_t rawDistance =
                    (byteH << 16) |
                    (byteM << 8) |
                    byteL;

                if (rawDistance != 0 && rawDistance != 0xFFFFFF) {

                    ch.reportOk(rawDistance / DISTANCE_DIVISOR, now);

                } else {

                    ch.reportFail();
                }

                sonicLastCycle = now;
                sonicState = SONIC_IDLE;

            } else if (now - sonicTriggerTime >= SONIC_TIMEOUT_MS) {

                ch.reportFail();

#if DEBUG
                Serial.println("[WARN] ULTRASONIC: UART TIMEOUT");
#endif

                sonicLastCycle = now;
                sonicState = SONIC_IDLE;
            }

            break;
    }
}

// =====================================================
// 12. SENSOR SCHEDULER
// =====================================================

uint32_t previousLightTime = 0;
uint32_t previousSoilTime = 0;
uint32_t previousTempTime = 0;

void sensorScheduler(uint32_t now) {

    if (isDue(now, previousLightTime, SAMPLE_LIGHT_MS)) {
        sampleLight(now);
    }

    if (isDue(now, previousSoilTime, SAMPLE_SOIL_MS)) {
        sampleSoil(now);
    }

    if (isDue(now, previousTempTime, SAMPLE_TEMP_MS)) {
        sampleTemperature(now);
    }

    readUltrasonic(now);
}

// =====================================================
// 13. SNAPSHOT PUBLISHING (antar task)
// =====================================================

void buildSnapshot(SensorSnapshot &snap, uint32_t now) {

    snap.timestampMs = now;
    snap.soilAdc = soilAdcLast;
    snap.missedTicks = missedTicks;
    snap.maxCycleUs = maxCycleUs;

    for (uint8_t i = 0; i < SENSOR_COUNT; i++) {

        snap.raw[i] = channels[i].raw;
        snap.avg[i] = channels[i].avg;
        snap.status[i] = channels[i].status;
        snap.totalFail[i] = channels[i].totalFail;
    }
}

bool getLatestSnapshot(SensorSnapshot &out) {

    if (xSemaphoreTake(snapshotMutex, pdMS_TO_TICKS(10)) != pdTRUE) {
        return false;
    }

    out = latestSnapshot;

    xSemaphoreGive(snapshotMutex);

    return true;
}

uint32_t previousPublishTime = 0;

void publishSnapshot(uint32_t now) {

    if (!isDue(now, previousPublishTime, PRINT_INTERVAL_MS)) {
        return;
    }

    SensorSnapshot snap;

    buildSnapshot(snap, now);

    if (xSemaphoreTake(snapshotMutex, pdMS_TO_TICKS(5)) == pdTRUE) {

        latestSnapshot = snap;

        xSemaphoreGive(snapshotMutex);
    }

    xQueueSend(logQueue, &snap, 0);

    maxCycleUs = 0;
}

// =====================================================
// 14. SENSOR TASK (Core 1)
// =====================================================

void sensorTask(void *parameter) {

    esp_task_wdt_add(nullptr);

    while (true) {

        uint32_t ticks = ulTaskNotifyTake(pdTRUE, portMAX_DELAY);

        uint32_t cycleStart = (uint32_t)esp_timer_get_time();

        if (ticks > 1) {
            missedTicks += (ticks - 1);
        }

        uint32_t now = nowMs();

        sensorScheduler(now);

        publishSnapshot(now);

        uint32_t cycleTime = (uint32_t)esp_timer_get_time() - cycleStart;

        if (cycleTime > maxCycleUs) {
            maxCycleUs = cycleTime;
        }

        esp_task_wdt_reset();
    }
}

// =====================================================
// 15. LOGGER TASK (Core 0)
// =====================================================

void printSnapshot(const SensorSnapshot &s) {

    Serial.println();
    Serial.println("========== SENSOR MONITOR ==========");

    Serial.printf(
        "LIGHT     | Raw: %.2f lux | Avg: %.2f lux | %s\n",
        s.raw[SENSOR_LIGHT],
        s.avg[SENSOR_LIGHT],
        statusToString(s.status[SENSOR_LIGHT])
    );

    Serial.printf(
        "SOIL      | ADC: %u | Raw: %.1f%% | Avg: %.2f%% | %s\n",
        s.soilAdc,
        s.raw[SENSOR_SOIL],
        s.avg[SENSOR_SOIL],
        statusToString(s.status[SENSOR_SOIL])
    );

    Serial.printf(
        "TEMP      | Raw: %.2f C | Avg: %.2f C | %s\n",
        s.raw[SENSOR_TEMP],
        s.avg[SENSOR_TEMP],
        statusToString(s.status[SENSOR_TEMP])
    );

    Serial.printf(
        "DISTANCE  | Raw: %.4f | Avg: %.4f | %s\n",
        s.raw[SENSOR_DISTANCE],
        s.avg[SENSOR_DISTANCE],
        statusToString(s.status[SENSOR_DISTANCE])
    );

    Serial.printf(
        "FAULTS    | L:%lu S:%lu T:%lu D:%lu\n",
        (unsigned long)s.totalFail[SENSOR_LIGHT],
        (unsigned long)s.totalFail[SENSOR_SOIL],
        (unsigned long)s.totalFail[SENSOR_TEMP],
        (unsigned long)s.totalFail[SENSOR_DISTANCE]
    );

    Serial.printf(
        "SYSTEM    | Uptime: %lu ms | MissedTicks: %lu | MaxCycle: %lu us\n",
        (unsigned long)s.timestampMs,
        (unsigned long)s.missedTicks,
        (unsigned long)s.maxCycleUs
    );

    Serial.printf(
        "NETWORK   | WiFi: %s | RSSI: %d dBm | MQTT: %s | Reconnect: %lu\n",
        WiFi.status() == WL_CONNECTED ? "OK" : "DOWN",
        WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : 0,
        mqttClient.connected() ? "OK" : "DOWN",
        (unsigned long)mqttReconnectCount
    );

    Serial.printf(
        "STACK     | Sensor: %u B | Logger: %u B | MQTT: %u B | Heap: %u B\n",
        (unsigned)uxTaskGetStackHighWaterMark(sensorTaskHandle),
        (unsigned)uxTaskGetStackHighWaterMark(nullptr),
        (unsigned)(mqttTaskHandle ? uxTaskGetStackHighWaterMark(mqttTaskHandle) : 0),
        (unsigned)ESP.getFreeHeap()
    );

    Serial.println("====================================");
}

void loggerTask(void *parameter) {

    esp_task_wdt_add(nullptr);

    SensorSnapshot snap;

    while (true) {

        if (xQueueReceive(logQueue, &snap, pdMS_TO_TICKS(2000)) == pdTRUE) {

            printSnapshot(snap);

        } else {

            Serial.println("[WARN] Logger: tidak ada data dari sensorTask");
        }

        esp_task_wdt_reset();
    }
}

// =====================================================
// 16. MQTT
// =====================================================

// Format float ke string; NaN/Inf -> "null" (valid JSON)
static void fmtFloat(char *out, size_t size, float v, uint8_t decimals) {

    if (!isfinite(v)) {
        snprintf(out, size, "null");
    } else {
        snprintf(out, size, "%.*f", decimals, v);
    }
}

static const char *statusJson(SensorStatus s) {
    return statusToString(s);
}

// Tinggi tanaman dari jarak sensor (cm). NaN jika sensor jarak tidak valid.
static float computePlantHeight(float distanceCm) {

    if (!isfinite(distanceCm)) {
        return NAN;
    }

    float h = SENSOR_MOUNT_HEIGHT_CM - distanceCm;

    if (h < 0.0f) {
        h = 0.0f;
    }

    return h;
}

static void buildTopics() {

    uint64_t mac = ESP.getEfuseMac();

    snprintf(mqttClientId, sizeof(mqttClientId),
             "esp32-%s-%04X", DEVICE_ID, (uint16_t)(mac >> 32));

    snprintf(topicTelemetry,   sizeof(topicTelemetry),   TOPIC_BASE "/telemetry");
    snprintf(topicDiagnostics, sizeof(topicDiagnostics), TOPIC_BASE "/diagnostics");
    snprintf(topicStatus,      sizeof(topicStatus),      TOPIC_BASE "/status");
    snprintf(topicTemp,        sizeof(topicTemp),        TOPIC_BASE "/temperature");
    snprintf(topicSoil,        sizeof(topicSoil),        TOPIC_BASE "/soil");
    snprintf(topicLight,       sizeof(topicLight),       TOPIC_BASE "/light");
    snprintf(topicHeight,      sizeof(topicHeight),      TOPIC_BASE "/height");
}

static void publishTelemetry(const SensorSnapshot &s) {

    char temp[16], soil[16], light[16], height[16], dist[16];

    float heightCm = computePlantHeight(s.avg[SENSOR_DISTANCE]);

    fmtFloat(temp,   sizeof(temp),   s.avg[SENSOR_TEMP],     2);
    fmtFloat(soil,   sizeof(soil),   s.avg[SENSOR_SOIL],     1);
    fmtFloat(light,  sizeof(light),  s.avg[SENSOR_LIGHT],    1);
    fmtFloat(height, sizeof(height), heightCm,               1);
    fmtFloat(dist,   sizeof(dist),   s.avg[SENSOR_DISTANCE], 2);

    char payload[512];

    snprintf(payload, sizeof(payload),
        "{\"device\":\"%s\","
        "\"uptime_s\":%lu,"
        "\"temperature_c\":%s,"
        "\"soil_moisture_pct\":%s,"
        "\"soil_adc\":%u,"
        "\"light_lux\":%s,"
        "\"plant_height_cm\":%s,"
        "\"distance_cm\":%s,"
        "\"sensor_status\":{"
            "\"temperature\":\"%s\","
            "\"soil\":\"%s\","
            "\"light\":\"%s\","
            "\"height\":\"%s\"}}",
        DEVICE_ID,
        (unsigned long)(s.timestampMs / 1000UL),
        temp,
        soil,
        (unsigned)s.soilAdc,
        light,
        height,
        dist,
        statusJson(s.status[SENSOR_TEMP]),
        statusJson(s.status[SENSOR_SOIL]),
        statusJson(s.status[SENSOR_LIGHT]),
        statusJson(s.status[SENSOR_DISTANCE])
    );

    if (!mqttClient.publish(topicTelemetry, payload)) {
        mqttPublishFail++;
    }

#if PUBLISH_INDIVIDUAL_TOPICS
    // Hanya kirim jika nilainya valid (bukan null)
    if (isfinite(s.avg[SENSOR_TEMP]))     mqttClient.publish(topicTemp,   temp);
    if (isfinite(s.avg[SENSOR_SOIL]))     mqttClient.publish(topicSoil,   soil);
    if (isfinite(s.avg[SENSOR_LIGHT]))    mqttClient.publish(topicLight,  light);
    if (isfinite(heightCm))               mqttClient.publish(topicHeight, height);
#endif
}

static void publishDiagnostics(const SensorSnapshot &s, bool sensorTaskAlive) {

    char payload[640];

    String ip = WiFi.localIP().toString();

    snprintf(payload, sizeof(payload),
        "{\"device\":\"%s\","
        "\"firmware\":\"%s\","
        "\"state\":\"online\","
        "\"sensor_task_alive\":%s,"
        "\"uptime_s\":%lu,"
        "\"ip\":\"%s\","
        "\"wifi_rssi_dbm\":%d,"
        "\"free_heap\":%u,"
        "\"min_free_heap\":%u,"
        "\"cpu_mhz\":%u,"
        "\"reset_reason\":%d,"
        "\"mqtt_reconnects\":%lu,"
        "\"mqtt_publish_fail\":%lu,"
        "\"missed_ticks\":%lu,"
        "\"max_cycle_us\":%lu,"
        "\"faults\":{"
            "\"light\":%lu,\"soil\":%lu,\"temperature\":%lu,\"distance\":%lu}}",
        DEVICE_ID,
        FIRMWARE_VERSION,
        sensorTaskAlive ? "true" : "false",
        (unsigned long)(nowMs() / 1000UL),
        ip.c_str(),
        WiFi.RSSI(),
        (unsigned)ESP.getFreeHeap(),
        (unsigned)ESP.getMinFreeHeap(),
        (unsigned)getCpuFrequencyMhz(),
        (int)esp_reset_reason(),
        (unsigned long)mqttReconnectCount,
        (unsigned long)mqttPublishFail,
        (unsigned long)s.missedTicks,
        (unsigned long)s.maxCycleUs,
        (unsigned long)s.totalFail[SENSOR_LIGHT],
        (unsigned long)s.totalFail[SENSOR_SOIL],
        (unsigned long)s.totalFail[SENSOR_TEMP],
        (unsigned long)s.totalFail[SENSOR_DISTANCE]
    );

    mqttClient.publish(topicDiagnostics, payload, true);   // retained
}

static bool mqttConnect() {

    // LWT: jika ESP32 mati / putus tiba-tiba, broker otomatis publish "offline"
    bool ok = mqttClient.connect(
        mqttClientId,
        MQTT_USER,
        MQTT_PASS,
        topicStatus,
        1,              // will QoS
        true,           // will retained
        "offline"
    );

    if (ok) {
        mqttClient.publish(topicStatus, "online", true);
    }

    return ok;
}

void mqttTask(void *parameter) {

    // Catatan: task ini sengaja TIDAK didaftarkan ke watchdog karena
    // WiFi/MQTT connect bisa memblok beberapa detik.

    uint32_t lastWifiAttempt = 0;
    uint32_t lastMqttAttempt = 0;
    uint32_t mqttBackoff = MQTT_RECONNECT_MIN_MS;
    uint32_t lastTelemetry = 0;
    uint32_t lastDiagnostics = 0;
    bool wasConnected = false;

    while (true) {

        uint32_t now = nowMs();

        // ---------- WiFi ----------
        if (WiFi.status() != WL_CONNECTED) {

            wasConnected = false;

            if (now - lastWifiAttempt >= WIFI_RETRY_MS) {

                lastWifiAttempt = now;

#if DEBUG
                Serial.println("[WIFI] Menghubungkan...");
#endif
                WiFi.disconnect();
                WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
            }

            vTaskDelay(pdMS_TO_TICKS(500));
            continue;
        }

        // ---------- MQTT ----------
        if (!mqttClient.connected()) {

            if (now - lastMqttAttempt >= mqttBackoff) {

                lastMqttAttempt = now;

#if DEBUG
                Serial.printf("[MQTT] Connect ke %s:%d ...\n", MQTT_HOST, MQTT_PORT);
#endif

                if (mqttConnect()) {

#if DEBUG
                    Serial.println("[MQTT] Terhubung");
#endif
                    mqttReconnectCount++;
                    mqttBackoff = MQTT_RECONNECT_MIN_MS;
                    wasConnected = true;

                    // Kirim diagnostik segera setelah konek
                    lastDiagnostics = 0;

                } else {

#if DEBUG
                    Serial.printf("[MQTT] Gagal, rc=%d\n", mqttClient.state());
#endif
                    // Exponential backoff
                    mqttBackoff = min<uint32_t>(mqttBackoff * 2, MQTT_RECONNECT_MAX_MS);
                }
            }

            vTaskDelay(pdMS_TO_TICKS(200));
            continue;
        }

        (void)wasConnected;

        mqttClient.loop();

        // ---------- Publish ----------
        SensorSnapshot snap;

        if (getLatestSnapshot(snap) && snap.timestampMs != 0) {

            bool alive = (now - snap.timestampMs) < 3000UL;

            if (alive && (now - lastTelemetry >= TELEMETRY_INTERVAL_MS)) {

                lastTelemetry = now;
                publishTelemetry(snap);
            }

            if (now - lastDiagnostics >= DIAGNOSTICS_INTERVAL_MS || lastDiagnostics == 0) {

                lastDiagnostics = now;
                publishDiagnostics(snap, alive);
            }
        }

        vTaskDelay(pdMS_TO_TICKS(50));
    }
}

// =====================================================
// 17. SETUP
// =====================================================

void setup() {

    Serial.begin(115200);

    // ADC
    analogReadResolution(12);
    pinMode(SOIL_PIN, INPUT);

    // I2C
    Wire.begin(SDA_PIN, SCL_PIN);
    Wire.setTimeOut(I2C_TIMEOUT_MS);

    bool lightOk = lightMeter.begin(BH1750::CONTINUOUS_HIGH_RES_MODE);

    if (!lightOk) {
        Serial.println("[ERROR] BH1750 tidak terdeteksi (akan dicoba recovery)");
    }

    // MAX6675
    thermocouple.begin();

    // Ultrasonic UART
    Serial2.begin(SONIC_BAUD, SERIAL_8N1, SONIC_RX, SONIC_TX);

    // IPC objects
    logQueue = xQueueCreate(4, sizeof(SensorSnapshot));
    snapshotMutex = xSemaphoreCreateMutex();

    if (logQueue == nullptr || snapshotMutex == nullptr) {
        Serial.println("[FATAL] Gagal membuat queue/mutex");
        while (true) {
            delay(1000);
        }
    }

    memset(&latestSnapshot, 0, sizeof(latestSnapshot));

    // WiFi + MQTT (non-blocking, koneksi diurus mqttTask)
    WiFi.mode(WIFI_STA);
    WiFi.setAutoReconnect(true);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

    buildTopics();

    mqttClient.setServer(MQTT_HOST, MQTT_PORT);
    mqttClient.setBufferSize(768);
    mqttClient.setKeepAlive(30);
    mqttClient.setSocketTimeout(3);

    // Tasks
    xTaskCreatePinnedToCore(
        sensorTask, "SensorTask", SENSOR_TASK_STACK,
        nullptr, 3, &sensorTaskHandle, 1
    );

    xTaskCreatePinnedToCore(
        loggerTask, "LoggerTask", LOGGER_TASK_STACK,
        nullptr, 1, &loggerTaskHandle, 0
    );

    xTaskCreatePinnedToCore(
        mqttTask, "MqttTask", MQTT_TASK_STACK,
        nullptr, 2, &mqttTaskHandle, 0
    );

    // Hardware timer dimulai TERAKHIR
    #if ESP_ARDUINO_VERSION_MAJOR >= 3
    samplingTimer = timerBegin(1000000);
    timerAttachInterrupt(samplingTimer, &onTimerInterrupt);
    timerAlarm(samplingTimer, TIMER_PERIOD_US, true, 0);
    #else
    samplingTimer = timerBegin(0, 80, true);
    timerAttachInterrupt(samplingTimer, &onTimerInterrupt, true);
    timerAlarmWrite(samplingTimer, TIMER_PERIOD_US, true);
    timerAlarmEnable(samplingTimer);
    #endif

    Serial.println();
    Serial.println("ADVANCED SENSOR SYSTEM + MQTT STARTED");
    Serial.printf("Broker   : %s:%d\n", MQTT_HOST, MQTT_PORT);
    Serial.printf("Client   : %s\n", mqttClientId);
    Serial.printf("Topic    : %s/#\n", TOPIC_BASE);
    Serial.println("Watchdog : ENABLED (sensor + logger)");
}

void loop() {

    vTaskDelay(portMAX_DELAY);
}
