// Element-only screenshot (like DevTools "Capture node screenshot") -> Discord
import { chromium } from "playwright";
import fs from "node:fs";

const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const PAGE_URL = process.env.PAGE_URL || "https://dota2protracker.com/";
const SELECTOR = process.env.SCREENSHOT_SELECTOR || ""; // ak chceš, daj sem presný CSS selector

// Tvoje nastavenia výzoru správy
const BOT_NAME   = "Current meta agent";
const AVATAR_URL = "https://raw.githubusercontent.com/alek-the-creator/stratz-meta-screenshot/refs/heads/main/edited.jpg";
const EMBED_TITLE = "Dnešná meta je:";
const EMBED_DESC  = "Implemented with ♥ by @trauma";

const VIEWPORT_W = Number(process.env.VIEWPORT_W || 1600);
const VIEWPORT_H = Number(process.env.VIEWPORT_H || 1200);
const WAIT_MS    = Number(process.env.WAIT_MS || 2000);

if (!WEBHOOK) throw new Error("Missing DISCORD_WEBHOOK_URL");

async function run() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: VIEWPORT_W, height: VIEWPORT_H },
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari"
  });
  const page = await ctx.newPage();

  await page.goto(PAGE_URL, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(WAIT_MS);

  // Skryť sticky/ads, aby nezakrývali uzol
  await page.addStyleTag({
    content: `
      header, .sticky, .fixed, [class*="sticky"], [class*="Fixed"], [class*="fixed"] { z-index: 0 !important; }
      [aria-label*="ad"], .ad, .ads, [id*="ad"] { display:none !important; }
    `
  }).catch(()=>{});

  // Nájsť cieľový uzol (buď presný selector, alebo automaticky podľa nadpisu)
  let target = null;
  if (SELECTOR) {
    const loc = page.locator(SELECTOR).first();
    if (await loc.count()) target = loc;
  }
  if (!target) {
    const title = page.getByRole("heading", { name: /Most Successful Heroes by Role/i }).first();
    if (await title.count()) {
      const handle = await title.elementHandle();
      const container = await page.evaluateHandle((h) => {
        let el = h;
        while (el && el.parentElement) {
          const p = el.parentElement;
          const txt = (p.textContent || "");
          const pctCount = (txt.match(/%/g) || []).length;
          const heroLinks = p.querySelectorAll('a[href*="/hero/"]').length;
          if (pctCount >= 12 && heroLinks >= 6) return p; // pravdepodobne celá sekcia
          el = p;
        }
        return h;
      }, handle);
      target = container.asElement() ? container.asElement() : title;
    }
  }
  if (!target) throw new Error("Target element not found");

  // Element screenshot (ako DevTools "Capture node screenshot")
  const outFile = "node.png";
  const loc = target.screenshot ? target : page.locator(SELECTOR);
  await loc.screenshot({ path: outFile });

  await browser.close();

  // Odoslanie do Discordu
  const buf = fs.readFileSync(outFile);
  const form = new FormData();
  form.append("payload_json", JSON.stringify({
    username: BOT_NAME,
    ...(AVATAR_URL ? { avatar_url: AVATAR_URL } : {}),
    embeds: [{
      title: EMBED_TITLE,
      description: EMBED_DESC,
      image: { url: `attachment://${outFile}` },
      color: 0x2b6cb0
    }]
  }));
  form.append("file", new Blob([buf], { type: "image/png" }), outFile);

  const res = await fetch(WEBHOOK, { method: "POST", body: form });
  if (!res.ok) throw new Error(`Discord webhook failed: ${res.status}`);
}

run().catch(async (e) => {
  console.error(e);
  // aj pri chybe pošleme stručnú hlášku v rovnakom štýle
  try {
    const payload = {
      username: BOT_NAME,
      ...(AVATAR_URL ? { avatar_url: AVATAR_URL } : {}),
      embeds: [{
        title: EMBED_TITLE,
        description: `${EMBED_DESC}\n\n⚠️ Error: ${String(e)}`,
        color: 0xcc0000
      }]
    };
    await fetch(WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch {}
  process.exit(1);
});
