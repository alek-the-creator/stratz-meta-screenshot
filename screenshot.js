// Scrape Dota2ProTracker -> render vlastné HTML -> screenshot -> Discord
// Env: DISCORD_WEBHOOK_URL, PAGE_URL (default https://dota2protracker.com/)
import { chromium } from "playwright";
import fs from "node:fs";

const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const PAGE_URL = process.env.PAGE_URL || "https://dota2protracker.com/";

if (!WEBHOOK) throw new Error("Missing DISCORD_WEBHOOK_URL");

// vzhľad a výstup
const VIEWPORT = { width: 1400, height: 1400 };
const PAD = 0;

// mapovanie rolí do nášho layoutu
const ROLE_KEYS = [
  { label: "Carry", key: "safe" },
  { label: "Mid", key: "mid" },
  { label: "Offlane", key: "off" },
  { label: "Support (4)", key: "soft" },
  { label: "Support (5)", key: "hard" },
  // "Overall" nepoužijeme do gridu – buď ho ignoruj, alebo ho vieš pridať zvlášť
];

// Na obrázky hrdinov použijeme Steam CDN cez OpenDota mapu
const CDN = "https://cdn.cloudflare.steamstatic.com";
const OD_HEROES = "https://api.opendota.com/api/constants/heroes";

// ---------- helpers ----------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function pctToNum(s){ const m = String(s).match(/(\d+(?:\.\d+)?)\s*%/); return m ? Number(m[1]) : null; }
function matchesToNum(s){
  // "2.3K" -> 2300, "908" -> 908
  const m = String(s).trim().match(/^(\d+(?:\.\d+)?)([kKmM]?)$/);
  if(!m) return null;
  let n = Number(m[1]);
  const suf = m[2].toLowerCase();
  if (suf === "k") n *= 1000;
  if (suf === "m") n *= 1_000_000;
  return Math.round(n);
}

// ---------- načítanie OpenDota hero mapy ----------
async function getHeroMap() {
  const res = await fetch(OD_HEROES);
  if (!res.ok) throw new Error("OpenDota heroes failed: " + res.status);
  const data = await res.json();
  const map = new Map();
  for (const [id, h] of Object.entries(data)) {
    const short = h.name?.replace("npc_dota_hero_", "");
    map.set(h.localized_name, {
      name: h.localized_name,
      img: short ? `${CDN}/apps/dota2/images/heroes/${short}_full.png` : null
    });
    // pridať aj variant s diakritikou/medzerami znormalizovaný
    map.set(h.localized_name.replace(/’/g,"'"), {
      name: h.localized_name,
      img: short ? `${CDN}/apps/dota2/images/heroes/${short}_full.png` : null
    });
  }
  return map;
}

