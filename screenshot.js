// Dota 2 Pro Tracker meta screenshot -> Discord webhook

import { chromium } from "playwright";
import fs from "node:fs";

const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const PAGE_URL = process.env.PAGE_URL || "https://dota2protracker.com/";

// Voliteľný presný CSS selektor.
// Keď zostane prázdny, meta sekcia sa nájde automaticky.
const SELECTOR = process.env.SCREENSHOT_SELECTOR || "";

const BOT_NAME = "Current meta agent";
const AVATAR_URL =
  "https://raw.githubusercontent.com/alek-the-creator/stratz-meta-screenshot/main/edited.jpg";

const EMBED_TITLE = "Dnešná meta je:";
const EMBED_DESC = "Implemented with ♥ by @trauma";

const VIEWPORT_W = Number(process.env.VIEWPORT_W || 1600);
const VIEWPORT_H = Number(process.env.VIEWPORT_H || 1200);
const WAIT_MS = Number(process.env.WAIT_MS || 3000);

const OUTPUT_FILE = "node.png";

if (!WEBHOOK) {
  throw new Error("Missing DISCORD_WEBHOOK_URL");
}

/**
 * Skryje cookie okná, reklamy a modály.
 *
 * Zámerne už neschovávame všetky elementy obsahujúce slovo
 * "banner", pretože web môže používať podobnú triedu aj pre obsah.
 */
async function hideOverlays(page) {
  await page
    .addStyleTag({
      content: `
        [role="dialog"],
        [role="alertdialog"],
        [aria-modal="true"],

        .modal,
        .Modal,
        .dialog,
        .Dialog,
        .popup,
        .Popup,

        [class*="cookie-consent"],
        [class*="CookieConsent"],
        [class*="cookie-modal"],
        [class*="CookieModal"],

        [id*="cookie-consent"],
        [id*="cookieConsent"],

        iframe[src*="doubleclick"],
        iframe[src*="googlesyndication"],
        iframe[title*="advertisement" i],
        iframe[aria-label*="advertisement" i] {
          display: none !important;
          visibility: hidden !important;
          opacity: 0 !important;
          pointer-events: none !important;
        }

        body {
          overflow: auto !important;
        }
      `,
    })
    .catch(() => {});

  try {
    await page.keyboard.press("Escape");
  } catch {
    // Nie každý web reaguje na Escape.
  }

  await page.waitForTimeout(300);
}

/**
 * Nájde element obsahujúci celý meta prehľad:
 * Carry, Mid, Offlane, Support a Hard Support.
 */
