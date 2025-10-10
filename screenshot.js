import { chromium } from "playwright";
import fs from "node:fs";

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const URL = "https://stratz.com/heroes/meta/positions";
const RANK_LABEL = "Immortal";
const DATE_LABEL = "Yesterday";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const todayUtc = new Date(Date.UTC(
  new Date().getUTCFullYear(),
  new Date().getUTCMonth(),
  new Date().getUTCDate()
));
const yLabel = new Date(todayUtc.getTime() - 24*3600*1000).toISOString().slice(0,10);

async function setFilters(page) {
  const tryClick = async (loc) => { if (await loc.first().count()) await loc.first().click().catch(()=>{}); };

  // Rank
  await tryClick(page.getByRole("button", { name: /rank|ranks|all ranks|immortal/i }));
  await tryClick(page.getByRole("option", { name: new RegExp(RANK_LABEL, "i") }).or(page.locator(`text=${RANK_LABEL}`)));

  // Date
  await tryClick(page.getByRole("button", { name: /date|range|period|time/i }));
  await tryClick(page.getByRole("option", { name: new RegExp(DATE_LABEL, "i") }).or(page.locator(`text=${DATE_LABEL}`)));

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

  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.waitForLoadState("networkidle", { timeout: 90_000 }).catch(()=>{});
  await sleep(2000);

  await setFilters(page);

  const path = "meta.png";
  try {
    const main = page.locator("main");
    if (await main.count()) await main.screenshot({ path, type: "png" });
    else await page.screenshot({ path, type: "png", fullPage: true });
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
  if (!res.ok) throw new Error(`Discord webhook failed: ${res.status} ${await res.text().catch(()=> "")}`);
}

(async () => {
  try {
    const file = await takeScreenshot();
    await sendToDiscord(file);
    console.log("OK sent");
  } catch (e) {
    console.error(e);
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
