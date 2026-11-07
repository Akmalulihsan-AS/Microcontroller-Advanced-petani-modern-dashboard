# Petani Modern — Dashboard Smart Farming

Dashboard web untuk program ESP32 yang dilampirkan. Menggunakan MQTT untuk menerima data, Express sebagai backend, dan SQLite untuk menyimpan histori.

## Fitur
- 4 gauge: cahaya (BH1750), kelembapan tanah (ADC terkalibrasi), suhu (MAX6675), tinggi tanaman (hasil kalkulasi sensor ultrasonik).
- Jam real-time, tema gelap/terang, status koneksi, dan alarm terbaru.
- Data historis, grafik Chart.js, tabel, dan ekspor CSV.
- Filter histori 1 jam, 6 jam, 24 jam, dan 7 hari; statistik minimum, maksimum, dan rata-rata dihitung dari seluruh data pada rentang terpilih (grafik memakai sampling agar tetap ringan).
- Riwayat alarm dengan fitur tandai telah ditinjau.
- Status perangkat dan jaringan berdasarkan topic `status` serta `diagnostics`.
- Penyimpanan lokal SQLite (`smartfarm.db` dibuat otomatis).

## 1. Persiapan
Install **Node.js versi LTS** (disarankan Node 20 atau lebih baru). Ekstrak ZIP ini, lalu buka terminal di folder `petani_modern_dashboard`.

Jalankan:
```bash
npm install
npm start
```
Buka browser: `http://localhost:3000`

Untuk mode pengembangan:
```bash
npm run dev
```

## 2. Library yang perlu di-install
Perintah `npm install` memasang:
- `express` — web server dan REST API.
- `mqtt` — koneksi MQTT dari backend ke broker EMQX.
- `better-sqlite3` — database SQLite lokal.

Chart memakai Chart.js melalui CDN, jadi browser perlu akses internet saat memuat library tersebut. Google Fonts juga dimuat dari internet; dashboard tetap berfungsi dengan font cadangan bila gagal.

## 3. Kesesuaian dengan firmware ESP32
Default konfigurasi server:
- Broker: `mqtt://broker.emqx.io:1883`
- Device ID: `petani-modern`
- Subscribe: `smartfarm/petani-modern/#`

Topic yang dibaca:
- `smartfarm/petani-modern/telemetry` — JSON data sensor
- `smartfarm/petani-modern/status` — `online` / `offline`
- `smartfarm/petani-modern/diagnostics` — JSON diagnostik

Nama field JSON telemetry sesuai firmware:
`temperature_c`, `soil_moisture_pct`, `light_lux`, `plant_height_cm`, `distance_cm`, `soil_adc`, dan `sensor_status`.

**PENTING:** Samakan `DEVICE_ID` pada firmware dengan backend. Jika mengganti ID di firmware, jalankan backend dengan environment variable:
```powershell
$env:DEVICE_ID="id-perangkatmu"
npm start
```
Atau ubah default `DEVICE_ID` di `server.js`.

## 4. Catatan data dan kalibrasi
- Firmware mengirim telemetry setiap 2 detik. Backend menyimpan setiap pesan telemetry yang diterima ke SQLite.
- Data hanya mulai muncul setelah ESP32 berhasil tersambung ke Wi-Fi, broker, dan mengirim topic telemetry.
- Batas alarm awal: kelembapan tanah di bawah 30% dan suhu di atas 35°C, ditambah status sensor `DEGRADED` / `FAULT`. Batas tersebut masih nilai awal, bukan rekomendasi universal untuk semua tanaman. Sesuaikan di fungsi `processTelemetry()` dalam `server.js`.
- Rentang gauge tampilan: cahaya 0–20.000 lux, tanah 0–100%, suhu 0–60°C, tinggi 0–100 cm. Ubah `max` di `public/app.js` bila perlu.
- Tinggi tanaman berasal dari `SENSOR_MOUNT_HEIGHT_CM - distance_cm`; pastikan tinggi pemasangan sensor pada firmware sudah dikalibrasi.
- SQLite tersimpan di `smartfarm.db` dalam folder proyek. Jangan menghapus file ini jika histori ingin dipertahankan.

## 5. Akses dari HP / perangkat lain
Laptop dan HP harus berada pada jaringan Wi-Fi yang sama. Jalankan server di laptop, lalu cari IP laptop (misalnya `ipconfig` di Windows) dan buka:
`http://IP-LAPTOP:3000`

Pastikan Windows Firewall mengizinkan Node.js / port TCP 3000 pada jaringan Private. Jangan gunakan `localhost` dari HP karena itu menunjuk ke HP itu sendiri.

## 6. Keamanan
`broker.emqx.io` adalah broker publik. Topic yang dipublikasikan dapat dibaca pihak lain dan bentrok jika Device ID tidak unik. Untuk penggunaan serius, gunakan broker pribadi dengan autentikasi/TLS, ACL, dan kredensial yang tidak dibagikan. Jangan expose server dashboard ke internet tanpa autentikasi.
