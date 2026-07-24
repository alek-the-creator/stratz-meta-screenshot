// Dota 2 Pro Tracker meta + builds screenshot -> Discord webhook

import { chromium } from "playwright";
import fs from "node:fs";

const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const PAGE_URL =
  process.env.PAGE_URL || "https://dota2protracker.com/";

// Voliteľný presný CSS selektor.
// Keď je prázdny, meta sekcia sa nájde automaticky.
const SELECTOR =
  process.env.SCREENSHOT_SELECTOR || "";

// Buildy sú štandardne zapnuté.
// Nastavením ENABLE_BUILDS=0 ich môžeš vypnúť.
const ENABLE_BUILDS =
  process.env.ENABLE_BUILDS !== "0";

const BOT_NAME = "Current meta agent";

const AVATAR_URL =
  "https://raw.githubusercontent.com/alek-the-creator/stratz-meta-screenshot/main/edited.jpg";

const EMBED_TITLE = "Dnešná meta je:";
const EMBED_DESC = "Implemented with ♥ by @trauma";

const VIEWPORT_W =
  Number(process.env.VIEWPORT_W || 1600);

const VIEWPORT_H =
  Number(process.env.VIEWPORT_H || 1200);

const WAIT_MS =
  Number(process.env.WAIT_MS || 3000);

const OUTPUT_FILE = "node.png";

if (!WEBHOOK) {
  throw new Error("Missing DISCORD_WEBHOOK_URL");
}

/**
 * Zjednotenie textu pre jednoduchšie porovnávanie.
 */
function normalizeText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Skryje modály, cookie okná a reklamné iframe.
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
 * Nájde celý kontajner Dota 2 Meta.
 */
