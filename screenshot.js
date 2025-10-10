// STRATZ meta -> viac fallbackov + diagnostika -> HTML -> screenshot -> Discord
import { chromium } from "playwright";
import fs from "node:fs";

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const STRATZ_TOKEN = process.env.STRATZ_TOKEN;

const ROLES = ["safe", "mid", "off", "soft", "hard"];
const ROLE_TO_POSITION = { safe: 1, mid: 2, off: 3, soft: 4, hard: 5 };
const RANK = "IMMORTAL";
const LIMIT = 10;
const MIN_MATCHES = 30;

const CDN = "https://cdn.cloudflare.steamstatic.com";
const OD_HEROES = "https://api.opendota.com/api/constants/heroes";
const STRATZ_GQL = "https://api.stratz.com/graphql";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function startOfUtcDay(d=new Date()) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
function rangeMs(daysBack=1){ // včera = 1
  const todayUtc = startOfUtcDay();
  const startMs = todayUtc.getTime() - daysBack*24*3600*1000;
  const endMs   = todayUtc.getTime() - 1;
  const label = new Date(startMs).toISOString().slice(0,10);
  return { startMs, endMs, label };
}

async function fetchJSON(url, opts = {}) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}
async function getHeroMap() {
  const data = await fetchJSON(OD_HEROES, { cache: "no-store" });
  const map = new Map();
  for (const [id, h] of Object.entries(data)) {
    const short = h.name?.replace("npc_dota_hero_", "");
    map.set(Number(id), {
      name: h.localized_name || short?.replaceAll("_"," ") || h.name,
      img: short ? `${CDN}/apps/dota2/images/heroes/${short}_full.png` : null
    });
  }
  return map;
}
function topRows(rows, limit) {
  const total = rows.reduce((a,b)=>a+(b.matchCount||0),0) || 1;
  return rows
    .map(r => ({
      id: r.heroId,
      matches: r.matchCount || 0,
      wins: r.winCount || 0,
      wr: r.matchCount ? r.winCount / r.matchCount : 0,
      pick: (r.matchCount / total) * 100
    }))
    .filter(r => r.matches >= MIN_MATCHES)
    .sort((a,b)=> b.wr - a.wr)
    .slice(0, limit);
}

// --- 4 query šablóny (ranked/unranked + ms/sekundy) ---
const Q_R_MS = `
  query Q($from: Long!, $to: Long!, $rank: RankBracketType!, $pos: PositionType!) {
    heroPerformance(request:{ dateTime:{min:$from,max:$to}, rankBracket:[$rank], positions:[$pos], lobbyTypeIds:[7], isParsed:true }) {
      heroId winCount matchCount
    }
  }`;
const Q_U_MS = `
  query Q($from: Long!, $to: Long!, $rank: RankBracketType!, $pos: PositionType!) {
    heroPerformance(request:{ dateTime:{min:$from,max:$to}, rankBracket:[$rank], positions:[$pos], isParsed:true }) {
      heroId winCount matchCount
    }
  }`;
const Q_R_S  = `
  query Q($from: Long!, $to: Long!, $rank: RankBracketType!, $pos: PositionType!) {
    heroPerformance(request:{ dateTime:{min:$from,max:$to}, rankBracket:[$rank], positions:[$pos], lobbyTypeIds:[7], isParsed:true }) {
      heroId winCount matchCount
    }
  }`;

// varianty: názov, query, prevod času, daysBack, ranked?
const VARIANTS = [
  { key:'R-1d-ms', q:Q_R_MS, ms:true,  days:1, ranked:true },
  { key:'U-1d-ms', q:Q_U_MS, ms:true,  days:1, ranked:false },
  { key:'R-1d-s',  q:Q_R_S,  ms:false, days:1, ranked:true  },
  { key:'U-3d-ms', q:Q_U_MS, ms:true,  days:3, ranked:false },
  { key:'U-7d-ms', q:Q_U_MS, ms:true,  days:7, ranked:false },
  { key:'U-14d-ms',q:Q_U_MS, ms:true,  days:14,ranked:false },
];

