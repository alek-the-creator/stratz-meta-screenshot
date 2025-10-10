// Dota2ProTracker -> scrape presnej sekcie -> vlastné HTML -> screenshot -> Discord
import { chromium } from "playwright";
import fs from "node:fs";

const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const PAGE_URL = process.env.PAGE_URL || "https://dota2protracker.com/";

if (!WEBHOOK) throw new Error("Missing DISCORD_WEBHOOK_URL");

const VIEWPORT = { width: 1400, height: 1400 };

// ---- util ----
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function pctNum(s){ const m = String(s).match(/(\d+(?:\.\d+)?)\s*%/); return m ? +m[1] : null; }
function matchesNum(s){
  const m = String(s).trim().match(/^(\d+(?:\.\d+)?)([kKmM]?)$/);
  if(!m) return null;
  let n = +m[1];
  const suf = m[2].toLowerCase();
  if (suf === "k") n *= 1000;
  if (suf === "m") n *= 1_000_000;
  return Math.round(n);
}

// ---- OpenDota hero map (na ikony + oficiálne mená) ----
const CDN = "https://cdn.cloudflare.steamstatic.com";
const OD_HEROES = "https://api.opendota.com/api/constants/heroes";
async function getHeroMaps(){
  const res = await fetch(OD_HEROES); if(!res.ok) throw new Error("OpenDota heroes " + res.status);
  const data = await res.json();
  const byLocalized = new Map();
  const bySlug = new Map(); // anti-mage, queen-of-pain (hypheny)
  const list = [];
  for (const h of Object.values(data)) {
    const short = h.name.replace("npc_dota_hero_", "");          // anti_mage
    const slug = short.replace(/_/g, "-");                       // anti-mage
    const loc  = h.localized_name;
    const img  = `${CDN}/apps/dota2/images/heroes/${short}_full.png`;
    byLocalized.set(loc, { name: loc, img, slug });
    bySlug.set(slug,       { name: loc, img, slug });
    list.push({ name: loc, norm: normalizeText(loc), img, slug });
  }
  return { byLocalized, bySlug, list };
}

// jednoduchá normalizácia + „fuzzy“ vzdialenosť
function normalizeText(s){ return String(s).toLowerCase().replace(/[^a-z\s]/g,'').replace(/\s+/g,' ').trim(); }
function levenshtein(a,b){
  a = normalizeText(a); b = normalizeText(b);
  const m = a.length, n = b.length;
  const dp = Array.from({length:m+1}, (_,i)=>Array(n+1).fill(0));
  for (let i=0;i<=m;i++) dp[i][0]=i;
  for (let j=0;j<=n;j++) dp[0][j]=j;
  for (let i=1;i<=m;i++){
    for (let j=1;j<=n;j++){
      const cost = a[i-1]===b[j-1]?0:1;
      dp[i][j] = Math.min(dp[i-1][j]+1, dp[i][j-1]+1, dp[i-1][j-1]+cost);
    }
  }
  return dp[m][n];
}
function bestHeroMatch(candidate, heroList){
  if (!candidate) return null;
  const candNorm = normalizeText(candidate);
  if (!candNorm) return null;
  let best = null, bestScore = Infinity;
  for (const h of heroList){
    const d = levenshtein(candNorm, h.norm);
    if (d < bestScore){ bestScore = d; best = h; }
  }
  // tolerancia: krátke mená do 1–2 chýb, dlhšie do ~3–4
  if (bestScore <= Math.max(2, Math.ceil(best.norm.length * 0.2))) return best;
  return null;
}

