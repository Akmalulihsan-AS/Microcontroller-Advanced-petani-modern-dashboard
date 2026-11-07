const $ = id => document.getElementById(id);
const state = { readings: [], alarms: [], latest: null, device: null, charts: {}, historyRange: "24h", historyRows: [], historyStats: null };
const fields = {
  light: {canvas:"gaugeLight", value:"lightValue", state:"lightState", key:"light_lux", max:20000, color:"#269455", decimals:0},
  soil: {canvas:"gaugeSoil", value:"soilValue", state:"soilState", key:"soil_moisture", max:100, color:"#4d89c8", decimals:1},
  temp: {canvas:"gaugeTemp", value:"tempValue", state:"tempState", key:"temperature", max:60, color:"#d98a32", decimals:1},
  height: {canvas:"gaugeHeight", value:"heightValue", state:"heightState", key:"plant_height", max:100, color:"#8b71bd", decimals:1}
};
function fmt(v,d=1){return v===null||v===undefined||!Number.isFinite(Number(v))?"--":Number(v).toFixed(d)}
function drawGauge(canvasId,value,max,color){
  const c=$(canvasId); if(!c)return; const ctx=c.getContext("2d"),w=c.width,h=c.height;
  ctx.clearRect(0,0,w,h); const cx=w/2,cy=h*.86,r=Math.min(w*.39,h*.72);
  ctx.lineWidth=13;ctx.lineCap="round";ctx.beginPath();ctx.arc(cx,cy,r,Math.PI,Math.PI*2);ctx.strokeStyle=document.body.classList.contains("dark")?"#354139":"#edf1ed";ctx.stroke();
  if(value!==null&&Number.isFinite(Number(value))){const ratio=Math.max(0,Math.min(1,Number(value)/max));ctx.beginPath();ctx.arc(cx,cy,r,Math.PI,Math.PI+Math.PI*ratio);ctx.strokeStyle=color;ctx.stroke()}
}
function setGauge(name,value,status){
  const f=fields[name]; $(f.value).textContent=fmt(value,f.decimals); $(f.state).textContent=status||"INIT";
  $(f.state).style.color=status==="OK"?"var(--green)":status==="FAULT"?"var(--red)":status==="DEGRADED"?"var(--orange)":"var(--muted)";
  drawGauge(f.canvas,value,f.max,f.color);
}
function navigate(page){
  document.querySelectorAll(".page").forEach(p=>p.classList.toggle("active",p.id===`page-${page}`));
  document.querySelectorAll(".nav-link").forEach(b=>b.classList.toggle("active",b.dataset.page===page));
  const names={home:"DASHBOARD",data:"DATA & ANALITIK",alarms:"RIWAYAT ALARM",device:"PERANGKAT & JARINGAN"};
  $("crumbName").textContent=names[page];$("sidebar").classList.remove("open");
  if(page==="data")renderData(); if(page==="alarms")renderAlarms();
}
document.querySelectorAll(".nav-link").forEach(b=>b.addEventListener("click",()=>navigate(b.dataset.page)));
document.querySelectorAll("[data-goto]").forEach(b=>b.addEventListener("click",()=>navigate(b.dataset.goto)));
$("menuBtn").addEventListener("click",()=>$("sidebar").classList.toggle("open"));
$("themeBtn").addEventListener("click",()=>{document.body.classList.toggle("dark");$("themeBtn").textContent=document.body.classList.contains("dark")?"☀":"☾";Object.keys(fields).forEach(k=>{const f=fields[k];drawGauge(f.canvas,state.latest?.[f.key],f.color)});Object.values(state.charts).forEach(c=>c&&c.update())});
function tickClock(){const d=new Date();$("clock").textContent=d.toLocaleTimeString("id-ID",{hour12:false});$("topDate").textContent=d.toLocaleDateString("id-ID",{weekday:"long",day:"numeric",month:"long",year:"numeric"})}
setInterval(tickClock,1000);tickClock();
function chartOptions(){return {responsive:true,maintainAspectRatio:false,interaction:{intersect:false,mode:"index"},plugins:{legend:{display:false}},scales:{x:{grid:{display:false},ticks:{color:"#8b968d",maxTicksLimit:7,font:{size:9}}},y:{grid:{color:document.body.classList.contains("dark")?"#344139":"#edf1ed"},ticks:{color:"#8b968d",font:{size:9}}}}}}
function makeChart(id,key){
  const el=$(id);if(!el||!window.Chart)return null;
  if(state.charts[id])state.charts[id].destroy();
  const rows=state.readings.slice(-80);
  state.charts[id]=new Chart(el,{type:"line",data:{labels:rows.map(r=>new Date(r.timestamp).toLocaleTimeString("id-ID",{hour:"2-digit",minute:"2-digit",second:"2-digit"})),datasets:[{data:rows.map(r=>r[key]),borderColor:"#269455",backgroundColor:"rgba(38,148,85,.10)",fill:true,tension:.35,pointRadius:0,spanGaps:true,borderWidth:2}]},options:chartOptions()});
}

