// D2PT -> striktne scrape cez hero slug -> render vlastné HTML -> screenshot -> Discord
import { chromium } from "playwright";
import fs from "node:fs";

const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const PAGE_URL = process.env.PAGE_URL || "https://dota2protracker.com/";
if (!WEBHOOK) throw new Error("Missing DISCORD_WEBHOOK_URL");

const VIEWPORT = { width: 1400, height: 1400 };

// ---------- helpers ----------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function pctNum(s){
  if (!s) return null;
  const t = String(s).replace(",", "."); // 56,7% -> 56.7%
  const m = t.match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
}
function matchesNum(s){
  if (!s) return null;
  const t = String(s).trim();
  const m = t.match(/^(\d+(?:\.\d+)?)([kKmM]?)$/);
  if (!m) return null;
  let n = parseFloat(m[1]);
  const suf = m[2].toLowerCase();
  if (suf === "k") n *= 1000;
  if (suf === "m") n *= 1_000_000;
  return Math.round(n);
}

// ---------- OpenDota hero map ----------
const CDN = "https://cdn.cloudflare.steamstatic.com";
const OD_HEROES = "https://api.opendota.com/api/constants/heroes";
async function getHeroBySlug() {
  const res = await fetch(OD_HEROES);
  if (!res.ok) throw new Error("OpenDota heroes " + res.status);
  const data = await res.json();
  const bySlug = new Map();
  for (const h of Object.values(data)) {
    const short = h.name.replace("npc_dota_hero_", ""); // anti_mage
    const slug  = short.replace(/_/g, "-");             // anti-mage
    bySlug.set(slug, {
      name: h.localized_name,
      img: `${CDN}/apps/dota2/images/heroes/${short}_full.png`,
      slug
    });
  }
  return bySlug;
}