// ---- scraping v prehliadači (presné selektory) ----
async function scrapeD2PT(page){
  // nájdi sekciu „Most Successful Heroes by Role“
  const title = page.getByRole("heading", { name: /Most Successful Heroes by Role/i }).first();
  await title.waitFor({ timeout: 15000 }).catch(()=>{});
  await page.waitForLoadState("networkidle").catch(()=>{});
  await sleep(800);

  return await page.evaluate(() => {
    const out = {};
    const ensure = r => (out[r] = out[r] || []);
    const roles = ["Overall","Carry","Mid","Offlane","Support (4)","Support (5)"];

    function findSectionRoot(){
      const heading = Array.from(document.querySelectorAll("h2,h3"))
        .find(h => /Most Successful Heroes by Role/i.test(h.textContent||""));
      if (!heading) return null;
      let sec = heading.parentElement;
      while (sec && (sec.querySelectorAll("img[alt]").length < 5 || sec.querySelectorAll("table, a").length < 10)) {
        sec = sec.parentElement;
      }
      return sec || heading.closest("section") || heading.parentElement;
    }

    const sec = findSectionRoot();
    if (!sec) return out;

    function pickRows(cardEl){
      // riadky sú väčšinou <a> alebo <div> s ikonou, menom, WR a matches
      const rows = Array.from(cardEl.querySelectorAll("a,div"))
        .filter(n => (n.querySelector('img[alt]') || (n.textContent||"").match(/%/)))
        .slice(0, 20);
      const items = [];
      const seen = new Set();
      for (const r of rows){
        const img = r.querySelector('img[alt]');
        const alt = img?.getAttribute('alt')?.trim();
        const link = r.closest('a') || r.querySelector('a[href*="/hero/"]');
        const href = link?.getAttribute('href')||"";
        let slug = null;
        const mSlug = href.match(/\/hero\/([^/?#]+)/i);
        if (mSlug) slug = decodeURIComponent(mSlug[1].toLowerCase()); // napr. anti-mage
        const wrM = (r.textContent||"").match(/(\d+(?:\.\d+)?)\s*%/);
        const matchesM = (r.textContent||"").match(/(\d+(?:\.\d+)?\s*[kKmM]?)(?!.*\d)/);

        // meno – preferuj alt, potom text pred WR
        let name = alt || "";
        if (!name) {
          const beforePct = (r.textContent||"").split("%")[0]||"";
          name = beforePct.replace(/[\d\.,kKmM]/g,"").replace(/\s+/g," ").trim();
          name = name.replace(/^[^\w]*|[^\w\s'-].*$/g, "").trim();
        }

        if (!wrM || !matchesM) continue;
        if (!name && !slug) continue;
        if (name && seen.has(name.toLowerCase())) continue;

        items.push({
          name, slug,
          wr: wrM[1], matches: matchesM[1].toUpperCase()
        });
        if (name) seen.add(name.toLowerCase());
        if (items.length >= 6) break;
      }
      return items;
    }

    for (const role of roles){
      const card = Array.from(sec.querySelectorAll("*")).find(e => {
        const t = (e.textContent||"").trim();
        return t.startsWith(role) && (t.match(/%/g)||[]).length >= 3;
      });
      if (!card) continue;
      ensure(role).push(...pickRows(card));
    }
    return out;
  });
}

// ---- náš layout ----
function htmlTemplate(label, sections){
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

  const makeRows = rows => rows.map((r,i)=>`
      <tr>
        <td style="width:34px">${String(i+1).padStart(2," ")}</td>
        <td><div class="hero">${r.img?`<img src="${r.img}" alt="${r.name}">`:``}<span>${r.name}</span></div></td>
        <td class="${r.wr>=50?'wr good':'wr bad'}">${r.wr.toFixed(1)}%</td>
        <td>${r.games>=1000 ? Math.round(r.games/100)/10+'k' : r.games}</td>
      </tr>`).join("");

  const makeCard = (key, rows) => `
    <div class="card">
      <div class="title">${roleName(key)}</div>
      <table>
        <thead><tr><th>#</th><th>Hero</th><th>WR</th><th>Games</th></tr></thead>
        <tbody>${rows.length ? makeRows(rows) : `<tr><td colspan="4">No data</td></tr>`}</tbody>
      </table>
    </div>`;

  const grid = sections.map(s => makeCard(s.key, s.rows)).join("");

  return `
  <html><head><meta charset="utf-8"><style>${css}</style></head>
  <body>
    <h1>Dota2ProTracker META • ${label}</h1>
    <div class="grid">${grid}</div>
    <div class="muted">Source: dota2protracker.com • scraped & rendered automatically</div>
  </body></html>`;
}

// ---- main flow ----
async function main(){
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: VIEWPORT });
  const page = await ctx.newPage();

  await page.goto(PAGE_URL, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await page.waitForLoadState("networkidle").catch(()=>{});
  await sleep(1500);

  const raw = await scrapeD2PT(page);
  await browser.close();

  const { byLocalized, bySlug, list } = await getHeroMaps();

  // mapovanie rolí -> náš grid (bez "Overall")
  const ROLE_ORDER = [
    { src:"Carry", key:"safe" },
    { src:"Mid", key:"mid" },
    { src:"Offlane", key:"off" },
    { src:"Support (4)", key:"soft" },
    { src:"Support (5)", key:"hard" },
  ];

  function resolveHero(item){
    // 1) podľa slug (najpresnejšie)
    if (item.slug && bySlug.get(item.slug)) return bySlug.get(item.slug);
    // 2) podľa lokalizovaného mena
    if (byLocalized.get(item.name)) return byLocalized.get(item.name);
    // 3) fuzzy match (Anti-age -> Anti-Mage, Puc -> Puck, Earthshaer -> Earthshaker…)
    const m = bestHeroMatch(item.name, list);
    if (m) return { name: m.name, img: m.img, slug: m.slug };
    // 4) fallback – názov z webu, bez obrázka
    return { name: item.name, img: null, slug: null };
  }

  const sections = ROLE_ORDER.map(({src,key}) => {
    const items = (raw[src] || []).slice(0,6).map(it => {
      const hero = resolveHero(it);
      const wr = typeof it.wr === "number" ? it.wr : (pctNum(it.wr) ?? 0);
      const games = matchesNum(it.matches) ?? 0;
      return { name: hero.name, img: hero.img, wr, games };
    });
    return { key, rows: items };
  });

  const label = new Date().toISOString().slice(0,10);
  const html = htmlTemplate(label, sections);

  const browser2 = await chromium.launch({ headless: true });
  const ctx2 = await browser2.newContext({ viewport: VIEWPORT });
  const p2 = await ctx2.newPage();
  await p2.setContent(html, { waitUntil: "load" });
  const out = "meta.png";
  await p2.screenshot({ path: out, type: "png", fullPage: true });
  await browser2.close();

  // -> Discord
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
