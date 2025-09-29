import { getStore } from "@netlify/blobs";

// === ENV ===
const {
  BUS_ENDPOINT = "https://zn5.m2mcontrol.com.br/api/forecast/lines/load/forecast/lines/fromPoint/242089/1343",
  LINE_REGEX = "^A108$",
  AUTH_USER = "mobile.m2m",
  AUTH_PASS = "m2m",
  TG_TOKEN,
  TG_CHAT,
  FIXED_LAT = "10.3763016",
  FIXED_LON = "-75.4999534",
  NEAR_RADIUS_M = "1000",
  POLL_TIMEOUT_MS = "10000",
  PER_BUS_COOLDOWN_MS = String(2 * 60 * 1000),
  NEAR_COOLDOWN_MS = String(10 * 60 * 1000)
} = process.env;

const LINE_RE = new RegExp(LINE_REGEX);
const store = getStore({ name: "bus-state" });

function okNum(n){ const v=Number(n); return Number.isFinite(v)?v:null; }
function distM(lat1, lon1, lat2, lon2){
  const R=6371000, toRad=d=>d*Math.PI/180;
  const dLat=toRad(lat2-lat1), dLon=toRad(lon2-lon1);
  const a=Math.sin(dLat/2)**2+Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(a));
}

async function fetchJSON(url){
  const ctrl = new AbortController();
  const t = setTimeout(()=>ctrl.abort(), Math.max(3000, Number(POLL_TIMEOUT_MS)));
  try{
    const headers = { "Accept":"application/json" };
    if (AUTH_USER || AUTH_PASS){
      headers.Authorization = "Basic " + Buffer.from(`${AUTH_USER}:${AUTH_PASS}`).toString("base64");
    }
    const r = await fetch(url, { headers, signal: ctrl.signal });
    const text = await r.text();
    let json; try{ json = JSON.parse(text); }catch{ json = { raw:text }; }
    if(!r.ok) throw new Error((json && (json.message||json.error)) || `HTTP ${r.status}`);
    return json;
  } finally { clearTimeout(t); }
}

// Normalizador → [{id, route, lat, lon, updated_at}]
function transform(json){
  if (Array.isArray(json) && json.length && json[0]?.latLng?.lat !== undefined){
    return json.map(v=>({
      id:String(v.codVehicle ?? v.idVeiculo ?? v.busServiceId ?? v.cod ?? "?"),
      route:v.busServiceNumber ?? v.numero ?? v.line ?? v.route ?? null,
      lat:okNum(v.latLng.lat), lon:okNum(v.latLng.lng),
      updated_at:v.timestamp ?? v.gps_datetime ?? v.updated_at ?? null
    })).filter(x=>x.lat!=null&&x.lon!=null);
  }
  if (Array.isArray(json) && json.length && json[0]?.lat !== undefined) return json;
  if (json && Array.isArray(json.data)){
    return json.data.map(v=>({
      id:String(v.id ?? v.code ?? v.vehicleId ?? v.bus ?? "?"),
      route:v.numero ?? v.line ?? v.route ?? v.name ?? v.nome ?? null,
      lat:okNum(v.lat ?? v.latitude ?? v.gps_latitude ?? v.LATITUDE),
      lon:okNum(v.lon ?? v.lng ?? v.longitude ?? v.gps_longitude ?? v.LONGITUDE),
      updated_at:v.timestamp ?? v.updated_at ?? v.gps_datetime ?? v.datetime ?? v.DATAHORA ?? null
    })).filter(x=>x.lat!=null&&x.lon!=null);
  }
  if (json && (json.lines || json.forecast || json.previsoes)){
    const arr = (json.lines ?? json.forecast ?? json.previsoes ?? []);
    const items=[];
    (Array.isArray(arr)?arr:[arr]).forEach(L=>{
      const route = L.numero ?? L.line ?? L.route ?? L.name ?? L.nome ?? null;
      const vehs = L.vehicles ?? L.veiculos ?? L.buses ?? [];
      (Array.isArray(vehs)?vehs:[vehs]).forEach(v=>{
        const lat=okNum(v.lat ?? v.latitude ?? v.gps_latitude);
        const lon=okNum(v.lon ?? v.lng ?? v.longitude ?? v.gps_longitude);
        if(lat!=null && lon!=null){
          items.push({
            id:String(v.id ?? v.code ?? v.vehicleId ?? v.bus ?? "?"),
            route, lat, lon,
            updated_at:v.timestamp ?? v.gps_datetime ?? v.updated_at ?? null
          });
        }
      });
    });
    return items;
  }
  return [];
}

async function sendTG(text){
  if (!TG_TOKEN || !TG_CHAT) return { ok:false, err:"no_token_or_chat" };
  const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage?chat_id=${encodeURIComponent(TG_CHAT)}&text=${encodeURIComponent(text)}`;
  try { await fetch(url); return { ok:true }; }
  catch(e){ return { ok:false, err:String(e) }; }
}

async function getState(){
  return (await store.get("state", { type:"json" })) ?? { seenIds:[], lastNearAt:{}, lastDepartAt:{} };
}
async function setState(s){ await store.setJSON("state", s); }

export const handler = async () => {
  try{
    const json = await fetchJSON(BUS_ENDPOINT);
    let items = transform(json).filter(b => !b.route || LINE_RE.test(String(b.route)));

    const state = await getState();
    const seenPrev = new Set(state.seenIds || []);
    const lastDepartAt = state.lastDepartAt || {};
    const lastNearAt   = state.lastNearAt   || {};
    const now = Date.now();
    const msgs = [];

    // 1) “Ya salió” por bus nuevo
    const seenNow = new Set(items.map(b => String(b.id)));
    seenNow.forEach(id=>{
      if (!seenPrev.has(id)){
        const last = Number(lastDepartAt[id] || 0);
        if (now - last > Number(PER_BUS_COOLDOWN_MS)){
          msgs.push(`Ya salió el bus A108 (${id})`);
          lastDepartAt[id] = now;
        }
      }
    });

    // 2) “Cerca (≤1 km)” respecto al punto fijo
    const refLat = Number(FIXED_LAT), refLon = Number(FIXED_LON);
    const radius = Number(NEAR_RADIUS_M);
    for (const b of items){
      const id = String(b.id);
      const d = distM(b.lat, b.lon, refLat, refLon);
      const wasIn = state[`in_${id}`] === true;
      const isIn = d <= radius;
      if (!wasIn && isIn){
        const last = Number(lastNearAt[id] || 0);
        if (now - last > Number(NEAR_COOLDOWN_MS)){
          msgs.push(`El bus A108 (${id}) está por el Campestre (≤1 km).`);
          lastNearAt[id] = now;
        }
      }
      state[`in_${id}`] = isIn;
    }

    for (const m of msgs) await sendTG(m);

    state.seenIds = Array.from(seenNow);
    state.lastDepartAt = lastDepartAt;
    state.lastNearAt = lastNearAt;
    await setState(state);

    return { statusCode:200, body: JSON.stringify({ ok:true, total:items.length, sent:msgs.length }) };
  }catch(e){
    return { statusCode:500, body: JSON.stringify({ ok:false, error:String(e) }) };
  }
};