async function findMetaTarget(page) {
  /*
   * Manuálny selektor má prednosť.
   */
  if (SELECTOR) {
    const manualTarget =
      page.locator(SELECTOR).first();

    await manualTarget.waitFor({
      state: "visible",
      timeout: 60_000,
    });

    const manualHandle =
      await manualTarget.elementHandle();

    if (manualHandle) {
      return manualHandle;
    }
  }

  /*
   * Počkáme, kým sa vykreslí kompletná meta.
   */
  await page.waitForFunction(
    () => {
      const normalize = (value) =>
        String(value || "")
          .replace(/\s+/g, " ")
          .trim();

      const headingCandidates = Array.from(
        document.querySelectorAll(
          [
            "h1",
            "h2",
            "h3",
            "h4",
            "h5",
            "h6",
            '[class*="title"]',
            '[class*="Title"]',
          ].join(",")
        )
      );

      let title = headingCandidates.find(
        (element) => {
          const text =
            normalize(element.textContent);

          return (
            /^Dota 2 Meta\b/i.test(text) &&
            text.length < 120
          );
        }
      );

      /*
       * Záložné hľadanie, ak title nie je heading.
       */
      if (!title) {
        title = Array.from(
          document.querySelectorAll("div, span")
        ).find((element) => {
          const text =
            normalize(element.textContent);

          return (
            element.children.length <= 3 &&
            /^Dota 2 Meta\b/i.test(text) &&
            text.length < 120
          );
        });
      }

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

      while (
        element &&
        element !== document.body
      ) {
        const text =
          normalize(element.innerText);

        const lowerText =
          text.toLowerCase();

        const hasAllRoles =
          requiredRoles.every((role) =>
            lowerText.includes(
              role.toLowerCase()
            )
          );

        const percentageCount =
          (
            text.match(
              /\d+(?:[.,]\d+)?\s*%/g
            ) || []
          ).length;

        const hasMatches =
          /\bmatches\b/i.test(text);

        const hasWin =
          /\bwin\b/i.test(text);

        const hasD2PT =
          /\bd2pt\b/i.test(text);

        const rect =
          element.getBoundingClientRect();

        const hasReasonableSize =
          rect.width >= 700 &&
          rect.height >= 250;

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
   * Nájdeme konkrétny DOM element.
   */
  const resultHandle =
    await page.evaluateHandle(() => {
      const normalize = (value) =>
        String(value || "")
          .replace(/\s+/g, " ")
          .trim();

      const headingCandidates =
        Array.from(
          document.querySelectorAll(
            [
              "h1",
              "h2",
              "h3",
              "h4",
              "h5",
              "h6",
              '[class*="title"]',
              '[class*="Title"]',
            ].join(",")
          )
        );

      let title =
        headingCandidates.find(
          (element) => {
            const text =
              normalize(
                element.textContent
              );

            return (
              /^Dota 2 Meta\b/i.test(
                text
              ) &&
              text.length < 120
            );
          }
        );

      if (!title) {
        title = Array.from(
          document.querySelectorAll(
            "div, span"
          )
        ).find((element) => {
          const text =
            normalize(
              element.textContent
            );

          return (
            element.children.length <=
              3 &&
            /^Dota 2 Meta\b/i.test(
              text
            ) &&
            text.length < 120
          );
        });
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

      while (
        element &&
        element !== document.body
      ) {
        const text =
          normalize(element.innerText);

        const lowerText =
          text.toLowerCase();

        const hasAllRoles =
          requiredRoles.every((role) =>
            lowerText.includes(
              role.toLowerCase()
            )
          );

        const percentageCount =
          (
            text.match(
              /\d+(?:[.,]\d+)?\s*%/g
            ) || []
          ).length;

        const hasMatches =
          /\bmatches\b/i.test(text);

        const hasWin =
          /\bwin\b/i.test(text);

        const hasD2PT =
          /\bd2pt\b/i.test(text);

        const rect =
          element.getBoundingClientRect();

        const hasReasonableSize =
          rect.width >= 700 &&
          rect.height >= 250;

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

  const target =
    resultHandle.asElement();

  if (!target) {
    await resultHandle
      .dispose()
      .catch(() => {});

    throw new Error(
      'Element "Dota 2 Meta" was not found'
    );
  }

  return target;
}

/**
 * Nájde tlačidlo alebo switch Show Builds.
 */
async function findBuildToggle(page) {
  const candidates = [
    page
      .getByRole("button", {
        name: /show builds|hide builds/i,
      })
      .first(),

    page
      .locator("button")
      .filter({
        hasText:
          /show builds|hide builds/i,
      })
      .first(),

    page
      .getByRole("switch", {
        name: /builds/i,
      })
      .first(),
  ];

  for (const candidate of candidates) {
    const count =
      await candidate
        .count()
        .catch(() => 0);

    if (!count) {
      continue;
    }

    const visible =
      await candidate
        .isVisible()
        .catch(() => false);

    if (visible) {
      return candidate;
    }
  }

  throw new Error(
    'Toggle "Show Builds" was not found'
  );
}

/**
 * Zistí text a stav tlačidla.
 */
async function getToggleDescription(toggle) {
  const innerText =
    await toggle
      .innerText()
      .catch(() => "");

  const ariaLabel =
    await toggle
      .getAttribute("aria-label")
      .catch(() => "");

  const title =
    await toggle
      .getAttribute("title")
      .catch(() => "");

  const ariaChecked =
    await toggle
      .getAttribute("aria-checked")
      .catch(() => "");

  return normalizeText(
    [
      innerText,
      ariaLabel,
      title,
      ariaChecked,
    ].join(" ")
  );
}

/**
 * Zapne buildy, ak ešte nie sú zobrazené.
 */
async function ensureBuildsVisible(page) {
  const toggle =
    await findBuildToggle(page);

  const descriptionBefore =
    await getToggleDescription(toggle);

  console.log(
    `Build toggle before click: "${descriptionBefore}"`
  );

  /*
   * Tlačidlo Hide Builds znamená,
   * že buildy sú už zobrazené.
   */
  if (
    /hide builds/i.test(
      descriptionBefore
    )
  ) {
    console.log(
      "Builds are already visible."
    );

    return;
  }

  /*
   * Niektoré switche majú iba aria-checked.
   */
  if (
    /\btrue\b/i.test(
      descriptionBefore
    )
  ) {
    console.log(
      "Build switch is already enabled."
    );

    return;
  }

  console.log(
    "Clicking Show Builds..."
  );

  await toggle.scrollIntoViewIfNeeded();

  await toggle.click({
    timeout: 15_000,
  });

  /*
   * Čakáme, kým sa text zmení na Hide Builds
   * alebo switch dostane aria-checked=true.
   */
  await page.waitForFunction(
    () => {
      const elements = Array.from(
        document.querySelectorAll(
          [
            "button",
            '[role="button"]',
            '[role="switch"]',
          ].join(",")
        )
      );

      return elements.some(
        (element) => {
          const text = String(
            element.innerText ||
              element.textContent ||
              ""
          )
            .replace(/\s+/g, " ")
            .trim();

          const ariaLabel =
            element.getAttribute(
              "aria-label"
            ) || "";

          const ariaChecked =
            element.getAttribute(
              "aria-checked"
            );

          return (
            /hide builds/i.test(
              `${text} ${ariaLabel}`
            ) ||
            ariaChecked === "true"
          );
        }
      );
    },
    null,
    {
      timeout: 15_000,
    }
  );

  /*
   * Dáme Reactu čas vykresliť riadky buildov.
   */
  await page.waitForTimeout(1200);

  console.log(
    "Builds were enabled successfully."
  );
}

/**
 * Odstráni fixed/sticky elementy,
 * ktoré prekrývajú screenshot.
 */
async function removeCollisionsWithTarget(
  page,
  targetHandle
) {
  await page
    .evaluate((target) => {
      const targetRect =
        target.getBoundingClientRect();

      const intersects = (rect) =>
        !(
          rect.right <=
            targetRect.left ||
          rect.left >=
            targetRect.right ||
          rect.bottom <=
            targetRect.top ||
          rect.top >=
            targetRect.bottom
        );

      const elements = Array.from(
        document.querySelectorAll(
          [
            "div",
            "section",
            "aside",
            "header",
            "footer",
            "iframe",
          ].join(",")
        )
      );

      for (const element of elements) {
        /*
         * Neodstránime nič z meta boxu
         * ani jeho nadradené elementy.
         */
        if (
          target.contains(element) ||
          element.contains(target)
        ) {
          continue;
        }

        const style =
          getComputedStyle(element);

        const position =
          style.position;

        if (
          position !== "fixed" &&
          position !== "sticky"
        ) {
          continue;
        }

        const rect =
          element.getBoundingClientRect();

        if (
          rect.width < 40 ||
          rect.height < 40 ||
          !intersects(rect)
        ) {
          continue;
        }

        const zIndex =
          Number.parseInt(
            style.zIndex || "0",
            10
          );

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
 * Počká na fonty a obrázky
 * v meta sekcii.
 */
async function waitForTargetAssets(
  page,
  targetHandle
) {
  await page
    .evaluate(async () => {
      if (document.fonts?.ready) {
        await document.fonts.ready;
      }
    })
    .catch(() => {});

  await targetHandle
    .evaluate(async (target) => {
      const images = Array.from(
        target.querySelectorAll("img")
      );

      await Promise.all(
        images.map(async (image) => {
          if (image.complete) {
            return;
          }

          await Promise.race([
            new Promise((resolve) => {
              image.addEventListener(
                "load",
                resolve,
                {
                  once: true,
                }
              );

              image.addEventListener(
                "error",
                resolve,
                {
                  once: true,
                }
              );
            }),

            /*
             * Pokazený obrázok nesmie
             * zablokovať celý skript.
             */
            new Promise((resolve) => {
              setTimeout(resolve, 8000);
            }),
          ]);
        })
      );
    })
    .catch(() => {});
}

/**
 * Odošle screenshot na Discord.
 */
async function sendScreenshotToDiscord() {
  const buffer =
    fs.readFileSync(OUTPUT_FILE);

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
            url:
              `attachment://${OUTPUT_FILE}`,
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

  const response = await fetch(
    WEBHOOK,
    {
      method: "POST",
      body: form,
    }
  );

  if (!response.ok) {
    const responseBody =
      await response
        .text()
        .catch(() => "");

    throw new Error(
      `Discord webhook failed: ` +
        `${response.status} ` +
        responseBody
    );
  }
}

/**
 * Pošle chybu do Discord roomky.
 */
async function sendErrorToDiscord(error) {
  if (!WEBHOOK) {
    return;
  }

  const errorText = String(
    error?.stack || error
  );

  await fetch(WEBHOOK, {
    method: "POST",

    headers: {
      "Content-Type":
        "application/json",
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
            `\`\`\`\n` +
            `${errorText.slice(0, 3500)}` +
            `\n\`\`\``,

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

    const context =
      await browser.newContext({
        viewport: {
          width: VIEWPORT_W,
          height: VIEWPORT_H,
        },

        deviceScaleFactor: 1,

        userAgent:
          "Mozilla/5.0 " +
          "(X11; Linux x86_64) " +
          "AppleWebKit/537.36 " +
          "(KHTML, like Gecko) " +
          "Chrome/150.0.0.0 " +
          "Safari/537.36",
      });

    const page =
      await context.newPage();

    page.setDefaultTimeout(60_000);

    await page.goto(PAGE_URL, {
      waitUntil: "domcontentloaded",
      timeout: 120_000,
    });

    /*
     * Reklamné requesty môžu bežať stále,
     * preto networkidle nesmie zastaviť skript.
     */
    await page
      .waitForLoadState("networkidle", {
        timeout: 15_000,
      })
      .catch(() => {});

    await page.waitForTimeout(WAIT_MS);

    await hideOverlays(page);

    let targetHandle =
      await findMetaTarget(page);

    await targetHandle
      .scrollIntoViewIfNeeded();

    await page.waitForTimeout(700);

    await removeCollisionsWithTarget(
      page,
      targetHandle
    );

    await waitForTargetAssets(
      page,
      targetHandle
    );

    /*
     * Zapneme buildy.
     */
    if (ENABLE_BUILDS) {
      await ensureBuildsVisible(page);

      /*
       * Kliknutie môže spôsobiť React re-render,
       * preto starý element znova nájdeme.
       */
      await targetHandle
        .dispose()
        .catch(() => {});

      targetHandle =
        await findMetaTarget(page);

      await targetHandle
        .scrollIntoViewIfNeeded();

      await page.waitForTimeout(700);

      await removeCollisionsWithTarget(
        page,
        targetHandle
      );

      await waitForTargetAssets(
        page,
        targetHandle
      );
    }

    /*
     * Posledná pauza na stabilizáciu layoutu.
     */
    await page.waitForTimeout(700);

    await targetHandle.screenshot({
      path: OUTPUT_FILE,
      animations: "disabled",
      caret: "hide",
      timeout: 60_000,
    });

    console.log(
      `Screenshot saved as ${OUTPUT_FILE}`
    );

    await sendScreenshotToDiscord();

    console.log(
      "Screenshot successfully sent to Discord."
    );

    await targetHandle
      .dispose()
      .catch(() => {});
  } finally {
    if (browser) {
      await browser
        .close()
        .catch(() => {});
    }
  }
}

run().catch(async (error) => {
  console.error(error);

  try {
    await sendErrorToDiscord(error);
  } catch (discordError) {
    console.error(
      "Failed to send error to Discord:",
      discordError
    );
  }

  process.exit(1);
});