function sensorUnit(key){return key==="temperature"?"°C":key==="soil_moisture"?"%":key==="light_lux"?"lux":"cm"}
function sensorLabel(key){return key==="temperature"?"Suhu":key==="soil_moisture"?"Kelembapan tanah":key==="light_lux"?"Intensitas cahaya":"Tinggi tanaman"}
function showStat(value,key){
  if(value===null||value===undefined||!Number.isFinite(Number(value)))return "—";
  const d=key==="light_lux"?0:1;
  return `${Number(value).toFixed(d)} ${sensorUnit(key)}`;
}
function renderHistoryStats(){
  const key=$("dataChartSelect").value, s=state.historyStats||{};
  $("historyMin").textContent=showStat(s[`${key}_min`],key);
  $("historyMax").textContent=showStat(s[`${key}_max`],key);
  $("historyAvg").textContent=showStat(s[`${key}_avg`],key);
  $("historyCount").textContent=`${Number(s.total||0).toLocaleString("id-ID")} rekaman dalam ${({ "1h":"1 jam","6h":"6 jam","24h":"24 jam","7d":"7 hari" })[state.historyRange]}`;
}
function makeHistoryChart(){
  const el=$("dataChart");if(!el||!window.Chart)return;
  if(state.charts.dataChart)state.charts.dataChart.destroy();
  const key=$("dataChartSelect").value, rows=state.historyRows||[];
  state.charts.dataChart=new Chart(el,{type:"line",data:{
    labels:rows.map(r=>new Date(r.timestamp).toLocaleString("id-ID",{day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"})),
    datasets:[{label:sensorLabel(key),data:rows.map(r=>r[key]),borderColor:"#269455",backgroundColor:"rgba(38,148,85,.10)",fill:true,tension:.28,pointRadius:0,spanGaps:true,borderWidth:2}]
  },options:chartOptions()});
  renderHistoryStats();
}
async function loadHistory(){
  const result=await getJSON(`/api/history?range=${state.historyRange}`);
  state.historyRows=result.rows||[];state.historyStats=result.stats||{};
  makeHistoryChart();
}
function updateCharts(){makeChart("homeChart",$("homeChartSelect").value);if($("page-data").classList.contains("active"))loadHistory().catch(console.error)}
$("homeChartSelect").addEventListener("change",()=>makeChart("homeChart",$("homeChartSelect").value));
$("dataChartSelect").addEventListener("change",()=>{if($("page-data").classList.contains("active"))makeHistoryChart();});
document.querySelectorAll(".range-btn").forEach(b=>b.addEventListener("click",()=>{state.historyRange=b.dataset.range;document.querySelectorAll(".range-btn").forEach(x=>x.classList.toggle("active",x===b));loadHistory().catch(console.error)}));
async function getJSON(url){const r=await fetch(url);if(!r.ok)throw Error("HTTP "+r.status);return r.json()}
async function refresh(){
 try{
  const [latest,readings,alarms,health]=await Promise.all([getJSON("/api/latest"),getJSON("/api/readings?limit=500"),getJSON("/api/alarms?limit=200"),getJSON("/api/health")]);
  state.latest=latest.data;state.device=latest.device;state.readings=readings;state.alarms=alarms;
  $("mqttDot").className="dot "+(health.mqtt?"online":"offline");$("mqttLabel").textContent=health.mqtt?"MQTT Terhubung":"MQTT Terputus";
  if(state.latest){
    const r=state.latest;
    setGauge("light",r.light_lux,r.light_status);setGauge("soil",r.soil_moisture,r.soil_status);setGauge("temp",r.temperature,r.temp_status);setGauge("height",r.plant_height,r.height_status);
    $("lastUpdate").textContent=new Date(r.timestamp).toLocaleTimeString("id-ID");
  }
  renderDevice(health);renderLatestAlarms();$("alarmBadge").textContent=alarms.filter(a=>!a.acknowledged).length;
  if($("page-data").classList.contains("active"))renderData();
 }catch(e){console.error(e)}
}
function renderLatestAlarms(){
 const box=$("latestAlarmList"),items=state.alarms.slice(0,4);
 box.innerHTML=items.length?items.map(a=>`<div class="compact-alarm"><span class="alarm-marker ${a.severity}"></span><div><b>${esc(a.sensor)}</b><p>${esc(a.message)}</p></div><time>${timeAgo(a.timestamp)}</time></div>`).join(""):'<div class="empty">Belum ada alarm.</div>';
}
function renderDevice(health){
 const d=state.device||{},online=d.status==="online"&&health.mqtt;
 $("homeDevice").textContent=online?"Online":"Offline";$("homeDeviceDot").className="dot "+(online?"online":"offline");
 $("devicePill").textContent=online?"ONLINE":"OFFLINE";$("devicePill").className="status-pill "+(online?"online":"offline");
 $("deviceStatusText").textContent=online?"ESP32 aktif dan mengirimkan data.":"Belum menerima status online dari ESP32.";
 $("deviceIp").textContent=d.ip||"—";$("deviceRssi").textContent=d.rssi==null?"—":`${d.rssi} dBm`;
 $("brokerStatus").textContent=health.mqtt?"Terhubung":"Terputus";$("firmware").textContent=d.firmware||"—";
 $("uptime").textContent=d.uptime_s==null?"—":formatUptime(d.uptime_s);$("heap").textContent=d.free_heap==null?"—":`${(d.free_heap/1024).toFixed(1)} KB`;
 $("reconnects").textContent=d.mqtt_reconnects??"—";$("publishFail").textContent=d.mqtt_publish_fail??"—";$("missedTicks").textContent=d.missed_ticks??"—";$("maxCycle").textContent=d.max_cycle_us==null?"—":`${d.max_cycle_us} µs`;
}
function renderData(){
 const rows=state.readings.slice().reverse();$("totalRows").textContent=state.readings.length.toLocaleString("id-ID");
 $("dataRange").textContent=rows.length?new Date(rows[rows.length-1].timestamp).toLocaleDateString("id-ID"):"—";
 $("readingsTable").innerHTML=rows.slice(0,100).map(r=>`<tr><td>${new Date(r.timestamp).toLocaleString("id-ID")}</td><td>${fmt(r.temperature)}</td><td>${fmt(r.soil_moisture)}</td><td>${fmt(r.light_lux,0)}</td><td>${fmt(r.plant_height)}</td><td><span class="table-status">${[r.temp_status,r.soil_status,r.light_status,r.height_status].every(s=>s==="OK")?"NORMAL":"PERIKSA"}</span></td></tr>`).join("")||'<tr><td colspan="6" class="empty">Belum ada data sensor.</td></tr>';
 loadHistory().catch(console.error);
}
$("refreshData").addEventListener("click",refresh);
$("alarmFilter").addEventListener("change",renderAlarms);
function renderAlarms(){
 const filter=$("alarmFilter").value,items=state.alarms.filter(a=>filter==="all"||a.severity===filter);
 $("alarmTotal").textContent=state.alarms.length;$("alarmPending").textContent=state.alarms.filter(a=>!a.acknowledged).length;$("alarmCritical").textContent=state.alarms.filter(a=>a.severity==="danger").length;
 $("alarmFullList").innerHTML=items.map(a=>`<div class="alarm-row"><div class="alarm-symbol ${a.severity}">${a.severity==="danger"?"!":"⚑"}</div><div class="alarm-content"><b>${esc(a.sensor)} · ${a.severity==="danger"?"Kritis":"Peringatan"}</b><p>${esc(a.message)}</p><time>${new Date(a.timestamp).toLocaleString("id-ID")}</time></div>${a.acknowledged?'<span class="ack-label">Ditinjau ✓</span>':`<button data-ack="${a.id}">Tandai ditinjau</button>`}</div>`).join("")||'<div class="empty">Tidak ada alarm untuk filter ini.</div>';
 document.querySelectorAll("[data-ack]").forEach(b=>b.addEventListener("click",async()=>{await fetch(`/api/alarms/${b.dataset.ack}/ack`,{method:"POST"});await refresh();renderAlarms()}));
}
function esc(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
function timeAgo(t){const sec=Math.max(0,Math.floor((Date.now()-new Date(t).getTime())/1000));return sec<60?`${sec} dtk lalu`:sec<3600?`${Math.floor(sec/60)} mnt lalu`:`${Math.floor(sec/3600)} jam lalu`}
function formatUptime(s){const h=Math.floor(s/3600),m=Math.floor(s%3600/60);return `${h}j ${m}m`}
refresh();setInterval(refresh,2000);


async function loadSensorHistory() {
    try {
        const response = await fetch("/api/history?limit=50");

        if (!response.ok) {
            throw new Error("Gagal mengambil histori");
        }

        const result = await response.json();

        console.log("Histori sensor:", result.data);

        // Data histori siap digunakan
        // untuk grafik dashboard.

        return result.data;

    } catch (error) {
        console.error("History error:", error);
        return [];
    }
}

async function saveSensorData(data) {
    try {
        const response = await fetch("/api/sensor", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(data)
        });

        const result = await response.json();

        console.log("Penyimpanan:", result);

        return result;

    } catch (error) {
        console.error("Gagal menyimpan:", error);
    }
}

// Ambil histori saat dashboard dibuka
loadSensorHistory();

const MQTT_BASE = "smartfarm/petani-modern/";

client.on("message", async (topic, message) => {
    try {
        const payloadText = message.toString();

        let payload;

        try {
            payload = JSON.parse(payloadText);
        } catch {
            payload = payloadText;
        }

        // Hanya kirim topic yang dibutuhkan
        const allowedTopics = [
            MQTT_BASE + "telemetry",
            MQTT_BASE + "diagnostics",
            MQTT_BASE + "status"
        ];

        if (!allowedTopics.includes(topic)) {
            return;
        }

        console.log("MQTT DITERIMA:", topic, payload);

        // Kirim data ke Cloudflare Pages Functions
        const response = await fetch("/api/sensor", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                topic: topic,
                payload: payload
            })
        });

        const result = await response.json();

        if (!response.ok) {
            throw new Error(result.error || "Gagal menyimpan data");
        }

        console.log("BERHASIL DIKIRIM KE API:", result);

        // Perbarui dashboard setelah telemetry tersimpan
        if (topic === MQTT_BASE + "telemetry") {
            if (typeof refresh === "function") {
                await refresh();
            }
        }

    } catch (error) {
        console.error("GAGAL MENGIRIM MQTT KE WEB:", error);
    }
});

