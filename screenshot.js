// Element-only screenshot (like DevTools "Capture node screenshot") -> Discord
import { chromium } from "playwright";
import fs from "node:fs";

const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const PAGE_URL = process.env.PAGE_URL || "https://dota2protracker.com/";
const SELECTOR = process.env.SCREENSHOT_SELECTOR || ""; // ak chceš presne tvoj CSS
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

  // (nech nič nezakrýva uzol)
  await page.addStyleTag({
    content: `
      header, .sticky, .fixed, [class*="sticky"], [class*="Fixed"], [class*="fixed"] { z-index: 0 !important; }
      [aria-label*="ad"], .ad, .ads, [id*="ad"] { display:none !important; }`
  }).catch(()=>{});

  // 1) Najdi element: preferuj tvoj CSS selektor; inak automaticky nájdi kontajner tej sekcie
  let target = null;
  if (SELECTOR) {
    const loc = page.locator(SELECTOR).first();
    if (await loc.count()) target = loc;
  }
  if (!target) {
    // auto: nájdi nadpis a vyšli hore na spoločný kontajner sekcie
    const title = page.getByRole("heading", { name: /Most Successful Heroes by Role/i }).first();
    if (await title.count()) {
      const handle = await title.elementHandle();
      const container = await page.evaluateHandle((h) => {
        // vylez hore, kým rodič neobsahuje viac kariet s percentami
        let el = h;
        while (el && el.parentElement) {
          const p = el.parentElement;
          const txt = (p.textContent || "");
          const pctCount = (txt.match(/%/g) || []).length;
          const heroLinks = p.querySelectorAll('a[href*="/hero/"]').length;
          if (pctCount >= 12 && heroLinks >= 6) return p; // dosť údajov = sekcia
          el = p;
        }
        return h;
      }, handle);
      target = container.asElement() ? container.asElement() : title;
    }
  }
  if (!target) throw new Error("Target element not found");

  // 2) Presne ako DevTools: screenshot iba daného uzla
  const path = "node.png";
  // locator.screenshot automaticky poscrolluje, netreba clip
  const loc = target.asElement ? target : target; // support pre Locator/ElementHandle
  await (loc.screenshot ? loc.screenshot({ path }) : page.locator(SELECTOR).screenshot({ path }));

  await browser.close();

  // 3) Pošli do Discordu
  const buf = fs.readFileSync(path);
  const form = new FormData();
  form.append("payload_json", JSON.stringify({
    username: "Web Snapshot",
    embeds: [{
      title: "Section snapshot",
      description: `URL: ${PAGE_URL}\nSelector: ${SELECTOR || "(auto by heading)"}`,
      image: { url: "attachment://node.png" }
    }]
  }));
  form.append("file", new Blob([buf], { type: "image/png" }), "node.png");
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
