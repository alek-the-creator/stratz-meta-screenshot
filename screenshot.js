// D2PT -> deterministický scrape (6 položiek/roľa) -> render -> screenshot -> Discord
import { chromium } from "playwright";
import fs from "node:fs";

const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const PAGE_URL = process.env.PAGE_URL || "https://dota2protracker.com/";
if (!WEBHOOK) throw new Error("Missing DISCORD_WEBHOOK_URL");

const VIEWPORT = { width: 1400, height: 1400 };
const SLEEP = (ms) => new Promise(r => setTimeout(r, ms));

/* ---------- parsing helpers ---------- */
function parsePct(s) {
  if (!s) return null;
  const m = String(s).replace(",", ".").match(/(\d+(?:\.\d+)?)\s*%/);
  return m ? parseFloat(m[1]) : null;
}
function parseGames(s) {
  if (!s) return null;
  const m = String(s).trim().match(/^(\d+(?:\.\d+)?)([kKmM]?)$/);
  if (!m) return null;
  let n = parseFloat(m[1]);
  const suf = m[2].toLowerCase();
  if (suf === "k") n *= 1000;
  else if (suf === "m") n *= 1_000_000;
  return Math.round(n);
}

/* ---------- OpenDota hero map (slug -> name, img) ---------- */
const CDN = "https://cdn.cloudflare.steamstatic.com";
const OD_HEROES = "https://api.opendota.com/api/constants/heroes";
async function loadHeroMap() {
  const res = await fetch(OD_HEROES);
  if (!res.ok) throw new Error("OpenDota heroes " + res.status);
  const data = await res.json();
  const bySlug = new Map();
  const byName = new Map(); // fallback keď nemáme slug
  for (const h of Object.values(data)) {
    const short = h.name.replace("npc_dota_hero_", "");  // anti_mage
    const slug = short.replace(/_/g, "-");               // anti-mage
    const name = h.localized_name;
    const img = `${CDN}/apps/dota2/images/heroes/${short}_full.png`;
    bySlug.set(slug, { name, img });
    byName.set(name.toLowerCase(), { name, img });
  }
  return { bySlug, byName };
}

