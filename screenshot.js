// Precise section screenshot -> Discord (Playwright)
import { chromium } from "playwright";
import fs from "node:fs";

const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const URL = process.env.PAGE_URL || "https://dota2protracker.com/";
const SELECTOR =
  process.env.SCREENSHOT_SELECTOR ||
  'body > div:nth-child(3) > div.app-container.svelte-se84dv > div.content.svelte-se84dv > main > div > div:nth-child(3) > div';

if (!WEBHOOK) throw new Error("Missing DISCORD_WEBHOOK_URL");

const VIEWPORT_W = Number(process.env.VIEWPORT_W || 1600);
const VIEWPORT_H = Number(process.env.VIEWPORT_H || 1200);
const WAIT_MS    = Number(process.env.WAIT_MS || 2500);
const PAD        = Number(process.env.CLIP_PAD || 8); // voliteľný okraj v px

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

  // potlač sticky/ads (ak by prekrývali sekciu)
  await page.addStyleTag({
    content: `
      header, .sticky, .fixed, [class*="sticky"], [class*="Fixed"], [class*="fixed"] { z-index: 0 !important; }
      [aria-label*="ad"], .ad, .ads, [id*="ad"] { display:none !important; }
    `
  }).catch(()=>{});

  const el = page.locator(SELECTOR).first();
  const path = "shot.png";

  try {
    if (await el.count()) {
      await el.scrollIntoViewIfNeeded();
      await page.waitForTimeout(200);

      // element screenshot je najpresnejší; ak chceš pad, spravíme clip cez boundingClientRect
      if (PAD > 0) {
        const handle = await el.elementHandle();
        const clip = await page.evaluate((node, pad) => {
          const r = node.getBoundingClientRect();
          return {
            x: Math.max(0, r.x - pad),
            y: Math.max(0, r.y - pad),
            width: Math.min(window.innerWidth - r.x + pad, r.width + pad * 2),
            height: Math.min(window.innerHeight - r.y + pad, r.height + pad * 2)
          };
        }, handle, PAD);
        await page.screenshot({ path, type: "png", clip });
      } else {
        await el.screenshot({ path, type: "png" });
      }
    } else {
      // ak selektor nič nenašiel, sprav fallback + dáme vedieť
      await page.screenshot({ path, type: "png", fullPage: true });
    }
  } catch {
    await page.screenshot({ path, type: "png", fullPage: true });
  }

  await browser.close();

  // pošli do Discordu
  const buf = fs.readFileSync(path);
  const form = new FormData();
  form.append(
    "payload_json",
    JSON.stringify({
      username: "Web Snapshot",
      embeds: [
        {
          title: "Section snapshot",
          description: `URL: ${URL}\nSelector: \`${SELECTOR}\``,
          image: { url: "attachment://shot.png" }
        }
      ]
    })
  );
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
