// Section-screenshot -> Discord webhook (Playwright)
import { chromium } from "playwright";
import fs from "node:fs";

const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const URL = process.env.PAGE_URL || "https://dota2protracker.com/";

if (!WEBHOOK) throw new Error("Missing DISCORD_WEBHOOK_URL");

const VIEWPORT_W = 1600;
const VIEWPORT_H = 1200;
const WAIT_MS = 2500;

async function run() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
    viewport: { width: VIEWPORT_W, height: VIEWPORT_H }
  });
  const page = await ctx.newPage();

  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(WAIT_MS);

  // Skús potlačiť sticky header/ads, aby nezakrývali sekciu (best-effort).
  await page.addStyleTag({
    content: `
      header, .sticky, .fixed, [class*="sticky"], [class*="Fixed"], [class*="fixed"] { z-index: 0 !important; }
      [aria-label*="ad"], .ad, .ads, [id*="ad"] { display:none !important; }
    `
  }).catch(()=>{});

  // Lokátory kontajnera so sekciou "Most Successful Heroes by Role"
  const section = page.locator([
    'section:has(h2:has-text("Most Successful Heroes by Role"))',
    'section:has(h3:has-text("Most Successful Heroes by Role"))',
    'div:has(h2:has-text("Most Successful Heroes by Role"))',
    'div:has(h3:has-text("Most Successful Heroes by Role"))'
  ].join(', ')).first();

  const path = "shot.png";

  try {
    if (await section.count()) {
      await section.scrollIntoViewIfNeeded();
      // malá pauza na layout/animácie
      await page.waitForTimeout(300);
      // ELEMENT screenshot – Playwright sám poscrolluje a oreže presne kontajner
      await section.screenshot({ path, type: "png" });
    } else {
      // ak by nadpis zmenili, sprav aspoň fullpage fallback
      await page.screenshot({ path, type: "png", fullPage: true });
    }
  } catch (e) {
    // posledný fallback
    await page.screenshot({ path, type: "png", fullPage: true });
  }

  await browser.close();

  // pošli do Discordu
  const buf = fs.readFileSync(path);
  const form = new FormData();
  form.append("payload_json", JSON.stringify({
    username: "Web Snapshot",
    embeds: [{
      title: "Most Successful Heroes by Role — dota2protracker.com",
      description: URL,
      image: { url: "attachment://shot.png" }
    }]
  }));
  form.append("file", new Blob([buf], { type: "image/png" }), "shot.png");

  const res = await fetch(WEBHOOK, { method: "POST", body: form });
  if (!res.ok) throw new Error(`Discord webhook failed: ${res.status}`);
}

run().catch(async (e) => {
  console.error(e);
  if (WEBHOOK) {
    await fetch(WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "Web Snapshot",
        embeds: [{ title: "Snapshot error", description: String(e) }]
      })
    }).catch(() => {});
  }
  process.exit(1);
});
