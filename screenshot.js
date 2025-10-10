// meta z STRATZ GraphQL -> vygenerujeme vlastnú HTML tabuľku -> screenshot -> Discord
import { chromium } from "playwright";

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const STRATZ_TOKEN = process.env.STRATZ_TOKEN;

const ROLES = ["safe", "mid", "off", "soft", "hard"];
const ROLE_TO_POSITION = { safe: 1, mid: 2, off: 3, soft: 4, hard: 5 };
const RANK = "IMMORTAL";
const LIMIT = 10;
const MIN_MATCHES = 30;

const CDN = "https://cdn.cloudflare.steamstatic.com";
const OD_HEROES = "https://api.opendota.com/api/constants/heroes";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function yesterdayUtcRangeMS() {
  const now = new Date();
  const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const startMs = todayUtc.getTime() - 24*3600*1000;     // včera 00:00 UTC (ms)
  const endMs   = todayUtc.getTime() - 1;                // včera 23:59:59.999 (ms)
  const label = new Date(startMs).toISOString().slice(0,10);
  return { startMs, endMs, label };
}

async function fetchJSON(url, opts={}) {
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

const STRATZ_GQL = "https://api.stratz.com/graphql";
const QUERY = `
  query MetaByRole($from: Long!, $to: Long!, $rank: RankBracketType!, $pos: PositionType!) {
    heroPerformance(
      request: {
        dateTime: { min: $from, max: $to }
        rankBracket: [$rank]
        positions: [$pos]
        lobbyTypeIds: [7]
        isParsed: true
      }
    ) { heroId winCount matchCount }
  }
`;

async function fetchRoleData(role, rank, fromMs, toMs) {
  const pos = ROLE_TO_POSITION[role] ?? 2;
  const res = await fetch(STRATZ_GQL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "Authorization": `Bearer ${STRATZ_TOKEN}`,
      "Origin": "https://stratz.com",
      "Referer": "https://stratz.com/",
      "User-Agent": "DotaMetaBot/1.0"
    },
    body: JSON.stringify({
      query: QUERY,
      variables: { from: fromMs, to: toMs, rank, pos }
    })
  });
  if (!res.ok) throw new Error(`STRATZ ${res.status}: ${await res.text()}`);
  const body = await res.json();
  return body?.data?.heroPerformance || [];
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

function htmlTemplate(label, sections, heroes) {
  const css = `
    body { background:#0b0e13; color:#e6e9ef; font:14px/1.4 Inter,system-ui,Segoe UI,Roboto,Arial; padding:24px; }
    h1 { margin:0 0 16px; font-size:20px; }
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
    footer { margin-top:12px; color:#93a0b4; font-size:12px; }
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
          <td>
            <div class="hero">
              ${h.img ? `<img src="${h.img}" alt="${h.name}">` : ``}
              <span>${h.name||("Hero "+r.id)}</span>
            </div>
          </td>
          <td class="${cls}">${wr}%</td>
          <td>${pick}%</td>
          <td style="text-align:right">${r.matches.toLocaleString("en-US")}</td>
        </tr>
      `;
    }).join("");
    return `
      <div class="card">
        <div class="title">${roleName(role)}</div>
        <table>
          <thead><tr><th>#</th><th>Hero</th><th>WR</th><th>Pick</th><th style="text-align:right">Games</th></tr></thead>
          <tbody>${trs || `<tr><td colspan="5">No data</td></tr>`}</tbody>
        </table>
      </div>
    `;
  };

  const columns = sections.map(s => makeTable(s.role, s.rows)).join("");
  return `
  <html><head><meta charset="utf-8"><style>${css}</style></head>
  <body>
    <h1>STRATZ META • ${label} • Immortal</h1>
    <div class="grid">${columns}</div>
    <footer>Data: STRATZ GraphQL • ranked only • generated automatically</footer>
  </body></html>`;
}

async function buildImageAndSend() {
  if (!DISCORD_WEBHOOK_URL) throw new Error("Missing DISCORD_WEBHOOK_URL");
  if (!STRATZ_TOKEN) throw new Error("Missing STRATZ_TOKEN");

  const { startMs, endMs, label } = yesterdayUtcRangeMS();
  const heroes = await getHeroMap();

  // načítaj dáta pre všetky roly
  const sections = [];
  for (const role of ROLES) {
    let rows = await fetchRoleData(role, RANK, startMs, endMs);
    if (!rows?.length) {
      // fallback: 3 dni okno, bez lobby filtra (zriedka treba)
      const threeDaysAgo = startMs - 2*24*3600*1000;
      rows = await fetchRoleData(role, RANK, threeDaysAgo, endMs).catch(()=>[]);
    }
    sections.push({ role, rows: topRows(rows, LIMIT) });
    await sleep(200); // malý odstup
  }

  // priprav HTML
  const html = htmlTemplate(label, sections, heroes);

  // render v Playwright-e (lokálne, žiadny login netreba)
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 1400 } });
  const page = await ctx.newPage();
  await page.setContent(html, { waitUntil: "load" });
  // ak je obsah dlhší, dáme fullPage
  const path = "meta.png";
  await page.screenshot({ path, type: "png", fullPage: true });
  await browser.close();

  // pošli do Discordu
  const buf = await (await fetch("file://" + path).catch(()=>({arrayBuffer:async()=>[]}))).arrayBuffer().catch(()=>null);
  // Node 20 má FormData/Blob globálne
  const form = new FormData();
  form.append("payload_json", JSON.stringify({
    username: "Dota META",
    embeds: [{
      title: `STRATZ Meta Positions — ${label} — Immortal`,
      image: { url: "attachment://meta.png" }
    }]
  }));
  form.append("file", new Blob([buf], { type: "image/png" }), "meta.png");
  const res = await fetch(DISCORD_WEBHOOK_URL, { method: "POST", body: form });
  if (!res.ok) throw new Error(`Discord webhook failed: ${res.status} ${await res.text().catch(()=> "")}`);
}

buildImageAndSend().catch(async (e) => {
  console.error(e);
  if (DISCORD_WEBHOOK_URL) {
    await fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "Dota META", content: `Error: ${e?.message || e}` })
    }).catch(()=>{});
  }
  process.exit(1);
});
