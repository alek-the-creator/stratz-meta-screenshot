import { chromium } from "playwright";
import fs from "node:fs";

const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const URL = process.env.PAGE_URL || "https://dota2protracker.com/";
const CUSTOM_SELECTOR = process.env.SCREENSHOT_SELECTOR || '';

// viewport a drobné timery
const VIEWPORT_W = Number(process.env.VIEWPORT_W || 1600);
const VIEWPORT_H = Number(process.env.VIEWPORT_H || 1200);
const WAIT_MS    = Number(process.env.WAIT_MS || 2500);
const PAD        = Number(process.env.CLIP_PAD || 8); // okraj v px okolo klipu
const FALLBACK_HEIGHT = Number(process.env.FALLBACK_HEIGHT || 560);

if (!WEBHOOK) throw new Error("Missing DISCORD_WEBHOOK_URL");

async function run() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: VIEWPORT_W, height: VIEWPORT_H },
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36"
  });
  const page = await ctx.newPage();

  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(WAIT_MS);

  // skúsiť zavrieť bannery, nevadí ak neexistujú
  for (const sel of [
    'button:has-text("Accept")','button:has-text("I Agree")','button:has-text("Got it")',
    'div[role="dialog"] button'
  ]) { try { const b = page.locator(sel).first(); if (await b.count()) await b.click({ timeout: 300 }); } catch {} }

  const path = "shot.png";
  let strategy = "fallback-fullpage";

  try {
    // 1) Presný používateľský selektor (ak je zadaný a existuje)
    if (CUSTOM_SELECTOR) {
      const el = page.locator(CUSTOM_SELECTOR).first();
      if (await el.count()) {
        await el.scrollIntoViewIfNeeded();
        await page.waitForTimeout(200);

        if (PAD > 0) {
          const handle = await el.elementHandle();
          const clip = await page.evaluate((node, pad) => {
            const r = node.getBoundingClientRect();
            return {
              x: Math.max(0, r.x - pad),
              y: Math.max(0, r.y - pad),
              width: Math.min(window.innerWidth - r.x + pad, r.width + pad*2),
              height: Math.min(window.innerHeight - r.y + pad, r.height + pad*2)
            };
          }, handle, PAD);
          await page.screenshot({ path, type: "png", clip });
        } else {
          await el.screenshot({ path, type: "png" });
        }
        strategy = "custom-selector";
      }
    }

    // 2) Heading → bottom text (ak 1) neprešlo)
    if (strategy === "fallback-fullpage") {
      const title = page.getByRole("heading", { name: /Most Successful Heroes by Role/i }).first();
      const bottom = page.locator('text=/Find an in-depth analysis/i').first();

      if (await title.count() && await bottom.count()) {
        await title.scrollIntoViewIfNeeded();
        await page.waitForTimeout(200);

        const [tHandle, bHandle] = await Promise.all([title.elementHandle(), bottom.elementHandle()]);
        const clip = await page.evaluate((t, b, pad) => {
          function ancestors(el){ const a=[]; while(el){ a.push(el); el=el.parentElement; } return a; }
          const ta = ancestors(t), ba = ancestors(b);
          const set = new Set(ta);
          const common = ba.find(el => set.has(el)) || document.body;
          const r = common.getBoundingClientRect();
          return {
            x: Math.max(0, r.x - pad),
            y: Math.max(0, r.y - pad),
            width: Math.min(window.innerWidth - r.x + pad, r.width + pad*2),
            height: Math.min(window.innerHeight - r.y + pad, r.height + pad*2)
          };
        }, tHandle, bHandle, PAD);

        await page.screenshot({ path, type: "png", clip });
        strategy = "title-to-bottom";
      }
    }

    // 3) Heading + pevná výška (ak 2) neprešlo)
    if (strategy === "fallback-fullpage") {
      const title = page.getByRole("heading", { name: /Most Successful Heroes by Role/i }).first();
      if (await title.count()) {
        await title.scrollIntoViewIfNeeded();
        await page.waitForTimeout(200);

        const clip = await page.evaluate((node, pad, h) => {
          const r = node.getBoundingClientRect();
          const yTop = Math.max(0, r.top - pad);
          return {
            x: Math.max(0, 0 + pad),
            y: yTop,
            width: Math.min(window.innerWidth - pad*2, window.innerWidth - pad*2),
            height: Math.min(h + pad*2, window.innerHeight - yTop)
          };
        }, await title.elementHandle(), PAD, FALLBACK_HEIGHT);

        await page.screenshot({ path, type: "png", clip });
        strategy = "title-fixed-height";
      }
    }

    // 4) Posledný úplný fallback – fullPage
    if (strategy === "fallback-fullpage") {
      await page.screenshot({ path, type: "png", fullPage: true });
    }
  } catch {
    await page.screenshot({ path, type: "png", fullPage: true });
    strategy = "exception-fullpage";
  }

  await browser.close();

  // -> Discord
  const buf = fs.readFileSync(path);
  const form = new FormData();
  form.append("payload_json", JSON.stringify({
    username: "Web Snapshot",
    embeds: [{
      title: "Most Successful Heroes by Role — dota2protracker.com",
      description: `URL: ${URL}\nSelector: ${CUSTOM_SELECTOR || "(none)"}\nStrategy: ${strategy}`,
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
    }).catch(()=>{});
  }
  process.exit(1);
});