/* ---------- čistý scrape v prehliadači ---------- */
async function scrape(page) {
  // Počkaj na sekciu „Most Successful Heroes by Role“
  const title = page.getByRole("heading", { name: /Most Successful Heroes by Role/i }).first();
  await title.waitFor({ timeout: 15000 }).catch(()=>{});
  await page.waitForLoadState("networkidle").catch(()=>{});
  await SLEEP(800);

  return await page.evaluate(() => {
    const out = {};
    const ROLES = ["Carry","Mid","Offlane","Support (4)","Support (5)"]; // "Overall" ignorujeme

    function findSectionRoot(){
      const heading = Array.from(document.querySelectorAll("h2,h3"))
        .find(h => /Most Successful Heroes by Role/i.test(h.textContent||""));
      if (!heading) return null;
      let sec = heading.parentElement;
      // prelez hore, kým nenájdem rodiča, ktorý v sebe jasne obsahuje veľa hero odkazov
      while (sec && sec.querySelectorAll('a[href*="/hero/"]').length < 6) {
        sec = sec.parentElement;
      }
      return sec || heading.closest("section") || heading.parentElement;
    }

    const sec = findSectionRoot();
    if (!sec) return out;

    // nájdi element karty podľa role (prvok, ktorého text začína menom role a obsahuje hero odkazy)
    function findCard(role) {
      return Array.from(sec.querySelectorAll(":scope *"))
        .find(e => {
          const t = (e.textContent || "").trim();
          return t.startsWith(role) && e.querySelector('a[href*="/hero/"]');
        });
    }

    function extractFromCard(cardEl) {
      // 1) poradie hrdinov: všetky <a href="/hero/..."> v rámci karty, zoradené podľa pozície na obrazovke
      const anchors = Array.from(cardEl.querySelectorAll(':scope a[href*="/hero/"]'));
      const heroRows = anchors.map(a => {
        const href = a.getAttribute("href") || "";
        const m = href.match(/\/hero\/([^/?#]+)/i);
        if (!m) return null;
        const slug = decodeURIComponent(m[1].toLowerCase());
        // zober najbližšieho rodiča, ktorý reprezentuje konkrétny „riadok“
        let row = a;
        for (let i = 0; i < 6; i++) {
          const parent = row.parentElement;
          if (!parent) break;
          const others = parent.querySelectorAll(':scope a[href*="/hero/"]');
          if (others.length > 1) break;
          row = parent;
        }
        const rect = row.getBoundingClientRect();
        return { slug, row, y: rect.top, x: rect.left };
      }).filter(Boolean)
        .sort((a,b) => a.y === b.y ? a.x - b.x : a.y - b.y);

      // deduplikuj poradie podľa slug
      const orderedSlugs = [];
      const seen = new Set();
      for (const h of heroRows) {
        if (seen.has(h.slug)) continue;
        seen.add(h.slug);
        orderedSlugs.push(h.slug);
      }

      // 2) zoznam všetkých WR (%) v tejto karte (v DOM poradí)
      const wrList = [];
      const walkerWR = document.createTreeWalker(cardEl, NodeFilter.SHOW_TEXT, {
        acceptNode(n){
          return /%/.test(n.textContent||"") ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
        }
      });
      while (walkerWR.nextNode()) {
        const txt = (walkerWR.currentNode.textContent || "").replace(/\u00a0/g," ").trim();
        const m = txt.match(/(\d+(?:[.,]\d+)?)\s*%/);
        if (m) wrList.push(m[0]); // napr. "56.7%"
      }

      // 3) zoznam všetkých "games" čísel – berieme čísla s (voliteľným) k/m, ale nie percentá
      const gmList = [];
      const walkerGM = document.createTreeWalker(cardEl, NodeFilter.SHOW_TEXT, {
        acceptNode(n){
          const t = (n.textContent||"").replace(/\u00a0/g," ").trim();
          if (!t) return NodeFilter.FILTER_SKIP;
          if (/%/.test(t)) return NodeFilter.FILTER_SKIP;
          if (/(\d+(?:\.\d+)?\s*[kKmM]?)/.test(t)) return NodeFilter.FILTER_ACCEPT;
          return NodeFilter.FILTER_SKIP;
        }
      });
      while (walkerGM.nextNode()) {
        const t = (walkerGM.currentNode.textContent||"").replace(/\u00a0/g," ").trim();
        const m = t.match(/(\d+(?:\.\d+)?\s*[kKmM]?)/);
        if (m) gmList.push(m[1]);
      }

      // 4) spáruj podľa indexu: 1. slug -> 1. WR -> 1. Games, atď.
      const rows = [];
      const N = Math.min(6, orderedSlugs.length, wrList.length, gmList.length);
      for (let i = 0; i < N; i++) {
        rows.push({ slug: orderedSlugs[i], wr: wrList[i], games: gmList[i] });
      }

      // ak by počet nesedel, doplň slugs do 6 a nechaj prázdne čísla (radšej prázdno než zle)
      for (let i = rows.length; i < Math.min(6, orderedSlugs.length); i++) {
        rows.push({ slug: orderedSlugs[i], wr: null, games: null });
      }

      // orez na 6
      return rows.slice(0, 6);
    }

    for (const role of ROLES) {
      const card = findCard(role);
      if (!card) { out[role] = []; continue; }
      out[role] = extractFromCard(card);
    }

    return out;
  });
}

/* ---------- render nášho layoutu ---------- */
function renderHTML(label, sections) {
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

  const rowsHTML = rows => rows.map((r,i)=>`
    <tr>
      <td style="width:34px">${String(i+1).padStart(2," ")}</td>
      <td><div class="hero">${r.img?`<img src="${r.img}" alt="${r.name}">`:``}<span>${r.name||"—"}</span></div></td>
      <td class="${(r.wr ?? 0) >= 50 ? 'wr good' : 'wr bad'}">${r.wr!=null ? r.wr.toFixed(1)+'%' : '—'}</td>
      <td>${r.games!=null ? (r.games>=1000 ? Math.round(r.games/100)/10+'k' : r.games) : '—'}</td>
    </tr>`).join("");

  const card = (key, rows) => `
    <div class="card">
      <div class="title">${roleName(key)}</div>
      <table>
        <thead><tr><th>#</th><th>Hero</th><th>WR</th><th>Games</th></tr></thead>
        <tbody>${rowsHTML(rows)}</tbody>
      </table>
    </div>`;

  const grid = sections.map(s => card(s.key, s.rows)).join("");

  return `
  <html><head><meta charset="utf-8"><style>${css}</style></head>
  <body>
    <h1>Dota2ProTracker META • ${label}</h1>
    <div class="grid">${grid}</div>
    <div class="muted">Source: dota2protracker.com • scraped & rendered automatically</div>
  </body></html>`;
}

/* ---------- main ---------- */
async function main() {
  // 1) otvor stránku a vyškrab poradie+WR+games
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: VIEWPORT });
  const page = await ctx.newPage();
  await page.goto(PAGE_URL, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await page.waitForLoadState("networkidle").catch(()=>{});
  await SLEEP(1500);
  const raw = await scrape(page); // { Carry:[{slug,wr,games}…], Mid:[], ... }
  await browser.close();

  // 2) premapuj na náš grid a doplň meno+ikonku z OpenDota podľa slug
  const { bySlug, byName } = await loadHeroMap();
  const ORDER = [
    { src:"Carry", key:"safe" },
    { src:"Mid", key:"mid" },
    { src:"Offlane", key:"off" },
    { src:"Support (4)", key:"soft" },
    { src:"Support (5)", key:"hard" },
  ];

  const sections = ORDER.map(({src, key}) => {
    const source = raw[src] || [];
    // presne 6 – ak je menej, doplníme prázdne riadky (zachová poradie)
    const six = source.slice(0, 6);
    while (six.length < 6) six.push({ slug: null, wr: null, games: null });

    const rows = six.map(item => {
      const wr = parsePct(item.wr);
      const games = parseGames(item.games);

      let name = null, img = null;
      if (item.slug && bySlug.get(item.slug)) {
        const h = bySlug.get(item.slug);
        name = h.name; img = h.img;
      } else if (item.name && byName.get(String(item.name).toLowerCase())) {
        const h = byName.get(String(item.name).toLowerCase());
        name = h.name; img = h.img;
      }
      return { name, img, wr, games };
    });

    return { key, rows };
  });

  // 3) render -> screenshot -> Discord
  const label = new Date().toISOString().slice(0,10);
  const html = renderHTML(label, sections);

  const browser2 = await chromium.launch({ headless: true });
  const ctx2 = await browser2.newContext({ viewport: VIEWPORT });
  const p2 = await ctx2.newPage();
  await p2.setContent(html, { waitUntil: "load" });
  const file = "meta.png";
  await p2.screenshot({ path: file, type: "png", fullPage: true });
  await browser2.close();

  const buf = fs.readFileSync(file);
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