// ---------- scraping jadro (v prehliadači) ----------
async function scrapeD2PT(page){
  // nájdi sekciu s týmto nadpisom
  const title = page.getByRole("heading", { name: /Most Successful Heroes by Role/i }).first();
  await title.waitFor({ timeout: 15000 });
  // daj stránke čas dotiahnuť čísla
  await page.waitForLoadState("networkidle").catch(()=>{});
  await page.waitForTimeout(1000);

  // Vyškriabeme dáta robustne: buď po blokoch (karty), alebo priamo z textu
  const data = await page.evaluate(() => {
    const out = {};
    const byRole = role => (out[role] = out[role] || []);

    // nájdi kontajner sekcie (parent so slušnou šírkou a viacerými percentami)
    const heading = Array.from(document.querySelectorAll("h2,h3"))
      .find(h => /Most Successful Heroes by Role/i.test(h.textContent || ""));
    if(!heading) return out;
    let sec = heading.parentElement;
    while(sec && (sec.querySelectorAll("h3,h4").length < 3 || sec.getBoundingClientRect().width < 600)){
      sec = sec.parentElement;
    }
    if(!sec) sec = heading.closest("section") || heading.parentElement;

    // 1) primárne: karty pre jednotlivé role
    const roleTitles = ["Overall","Carry","Mid","Offlane","Support (4)","Support (5)"];
    const cards = roleTitles.map(rt => {
      // element, ktorý obsahuje daný titul a zároveň má viac '%'
      const el = Array.from(sec.querySelectorAll("*")).find(e => {
        const t = (e.textContent || "").trim();
        return t.startsWith(rt) && (t.match(/%/g) || []).length >= 3;
      });
      return { role: rt, el };
    });

    const parseCard = (el, role) => {
      if(!el) return;
      // kandidáti na riadky — často <a> alebo <div> s ikonou + WR + matches
      const rows = Array.from(el.querySelectorAll("a,div"))
        .filter(n => (n.textContent || "").match(/%/));
      // vezmeme 6 prvých unikátnych, kde vieme vyextrahovať meno + wr + matches
      const seen = new Set();
      const items = [];
      for (const r of rows) {
        let text = (r.textContent || "").replace(/\u00a0/g," ").trim();
        // vyber prvú % hodnotu a číslo (matches)
        const wrm = text.match(/(\d+(?:\.\d+)?)\s*%/);
        const mm = text.match(/(\d+(?:\.\d+)?\s*[kKmM]?)(?!.*\d)/); // posledné číslo v riadku
        // meno odhadneme ako prvý token s písmenami pred WR/matches
        // zoberieme text do prvého % a z neho posledný nenumerický blok
        let name = text.split("%")[0]
          .replace(/[\d\.,kKmM]/g,"")  // odstráň čísla/sufixy
          .replace(/\s+/g," ")
          .trim();
        // odseknúť prípadné ikonky/emoji
        name = name.replace(/^[^\w]*|[^\w\s'-].*$/g, "").trim();
        if (!name || !wrm || !mm) continue;
        if (name.length > 28) continue; // šum

        if (seen.has(name)) continue;
        seen.add(name);

        items.push({
          name,
          wr: Number(wrm[1]),
          matches: mm[1].replace(/\s+/g,"").toUpperCase()
        });
        if (items.length >= 6) break;
      }
      if (items.length) byRole(role).push(...items);
    };

    for (const {role, el} of cards) parseCard(el, role);

    // 2) fallback: ak niektorá rola nič nenašla, skús textový rozpad podľa hlavičiek
    for (const rt of roleTitles) {
      if ((out[rt] || []).length) continue;
      const blockEl = Array.from(sec.querySelectorAll("*")).find(e => {
        const t = (e.textContent || "").trim();
        return t.startsWith(rt) && t.split("%").length > 2;
      });
      if (!blockEl) continue;
      const text = (blockEl.textContent || "").replace(/\u00a0/g," ");
      // heuristika: zober riadky po role title, filtre na percentá
      const lines = text.split("\n").map(s=>s.trim()).filter(Boolean);
      const start = lines.findIndex(l => l === rt);
      const slice = start >= 0 ? lines.slice(start+1) : lines;
      const items = [];
      for (let i=0; i<slice.length-2; i++){
        const maybeName = slice[i];
        const hasPct = /%/.test(slice[i+1]) || /%/.test(slice[i+2]);
        const hasNum = /(\d+(?:\.\d+)?\s*[kKmM]?)/.test(slice[i+1]) || /(\d+(?:\.\d+)?\s*[kKmM]?)/.test(slice[i+2]);
        if (/^\d|%/.test(maybeName)) continue;
        if (!hasPct || !hasNum) continue;
        const wrStr = (slice[i+1].match(/(\d+(?:\.\d+)?)\s*%/) || slice[i+2]?.match(/(\d+(?:\.\d+)?)\s*%/) || [])[0];
        const mStr  = (slice[i+1].match(/(\d+(?:\.\d+)?\s*[kKmM]?)/) || slice[i+2]?.match(/(\d+(?:\.\d+)?\s*[kKmM]?)/) || [])[0];
        if (wrStr && mStr) {
          items.push({ name: maybeName, wr: Number(wrStr.replace("%","")), matches: mStr.toUpperCase() });
        }
        if (items.length >= 6) break;
      }
      if (items.length) byRole(rt).push(...items);
    }

    return out;
  });

  return data;
}

// ---------- render nášho dizajnu ----------
function htmlTemplate(label, sections, heroMap) {
  const css = `
    body { background:#0b0e13; color:#e6e9ef; font:14px/1.45 Inter,system-ui,Segoe UI,Roboto,Arial; padding:24px; }
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
    .muted { color:#93a0b4; font-size:12px; margin-top:10px; }
  `;
  const roleName = k => ({safe:"Safe Lane",mid:"Mid",off:"Offlane",soft:"Soft Support",hard:"Hard Support"})[k]||k;

  const makeRows = rows => rows.map((r,i)=>{
    const h = heroMap.get(r.name) || heroMap.get(r.name.replace(/’/g,"'")) || {};
    const matches = matchesToNum(r.matches);
    const cls = (r.wr >= 50) ? "wr good" : "wr bad";
    return `
      <tr>
        <td style="width:34px">${String(i+1).padStart(2," ")}</td>
        <td><div class="hero">${h.img?`<img src="${h.img}" alt="${h.name}">`:``}<span>${r.name}</span></div></td>
        <td class="${cls}">${r.wr.toFixed(1)}%</td>
        <td>${(matches!=null)? (matches>=1000?Math.round(matches/100)/10+'k':matches): r.matches}</td>
      </tr>`;
  }).join("");

  const makeCard = (key, rows) => `
    <div class="card">
      <div class="title">${roleName(key)}</div>
      <table>
        <thead><tr><th>#</th><th>Hero</th><th>WR</th><th>Games</th></tr></thead>
        <tbody>${rows.length ? makeRows(rows) : `<tr><td colspan="4">No data</td></tr>`}</tbody>
      </table>
    </div>`;

  const cards = sections.map(s => makeCard(s.key, s.rows)).join("");

  return `
  <html><head><meta charset="utf-8"><style>${css}</style></head>
  <body>
    <h1>Dota2ProTracker META • ${label}</h1>
    <div class="grid">${cards}</div>
    <div class="muted">Source: dota2protracker.com • scraped & rendered automatically</div>
  </body></html>`;
}

// ---------- main ----------
async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();

  await page.goto(PAGE_URL, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await page.waitForLoadState("networkidle").catch(()=>{});
  await page.waitForTimeout(2000);

  const scraped = await scrapeD2PT(page); // { "Carry":[...], "Mid":[...], ... }
  await browser.close();

  // zlož sekcie podľa ROLE_KEYS
  const label = new Date().toISOString().slice(0,10);
  const heroMap = await getHeroMap();
  const sections = ROLE_KEYS.map(({label:src,key}) => {
    const items = (scraped[src] || []).slice(0,6).map(x => ({
      name: x.name,
      wr: typeof x.wr === "number" ? x.wr : pctToNum(x.wr) || 0,
      matches: x.matches
    }));
    return { key, rows: items };
  });

  // render HTML -> screenshot
  const html = htmlTemplate(label, sections, heroMap);
  const browser2 = await chromium.launch({ headless: true });
  const ctx2 = await browser2.newContext({ viewport: VIEWPORT });
  const p2 = await ctx2.newPage();
  await p2.setContent(html, { waitUntil: "load" });
  const out = "meta.png";
  await p2.screenshot({ path: out, type: "png", fullPage: true, clip: PAD?{x:PAD,y:PAD,width:VIEWPORT.width-PAD*2,height:VIEWPORT.height-PAD*2}:undefined }).catch(async()=> {
    await p2.screenshot({ path: out, type: "png", fullPage: true });
  });
  await browser2.close();

  // => Discord
  const buf = fs.readFileSync(out);
  const form = new FormData();
  form.append("payload_json", JSON.stringify({
    username: "Dota META",
    embeds: [{ title: `D2PT Meta • ${label}`, image: { url: "attachment://meta.png" } }]
  }));
  form.append("file", new Blob([buf], { type: "image/png" }), "meta.png");
  const res = await fetch(WEBHOOK, { method: "POST", body: form });
  if (!res.ok) throw new Error(`Discord webhook failed: ${res.status} ${await res.text().catch(()=> "")}`);
}

main().catch(async (e) => {
  console.error(e);
  if (WEBHOOK) {
    await fetch(WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "Dota META", content: `Error: ${e?.message || e}` })
    }).catch(()=>{});
  }
  process.exit(1);
});