// ---------- striktne scrapovanie v prehliadači ----------
async function scrapeD2PT(page){
  // čakaj na sekciu
  const title = page.getByRole("heading", { name: /Most Successful Heroes by Role/i }).first();
  await title.waitFor({ timeout: 15000 }).catch(()=>{});
  await page.waitForLoadState("networkidle").catch(()=>{});
  await sleep(800);

  return await page.evaluate(() => {
    const out = {};
    const roles = ["Overall","Carry","Mid","Offlane","Support (4)","Support (5)"];

    function findSectionRoot(){
      const heading = Array.from(document.querySelectorAll("h2,h3"))
        .find(h => /Most Successful Heroes by Role/i.test(h.textContent||""));
      if (!heading) return null;
      let sec = heading.parentElement;
      while (sec && (sec.querySelectorAll('a[href*="/hero/"]').length < 6)) {
        sec = sec.parentElement;
      }
      return sec || heading.closest("section") || heading.parentElement;
    }

    const sec = findSectionRoot();
    if (!sec) return out;

    function dedupeBySlug(rows){
      const seen = new Set();
      const out = [];
      for (const r of rows) {
        if (seen.has(r.slug)) continue;
        seen.add(r.slug);
        out.push(r);
      }
      return out;
    }

    function extractCard(cardEl){
      // 1) nájdi všetky <a href="/hero/..."> a z nich sprav "riadky"
      const anchors = Array.from(cardEl.querySelectorAll(':scope a[href*="/hero/"]'));
      // pre každý anchor nájdi najbližší rodič, ktorý reprezentuje "riadok"
      const rowsRaw = anchors.map(a => {
        const href = a.getAttribute("href") || "";
        const m = href.match(/\/hero\/([^/?#]+)/i);
        if (!m) return null;
        const slug = decodeURIComponent(m[1].toLowerCase());

        // vylez hore kým rodič nemá iný hero anchor (tak dostaneme najmenší kontajner-riadok)
        let row = a;
        for (let i=0;i<6;i++){
          const parent = row.parentElement;
          if (!parent) break;
          const others = parent.querySelectorAll(':scope a[href*="/hero/"]');
          if (others.length > 1) break; // už by to bolo viac riadkov naraz
          row = parent;
        }
        const rect = row.getBoundingClientRect();
        return { slug, row, y: rect.top, x: rect.left };
      }).filter(Boolean);

      // zoradíme podľa pozície, vyhodíme duplicitné slugy
      const byPos = rowsRaw
        .sort((a,b)=> a.y===b.y ? a.x-b.x : a.y-b.y)
        .map(r => ({ slug: r.slug, row: r.row }));
      const uniq = [];
      const seenSlug = new Set();
      for (const r of byPos) {
        if (seenSlug.has(r.slug)) continue;
        seenSlug.add(r.slug);
        uniq.push(r);
      }

      // 2) z každého riadka vytiahni WR a Games
      let rows = uniq.map(({slug,row}) => {
        const text = (row.textContent || "").replace(/\u00a0/g, " ");
        const wrM = text.match(/(\d+(?:[.,]\d+)?)\s*%/);
        // posledné číslo v riadku považuj za matches (napr. 3.1k)
        const gamesM = text.match(/(\d+(?:\.\d+)?\s*[kKmM]?)(?!.*\d)/);
        return wrM && gamesM ? { slug, wr: wrM[1], matches: gamesM[1].toUpperCase() } : { slug, wr: null, matches: null };
      });

      // ak niektoré WR/Games chýbajú, sprav indexový fallback z celej karty
      if (rows.some(r => !r.wr || !r.matches)) {
        const cardText = (cardEl.textContent || "").replace(/\u00a0/g," ");
        const allWR = [...cardText.matchAll(/(\d+(?:[.,]\d+)?)\s*%/g)].map(m=>m[1]);
        const allGM = [...cardText.matchAll(/(\d+(?:\.\d+)?\s*[kKmM]?)(?!.*\d)/g)].map(m=>m[1].toUpperCase());
        for (let i=0;i<rows.length;i++){
          if (!rows[i].wr && allWR[i]) rows[i].wr = allWR[i];
          if (!rows[i].matches && allGM[i]) rows[i].matches = allGM[i];
        }
      }

      // vyhoď riadky kde sa nepodarilo doplniť čísla
      rows = rows.filter(r => r.wr && r.matches);

      // necháme prvých 6
      rows = rows.slice(0, 6);
      return rows;
    }

    for (const role of roles) {
      const card = Array.from(sec.querySelectorAll(":scope > * , :scope section, :scope div")).find(e => {
        const t = (e.textContent || "").trim();
        return t.startsWith(role) && e.querySelector('a[href*="/hero/"]');
      });
      if (!card) continue;
      const rows = extractCard(card);
      // safety: dedupe znova (keby ankory obsahovali duplicitné slugs)
      out[role] = dedupeBySlug(rows);
    }
    return out;
  });
}


// ---------- render ----------
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
      <td>${r.games>=1000 ? Math.round(r.games/100)/10 + 'k' : r.games}</td>
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

// ---------- main ----------
async function main(){
  // 1) otvor stránku a striktne vyscrapuj slug+WR+matches
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: VIEWPORT });
  const page = await ctx.newPage();
  await page.goto(PAGE_URL, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await page.waitForLoadState("networkidle").catch(()=>{});
  await sleep(1500);
  const raw = await scrapeD2PT(page);
  await browser.close();

  // 2) mapuj slug na meno+ikonu
  const bySlug = await getHeroBySlug();
  const ROLE_ORDER = [
    { src:"Carry", key:"safe" },
    { src:"Mid", key:"mid" },
    { src:"Offlane", key:"off" },
    { src:"Support (4)", key:"soft" },
    { src:"Support (5)", key:"hard" },
  ];

  const sections = ROLE_ORDER.map(({src,key}) => {
    const rows = [];
    const items = (raw[src] || []);
    for (const it of items) {
      const h = bySlug.get(it.slug);
      if (!h) continue; // ak nepoznáme slug, radšej preskoč (zamedzí preklepom)
      const wr = pctNum(it.wr);
      const games = matchesNum(it.matches);
      if (wr == null || games == null) continue;
      rows.push({ name: h.name, img: h.img, wr, games });
      if (rows.length >= 6) break;
    }
    return { key, rows };
  });

  // 3) render + screenshot + Discord
  const label = new Date().toISOString().slice(0,10);
  const html = htmlTemplate(label, sections);

  const browser2 = await chromium.launch({ headless: true });
  const ctx2 = await browser2.newContext({ viewport: VIEWPORT });
  const p2 = await ctx2.newPage();
  await p2.setContent(html, { waitUntil: "load" });
  const out = "meta.png";
  await p2.screenshot({ path: out, type: "png", fullPage: true });
  await browser2.close();

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
