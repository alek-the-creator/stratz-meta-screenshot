// Element-only screenshot (DevTools "Capture node screenshot") -> Discord
import { chromium } from "playwright";
import fs from "node:fs";

const WEBHOOK   = process.env.DISCORD_WEBHOOK_URL;
const PAGE_URL  = process.env.PAGE_URL || "https://dota2protracker.com/";
const SELECTOR  = process.env.SCREENSHOT_SELECTOR || ""; // voliteľne: presný CSS selektor

// Tvoja identita bota a texty
const BOT_NAME    = "Current meta agent";
const AVATAR_URL  = "https://raw.githubusercontent.com/alek-the-creator/stratz-meta-screenshot/main/edited.jpg";
const EMBED_TITLE = "Dnešná meta je:";
const EMBED_DESC  = "Implemented with ♥ by @trauma";

const VIEWPORT_W = Number(process.env.VIEWPORT_W || 1600);
const VIEWPORT_H = Number(process.env.VIEWPORT_H || 1200);
const WAIT_MS    = Number(process.env.WAIT_MS || 2200);

if (!WEBHOOK) throw new Error("Missing DISCORD_WEBHOOK_URL");

async function hideOverlays(page) {
  // 1) hrubé CSS vypnutie bannerov/modálov/ads
  await page.addStyleTag({
    content: `
      /* sticky/fixed bannery a modaly */
      [role="dialog"], [role="alertdialog"],
      .modal, .Modal, .dialog, .Dialog,
      .donate, .Donate, .cookie, .Cookie,
      .banner, .Banner, .popup, .Popup,
      [class*="modal"], [class*="Modal"],
      [class*="dialog"], [class*="Dialog"],
      [class*="donate"], [class*="Donate"],
      [class*="cookie"], [class*="Cookie"],
      [class*="banner"], [class*="Banner"],
      [class*="popup"], [class*="Popup"],
      [id*="modal"], [id*="dialog"], [id*="banner"], [id*="popup"],
      header.sticky, .sticky, .fixed, [class*="sticky"], [class*="Fixed"], [class*="fixed"],
      [aria-label*="ad"], .ad, .ads, [id*="ad"] {
        display: none !important;
        visibility: hidden !important;
        opacity: 0 !important;
      }

      /* všeobecné fixed prvky (reklamy, cookie bar) */
      *[style*="position:fixed"],
      *[style*="position: fixed"],
      *[style*="position:sticky"],
      *[style*="position: sticky"] {
        display: none !important;
      }
    `
  }).catch(()=>{});

  // 2) pre istotu stlač ESC (niektoré modaly sa zavrú)
  try { await page.keyboard.press("Escape"); } catch {}

  // malé oneskorenie po skrytí
  await page.waitForTimeout(200);
}

async function removeCollisionsWithTarget(page, targetHandle) {
  // odstráň prvky, ktoré sa reálne PREKRÝVAJÚ s cieľovým rectom a sú fixed/sticky s vysokým z-indexom
  await page.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const intersects = (r) =>
      !(r.right < rect.left || r.left > rect.right || r.bottom < rect.top || r.top > rect.bottom);

    const all = Array.from(document.querySelectorAll("div,section,aside,header,footer"));
    for (const node of all) {
      if (el.contains(node)) continue; // neodstráňaj časť targetu
      const style = getComputedStyle(node);
      const pos = style.position;
      const zi  = parseInt(style.zIndex || "0", 10);
      if ((pos === "fixed" || pos === "sticky") && zi >= 10) {
        const r = node.getBoundingClientRect();
        if (r.width > 40 && r.height > 40 && intersects(r)) {
          node.remove();
        }
      }
    }
  }, targetHandle).catch(()=>{});
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: VIEWPORT_W, height: VIEWPORT_H },
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari"
  });
  const page = await ctx.newPage();

  await page.goto(PAGE_URL, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForLoadState("networkidle").catch(()=>{});
  await page.waitForTimeout(WAIT_MS);

  await hideOverlays(page);

  // 1) cíeľový uzol podľa selektora alebo automaticky podľa nadpisu
  let targetLoc = null;
  if (SELECTOR) {
    const loc = page.locator(SELECTOR).first();
    if (await loc.count()) targetLoc = loc;
  }
  if (!targetLoc) {
    const title = page.getByRole("heading", { name: /Most Successful Heroes by Role/i }).first();
    if (await title.count()) {
      const h = await title.elementHandle();
      const container = await page.evaluateHandle((hEl) => {
        let el = hEl;
        while (el && el.parentElement) {
          const p = el.parentElement;
          const txt = (p.textContent || "");
          const pctCount = (txt.match(/%/g) || []).length;
          const heroLinks = p.querySelectorAll('a[href*="/hero/"]').length;
          if (pctCount >= 12 && heroLinks >= 6) return p; // container celej sekcie
          el = p;
        }
        return hEl;
      }, h);
      targetLoc = container.asElement() ? container.asElement() : title;
    }
  }
  if (!targetLoc) throw new Error("Target element not found");

  const targetHandle = targetLoc.asElement ? targetLoc : await targetLoc.elementHandle();
  await targetHandle.scrollIntoViewIfNeeded();
  await removeCollisionsWithTarget(page, targetHandle);

  // 2) element screenshot
  const outFile = "node.png";
  const locator = targetLoc.screenshot ? targetLoc : page.locator(SELECTOR);
  await locator.screenshot({ path: outFile });

  await browser.close();

  // 3) Discord webhook s vlastným menom a avatarom
  const buf = fs.readFileSync(outFile);
  const form = new FormData();
  form.append("payload_json", JSON.stringify({
    username: BOT_NAME,
    avatar_url: AVATAR_URL,   // musí byť priamy obrázok (raw.githubusercontent.com)
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
  try {
    await fetch(WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: BOT_NAME,
        avatar_url: AVATAR_URL,
        embeds: [{
          title: EMBED_TITLE,
          description: `${EMBED_DESC}\n\n⚠️ Error: ${String(e)}`,
          color: 0xcc0000
        }]
      })
    });
  } catch {}
  process.exit(1);
});
