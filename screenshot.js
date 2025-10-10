// Section-screenshot -> Discord webhook (Playwright)
// Env: DISCORD_WEBHOOK_URL, PAGE_URL
import { chromium } from "playwright";
import fs from "node:fs";

const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const URL = process.env.PAGE_URL || "https://dota2protracker.com/";

if (!WEBHOOK) throw new Error("Missing DISCORD_WEBHOOK_URL");

const VIEWPORT_W = 1500;   // tuniť podľa potreby
const VIEWPORT_H = 1100;
const WAIT_MS = 2500;      // dáme stránke čas natiahnuť dáta

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

  // Skúsime zavrieť prípadné bannery (best-effort, nevadí ak zlyhá)
  for (const sel of [
    'button:has-text("Accept")',
    'button:has-text("I Agree")',
    'button:has-text("Got it")',
    'div[role="dialog"] button'
  ]) { try { const b = page.locator(sel).first(); if (await b.count()) await b.click({ timeout: 500 }).catch(()=>{}); } catch {} }

  const path = "shot.png";

  try {
    // nájde nadpis a spodný text
    const title = page.locator('text=Most Successful Heroes by Role').first();
    const bottom = page.locator('text=/Find an in-depth analysis of all heroes/i').first();

    if (await title.count() && await bottom.count()) {
      // spočítaj najbližšieho spoločného predka a jeho bounding box
      const [tHandle, bHandle] = await Promise.all([title.elementHandle(), bottom.elementHandle()]);
      const clip = await page.evaluate((t, b) => {
        function ancestors(el){ const a=[]; while(el){ a.push(el); el = el.parentElement; } return a; }
        const ta = ancestors(t), ba = ancestors(b);
        const set = new Set(ta);
        const common = ba.find(el => set.has(el)) || document.body;
        const r = common.getBoundingClientRect();
        // trochu orežeme okraje
        const pad = 12;
        return {
          x: Math.max(0, r.x - pad),
          y: Math.max(0, r.y - pad),
          width: Math.min(window.innerWidth - r.x + pad, r.width + pad*2),
          height: Math.min(window.innerHeight - r.y + pad, r.height + pad*2)
        };
      }, tHandle, bHandle);

      // Posuň sa, aby bol klip určite vo viewporte
      await title.scrollIntoViewIfNeeded().catch(()=>{});
      await page.waitForTimeout(300);

      await page.screenshot({ path, type: "png", clip });
    } else {
      // fallback – celý page
      await page.screenshot({ path, type: "png", fullPage: true });
    }
  } catch {
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
      body: JSON.stringify({ username: "Web Snapshot", embeds: [{ title: "Snapshot error", description: String(e) }] })
    }).catch(()=>{});
  }
  process.exit(1);
});