async function findMetaTarget(page) {
  /*
   * Manuálny selektor má prednosť.
   */
  if (SELECTOR) {
    const manualTarget = page.locator(SELECTOR).first();

    await manualTarget.waitFor({
      state: "visible",
      timeout: 60_000,
    });

    const manualHandle = await manualTarget.elementHandle();

    if (manualHandle) {
      return manualHandle;
    }
  }

  /*
   * Počkáme, kým sa na stránke objaví kompletný meta element.
   */
  await page.waitForFunction(
    () => {
      const normalize = (value) =>
        String(value || "")
          .replace(/\s+/g, " ")
          .trim();

      const findTitle = () => {
        const preferredCandidates = Array.from(
          document.querySelectorAll(
            'h1, h2, h3, h4, h5, h6, [class*="title"], [class*="Title"]'
          )
        );

        let title = preferredCandidates.find((element) => {
          const text = normalize(element.textContent);

          return /^Dota 2 Meta\b/i.test(text) && text.length < 120;
        });

        if (title) {
          return title;
        }

        /*
         * Záložné hľadanie pre prípad, že web prestane používať heading.
         */
        const allElements = Array.from(document.querySelectorAll("div, span"));

        return allElements.find((element) => {
          const text = normalize(element.textContent);

          return (
            element.children.length <= 3 &&
            /^Dota 2 Meta\b/i.test(text) &&
            text.length < 120
          );
        });
      };

      const title = findTitle();

      if (!title) {
        return false;
      }

      const requiredRoles = [
        "Carry",
        "Mid",
        "Offlane",
        "Support",
        "Hard Support",
      ];

      let element = title;

      while (element && element !== document.body) {
        const text = normalize(element.innerText);
        const lowerText = text.toLowerCase();

        const hasAllRoles = requiredRoles.every((role) =>
          lowerText.includes(role.toLowerCase())
        );

        const percentageCount =
          text.match(/\d+(?:[.,]\d+)?\s*%/g)?.length || 0;

        const hasMatches = /\bmatches\b/i.test(text);
        const hasWin = /\bwin\b/i.test(text);
        const hasD2PT = /\bd2pt\b/i.test(text);

        const rect = element.getBoundingClientRect();
        const hasReasonableSize =
          rect.width >= 700 && rect.height >= 250;

        if (
          hasAllRoles &&
          percentageCount >= 10 &&
          hasMatches &&
          hasWin &&
          hasD2PT &&
          hasReasonableSize
        ) {
          return true;
        }

        element = element.parentElement;
      }

      return false;
    },
    null,
    {
      timeout: 60_000,
    }
  );

  /*
   * Po úspešnom čakaní nájdeme a vrátime samotný DOM element.
   */
  const resultHandle = await page.evaluateHandle(() => {
    const normalize = (value) =>
      String(value || "")
        .replace(/\s+/g, " ")
        .trim();

    const preferredCandidates = Array.from(
      document.querySelectorAll(
        'h1, h2, h3, h4, h5, h6, [class*="title"], [class*="Title"]'
      )
    );

    let title = preferredCandidates.find((element) => {
      const text = normalize(element.textContent);

      return /^Dota 2 Meta\b/i.test(text) && text.length < 120;
    });

    if (!title) {
      title = Array.from(document.querySelectorAll("div, span")).find(
        (element) => {
          const text = normalize(element.textContent);

          return (
            element.children.length <= 3 &&
            /^Dota 2 Meta\b/i.test(text) &&
            text.length < 120
          );
        }
      );
    }

    if (!title) {
      return null;
    }

    const requiredRoles = [
      "Carry",
      "Mid",
      "Offlane",
      "Support",
      "Hard Support",
    ];

    let element = title;

    while (element && element !== document.body) {
      const text = normalize(element.innerText);
      const lowerText = text.toLowerCase();

      const hasAllRoles = requiredRoles.every((role) =>
        lowerText.includes(role.toLowerCase())
      );

      const percentageCount =
        text.match(/\d+(?:[.,]\d+)?\s*%/g)?.length || 0;

      const hasMatches = /\bmatches\b/i.test(text);
      const hasWin = /\bwin\b/i.test(text);
      const hasD2PT = /\bd2pt\b/i.test(text);

      const rect = element.getBoundingClientRect();
      const hasReasonableSize =
        rect.width >= 700 && rect.height >= 250;

      if (
        hasAllRoles &&
        percentageCount >= 10 &&
        hasMatches &&
        hasWin &&
        hasD2PT &&
        hasReasonableSize
      ) {
        return element;
      }

      element = element.parentElement;
    }

    return null;
  });

  const target = resultHandle.asElement();

  if (!target) {
    await resultHandle.dispose().catch(() => {});
    throw new Error('Element "Dota 2 Meta" was not found');
  }

  return target;
}

/**
 * Odstráni fixed alebo sticky elementy, ktoré prekrývajú screenshot.
 */
async function removeCollisionsWithTarget(page, targetHandle) {
  await page
    .evaluate((target) => {
      const targetRect = target.getBoundingClientRect();

      const intersects = (rect) =>
        !(
          rect.right <= targetRect.left ||
          rect.left >= targetRect.right ||
          rect.bottom <= targetRect.top ||
          rect.top >= targetRect.bottom
        );

      const elements = Array.from(
        document.querySelectorAll(
          "div, section, aside, header, footer, iframe"
        )
      );

      for (const element of elements) {
        /*
         * Neodstránime nič, čo je súčasťou targetu,
         * ani nadradený element targetu.
         */
        if (
          target.contains(element) ||
          element.contains(target)
        ) {
          continue;
        }

        const style = getComputedStyle(element);
        const position = style.position;

        if (position !== "fixed" && position !== "sticky") {
          continue;
        }

        const rect = element.getBoundingClientRect();

        if (
          rect.width < 40 ||
          rect.height < 40 ||
          !intersects(rect)
        ) {
          continue;
        }

        const zIndex = Number.parseInt(style.zIndex || "0", 10);

        /*
         * Fixed element odstránime aj bez explicitného z-indexu.
         * Pri sticky elemente požadujeme aspoň kladný z-index.
         */
        if (
          position === "fixed" ||
          Number.isNaN(zIndex) ||
          zIndex > 0
        ) {
          element.remove();
        }
      }
    }, targetHandle)
    .catch(() => {});
}

