// Screenshot STRATZ meta/positions → pošli obrázok do Discord webhooku
// Node 20 (GitHub Actions) má global fetch, FormData, Blob

import { chromium } from "playwright";
import fs from "node:fs";

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const URL = "https://stratz.com/heroes/meta/positions";

// uprav, ak chceš iné defaulty v UI:
const RANK_LABEL = "Immortal";
const DATE_LABEL = "Yesterday";

// malé utily
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const todayUtc = new Date(Date.UTC(
  new Date().getUTCFullYear(),
  new Date().getUTCMonth(),
  new Date().getUTCDate()
));
const yLabel = new Date(todayUtc.getTime() - 24*3600*1000).toISOString().slice(0,10);

async function setFilters(page) {
  // pokús sa otvoriť rank filter a kliknúť "Immortal"
  // hľadáme button/dropdown s textom "Rank" alebo aktuálnou hodnotou
  const rankTriggers = [
    page.getByRole("button", { name: /rank|ranks|all ranks|immortal/i }),
    page.locator('button:has-text("Rank"), [role="button"]:has-text("Rank")'),
    page.locator('div[role="combobox"]:has-text("Rank"), div[aria-haspopup="listbox"]')
  ];
  for (const t of rankTriggers) { if (await t.first().count()) { await t.first().click({ timeout: 2000 }).catch(()=>{}); break; } }
  const immortalOpts = [
    page.getByRole("option", { name: new RegExp(RANK_LABEL, "i") }),
    page.locator(`text=${RANK_LABEL}`)
  ];
  for (const o of immortalOpts) { if (await o.first().count()) { await o.first().click({ timeout: 2000 }).catch(()=>{}); break; } }

  // date filter → "Yesterday"
  const dateTriggers = [
    page.getByRole("button", { name: /date|range|period|time/i }),
    page.locator('button:has-text("Date"), [role="button"]:has-text("Date")')
  ];
  for (const t of dateTriggers) { if (await t.first().count()) { await t.first().click({ timeout: 2000 }).catch(()=>{}); break; } }
  const yOpts = [
    page.getByRole("option", { name: new RegExp(DATE_LABEL, "i") }),
    page.locator(`text=${DATE_LABEL}`)
  ];
  for (const o of yOpts) { if (await o.first().count()) { await o.first().click({ timeout: 2000 }).catch(()=>{}); break; } }

  // nech sa prepočíta UI
  await page.waitForLoadState("networkidle").catch(()=>{});
  await sleep(1500);
}

async function takeScreenshot() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
    viewport: { width: 1400, height: 1000 }
  });
  const page = await context.newPage();

  // 1) otvor stránku a nechaj CF challenge prebehnúť
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.waitForLoadState("networkidle", { timeout: 90_000 }).catch(()=>{});
  await sleep(2000);

  // 2) nastav filtre (ak sa podaria nájsť)
  await setFilters(page);

  // 3) skús odfotiť hlavný obsah; ak fail, fullPage
  const path = "meta.png";
  try {
    const main = page.locator("main");
    if (await main.count()) {
      await main.screenshot({ path, type: "png" });
    } else {
      await page.screenshot({ path, type: "png", fullPage: true });
    }
  } catch {
    await page.screenshot({ path, type: "png", fullPage: true });
  }

  await browser.close();
  return path;
}

async function sendToDiscord(imagePath) {
  if (!DISCORD_WEBHOOK_URL) throw new Error("Missing DISCORD_WEBHOOK_URL");

  const buf = fs.readFileSync(imagePath);
  const form = new FormData();
  // embed s obrázkom pripojeným ako "attachment://meta.png"
  form.append("payload_json", JSON.stringify({
    username: "Dota META",
    content: `STRATZ META • ${RANK_LABEL} • ${yLabel}`,
    embeds: [{
      title: `Meta Positions — ${RANK_LABEL} — ${yLabel}`,
      image: { url: "attachment://meta.png" },
      footer: { text: "Source: stratz.com/heroes/meta/positions" }
    }]
  }));
  form.append("file", new Blob([buf], { type: "image/png" }), "meta.png");

  const res = await fetch(DISCORD_WEBHOOK_URL, { method: "POST", body: form });
  if (!res.ok) {
    const t = await res.text().catch(()=> "");
    throw new Error(`Discord webhook failed: ${res.status} ${t}`);
  }
}

(async () => {
  try {
    const file = await takeScreenshot();
    await sendToDiscord(file);
    console.log("OK sent");
  } catch (e) {
    console.error(e);
    // pošli stručnú chybu, nech vieš čo sa stalo
    if (DISCORD_WEBHOOK_URL) {
      await fetch(DISCORD_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "Dota META",
          embeds: [{ title: "STRATZ screenshot", description: "Error: " + (e?.message || e) }]
        })
      }).catch(()=>{});
    }
    process.exit(1);
  }
})();