async function tryVariant(role, rank, variant) {
  const pos = ROLE_TO_POSITION[role] ?? 2;
  const { startMs, endMs } = rangeMs(variant.days);
  const from = variant.ms ? startMs : Math.floor(startMs/1000);
  const to   = variant.ms ? endMs   : Math.floor(endMs/1000);

  const res = await fetch(STRATZ_GQL, {
    method: "POST",
    headers: {
      "Content-Type":"application/json",
      "Accept":"application/json",
      "Authorization":`Bearer ${STRATZ_TOKEN}`,
      "Origin":"https://stratz.com",
      "Referer":"https://stratz.com/",
      "User-Agent":"DotaMetaBot/1.0"
    },
    body: JSON.stringify({ query: variant.q, variables: { from, to, rank, pos } })
  });

  let rows = [];
  let error = null;
  try {
    if (!res.ok) {
      error = `HTTP ${res.status}`;
    } else {
      const body = await res.json();
      if (body?.errors?.length) error = JSON.stringify(body.errors[0]);
      rows = body?.data?.heroPerformance || [];
    }
  } catch (e) {
    error = e?.message || String(e);
  }

  return { key: variant.key, count: rows?.length || 0, rows, error };
}

function htmlTemplate(label, sections, heroes, diagText) {
  const css = `
    body { background:#0b0e13; color:#e6e9ef; font:14px/1.4 Inter,system-ui,Segoe UI,Roboto,Arial; padding:24px; }
    h1 { margin:0 0 12px; font-size:20px; }
    .grid { display:grid; grid-template-columns:repeat(2, minmax(0,1fr)); gap:16px; }
    .card { background:#12161d; border:1px solid #202533; border-radius:12px; padding:12px; }
    .title { font-weight:600; margin-bottom:8px; }
    table { width:100%; border-collapse:collapse; }
    th, td { padding:6px 8px; }
    th { text-align:left; color:#93a0b4; font-weight:600; font-size:12px; border-bottom:1px solid #202533; }
    td { border-bottom:1px dashed #1c2230; vertical-align:middle; }
    tr:last-child td { border-bottom:none; }
    .hero { display:flex; align-items:center; gap:8px; }
    .hero img { width:28px; height:16px; border-radius:3px; object-fit:cover; }
    .wr.good { color:#3ddc97; font-weight:700; }
    .wr.bad { color:#ef4444; font-weight:700; }
    footer { margin-top:12px; color:#93a0b4; font-size:12px; white-space:pre-wrap; }
    .muted { color:#93a0b4; font-size:12px; margin-bottom:8px; }
  `;
  const roleName = r => ({safe:"Safe Lane",mid:"Mid",off:"Offlane",soft:"Soft Support",hard:"Hard Support"})[r]||r;

  const makeTable = (role, rows) => {
    const trs = rows.map((r,i)=>{
      const h = heroes.get(r.id) || {};
      const wr = (r.wr*100).toFixed(1);
      const pick = Math.round(r.pick);
      const cls = r.wr >= 0.5 ? "wr good" : "wr bad";
      return `
        <tr>
          <td style="width:34px">${String(i+1).padStart(2," ")}</td>
          <td><div class="hero">${h.img?`<img src="${h.img}" alt="${h.name}">`:``}<span>${h.name||("Hero "+r.id)}</span></div></td>
          <td class="${cls}">${wr}%</td>
          <td>${pick}%</td>
          <td style="text-align:right">${r.matches.toLocaleString("en-US")}</td>
        </tr>`;
    }).join("");
    return `
      <div class="card">
        <div class="title">${roleName(role)}</div>
        <table>
          <thead><tr><th>#</th><th>Hero</th><th>WR</th><th>Pick</th><th style="text-align:right">Games</th></tr></thead>
          <tbody>${trs || `<tr><td colspan="5">No data</td></tr>`}</tbody>
        </table>
      </div>`;
  };

  const columns = sections.map(s => makeTable(s.role, s.rows)).join("");
  return `
  <html><head><meta charset="utf-8"><style>${css}</style></head>
  <body>
    <h1>STRATZ META • ${label} • ${RANK.charAt(0)+RANK.slice(1).toLowerCase()}</h1>
    <div class="muted">${diagText}</div>
    <div class="grid">${columns}</div>
    <footer>Data: STRATZ GraphQL • generated automatically.\n${diagText}</footer>
  </body></html>`;
}