/**
 * Počká na načítanie fontov a obrázkov hrdinov.
 */
async function waitForTargetAssets(page, targetHandle) {
  await page
    .evaluate(async () => {
      if (document.fonts?.ready) {
        await document.fonts.ready;
      }
    })
    .catch(() => {});

  await targetHandle
    .evaluate(async (target) => {
      const images = Array.from(target.querySelectorAll("img"));

      await Promise.all(
        images.map(async (image) => {
          if (image.complete) {
            return;
          }

          await Promise.race([
            new Promise((resolve) => {
              image.addEventListener("load", resolve, {
                once: true,
              });

              image.addEventListener("error", resolve, {
                once: true,
              });
            }),

            /*
             * Jeden pokazený obrázok nesmie zablokovať celý script.
             */
            new Promise((resolve) => {
              setTimeout(resolve, 8_000);
            }),
          ]);
        })
      );
    })
    .catch(() => {});
}

/**
 * Odošle úspešný screenshot na Discord.
 */
async function sendScreenshotToDiscord() {
  const buffer = fs.readFileSync(OUTPUT_FILE);

  const form = new FormData();

  form.append(
    "payload_json",
    JSON.stringify({
      username: BOT_NAME,
      avatar_url: AVATAR_URL,
      embeds: [
        {
          title: EMBED_TITLE,
          description: EMBED_DESC,
          image: {
            url: `attachment://${OUTPUT_FILE}`,
          },
          color: 0x2b6cb0,
        },
      ],
    })
  );

  form.append(
    "file",
    new Blob([buffer], {
      type: "image/png",
    }),
    OUTPUT_FILE
  );

  const response = await fetch(WEBHOOK, {
    method: "POST",
    body: form,
  });

  if (!response.ok) {
    const responseBody = await response.text().catch(() => "");

    throw new Error(
      `Discord webhook failed: ${response.status} ${responseBody}`
    );
  }
}

/**
 * Odošle chybovú správu na Discord.
 */
async function sendErrorToDiscord(error) {
  if (!WEBHOOK) {
    return;
  }

  const errorText = String(error?.stack || error);

  await fetch(WEBHOOK, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      username: BOT_NAME,
      avatar_url: AVATAR_URL,
      embeds: [
        {
          title: EMBED_TITLE,
          description:
            `${EMBED_DESC}\n\n` +
            `⚠️ **Screenshot error:**\n` +
            `\`\`\`\n${errorText.slice(0, 3500)}\n\`\`\``,
          color: 0xcc0000,
        },
      ],
    }),
  });
}

async function run() {
  let browser;

  try {
    browser = await chromium.launch({
      headless: true,
    });

    const context = await browser.newContext({
      viewport: {
        width: VIEWPORT_W,
        height: VIEWPORT_H,
      },
      deviceScaleFactor: 1,
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/150.0.0.0 Safari/537.36",
    });

    const page = await context.newPage();

    page.setDefaultTimeout(60_000);

    await page.goto(PAGE_URL, {
      waitUntil: "domcontentloaded",
      timeout: 120_000,
    });

    /*
     * Web môže mať permanentné reklamné requesty,
     * preto networkidle nesmie zablokovať script.
     */
    await page
      .waitForLoadState("networkidle", {
        timeout: 15_000,
      })
      .catch(() => {});

    await page.waitForTimeout(WAIT_MS);

    await hideOverlays(page);

    const targetHandle = await findMetaTarget(page);

    await targetHandle.scrollIntoViewIfNeeded();

    /*
     * Pri scrollnutí sa môžu aktivovať sticky bannery,
     * preto ešte chvíľu počkáme a odstránime kolízie.
     */
    await page.waitForTimeout(700);

    await removeCollisionsWithTarget(page, targetHandle);
    await waitForTargetAssets(page, targetHandle);

    /*
     * Krátka pauza pre dokončenie CSS animácií a layoutu.
     */
    await page.waitForTimeout(500);

    await targetHandle.screenshot({
      path: OUTPUT_FILE,
      animations: "disabled",
      caret: "hide",
      timeout: 60_000,
    });

    console.log(`Screenshot saved as ${OUTPUT_FILE}`);

    await sendScreenshotToDiscord();

    console.log("Screenshot successfully sent to Discord.");
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

run().catch(async (error) => {
  console.error(error);

  try {
    await sendErrorToDiscord(error);
  } catch (discordError) {
    console.error("Failed to send error to Discord:", discordError);
  }

  process.exit(1);
});