async function main() {
  if (!DISCORD_WEBHOOK_URL) throw new Error("Missing DISCORD_WEBHOOK_URL");
  if (!STRATZ_TOKEN) throw new Error("Missing STRATZ_TOKEN");

  const { label } = rangeMs(1); // pre titulok
  const heroes = await getHeroMap();

  // pre každú rolu vyber prvý „úspešný“ variant + zbieraj diagnostiku
  const diagLines = [];
  const sections = [];
  for (const role of ROLES) {
    let picked = null;
    for (const v of VARIANTS) {
      const out = await tryVariant(role, RANK, v);
      diagLines.push(`${role.padEnd(4)} • ${out.key.padEnd(7)} • count=${String(out.count).padStart(3)}${out.error?` • err=${out.error}`:''}`);
      if (out.count > 0) { picked = { role, rows: topRows(out.rows, LIMIT) }; break; }
      await sleep(120);
    }
    sections.push(picked || { role, rows: [] });
  }

  const diagText = diagLines.join('\n');
  const html = htmlTemplate(label, sections, heroes, diagText);

  // render -> screenshot
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1500 } });
  const page = await ctx.newPage();
  await page.setContent(html, { waitUntil: "load" });
  const path = "meta.png";
  await page.screenshot({ path, type: "png", fullPage: true });
  await browser.close();

  // send to discord
  const buf = fs.readFileSync(path);
  const form = new FormData();
  form.append("payload_json", JSON.stringify({
    username: "Dota META",
    embeds: [{ title: `STRATZ Meta — ${label} — ${RANK}`, image: { url: "attachment://meta.png" } }]
  }));
  form.append("file", new Blob([buf], { type: "image/png" }), "meta.png");
  const res = await fetch(DISCORD_WEBHOOK_URL, { method: "POST", body: form });
  if (!res.ok) throw new Error(`Discord webhook failed: ${res.status} ${await res.text().catch(()=> "")}`);
}

// --- helpers pre diagnostiku ---
async function tryVariant(role, rank, v) {
  const { startMs, endMs } = rangeMs(v.days);
  const from = v.ms ? startMs : Math.floor(startMs/1000);
  const to   = v.ms ? endMs   : Math.floor(endMs/1000);
  try {
    const res = await fetch(STRATZ_GQL, {
      method: "POST",
      headers: {
        "Content-Type":"application/json",
        "Accept":"application/json",
        "Authorization":`Bearer ${STRATZ_TOKEN}`,
        "Origin":"https://stratz.com",
        "Referer":"https://stratz.com/",
        "User-Agent":"DotaMetaBot/1.0"
      },
      body: JSON.stringify({ query: v.q, variables: { from, to, rank, pos: ROLE_TO_POSITION[role] ?? 2 } })
    });
    if (!res.ok) return { key:v.key, count:0, rows:[], error:`HTTP ${res.status}` };
    const body = await res.json().catch(()=>null);
    if (body?.errors?.length) return { key:v.key, count:0, rows:[], error: JSON.stringify(body.errors[0]) };
    const rows = body?.data?.heroPerformance || [];
    return { key:v.key, count: rows.length, rows, error:null };
  } catch (e) {
    return { key:v.key, count:0, rows:[], error: e?.message || String(e) };
  }
}

main().catch(async (e) => {
  console.error(e);
  if (DISCORD_WEBHOOK_URL) {
    await fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type":"application/json" },
      body: JSON.stringify({ username:"Dota META", content:`Error: ${e?.message || e}` })
    }).catch(()=>{});
  }
  process.exit(1);
});
