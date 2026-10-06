// Capture ONLY the validated live meta component. Never fall back to a page screenshot.
import { chromium } from "playwright";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const META_SELECTOR = 'section[data-track-view="fp-fable-meta-simple"]';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Runs in the browser; keep this function self-contained for both production and tests.
export function inspectMetaElement(root, { builds = true, assets = true, uncovered = false } = {}) {
  const fail = (message) => { throw new Error(`Meta validation: ${message}`); };
  const text = (el) => (el.innerText || "").replace(/\s+/g, " ").trim();
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility === "visible" && s.display !== "none";
  };
  const all = (el, selector) => [...el.querySelectorAll(selector)].filter(visible);
  const rect = root.getBoundingClientRect();
  if (["HTML", "BODY", "MAIN"].includes(root.tagName)) fail("page containers are forbidden");
  if (rect.width < 1000 || rect.width > 1900 || rect.height < 300 || rect.height > 1400 ||
      rect.width / rect.height < 1.05 || rect.width / rect.height > 4) {
    fail(`unexpected component size ${Math.round(rect.width)}x${Math.round(rect.height)}`);
  }
  const headings = all(root, "h1,h2,h3,h4,h5,h6,[role=heading]");
  if (headings.length !== 1 || !/^Dota 2 Meta\s+\d+\.\d+[a-z]?$/i.test(text(headings[0]))) {
    fail("expected exactly one current meta heading and no unrelated sections");
  }
  const heading = text(headings[0]);
  const roles = ["Carry", "Mid", "Offlane", "Support", "Hard Support"];
  const heroLinks = (el) => all(el, 'a[href]').filter((a) => new URL(a.href).pathname.startsWith("/hero/"));
  const positionLinks = all(root, "a[href]").filter((a) => {
    const u = new URL(a.href);
    return u.pathname === "/meta" && /^pos [1-5]$/.test(u.searchParams.get("position") || "");
  });
  if (positionLinks.length !== 5) fail("expected five visible role columns");
  const columns = roles.map((role, i) => {
    const links = positionLinks.filter((a) => new URL(a.href).searchParams.get("position") === `pos ${i + 1}`);
    if (links.length !== 1) fail(`missing or duplicate ${role}`);
    let column = links[0].parentElement;
    while (column && column !== root && heroLinks(column).length === 0) column = column.parentElement;
    if (!column || column === root || positionLinks.filter((a) => column.contains(a)).length !== 1) {
      fail(`cannot isolate ${role} column`);
    }
    if (!all(column, "*").some((el) => el.children.length === 0 && text(el) === role)) fail(`missing ${role} label`);
    const rows = heroLinks(column);
    // The site currently shows five heroes per role (previously six). Do not hardcode heroes or patch.
    if (rows.length < 5 || rows.length > 10) fail(`incomplete/unexpected ${role} rows: ${rows.length}`);
    const heroes = rows.map((row) => {
      const portrait = all(row, "img").filter((img) => /\/heroes\//.test(img.currentSrc || img.src));
      const items = all(row, "img").filter((img) => /\/items\//.test(img.currentSrc || img.src));
      if (portrait.length !== 1 || !portrait[0].alt.trim()) fail(`missing hero portrait in ${role}`);
      const stats = text(row);
      const percentages = [...stats.matchAll(/(\d+(?:\.\d+)?)%/g)].map((m) => Number(m[1]));
      const rating = stats.match(/\b(\d+(?:\.\d+)?)\s*\/\s*100\b/);
      if (!percentages.length || percentages.some((n) => n < 0 || n > 100) || !rating || Number(rating[1]) > 100) {
        fail(`missing/invalid statistics for ${portrait[0].alt}`);
      }
      if (builds && (items.length < 5 || items.length > 6 || percentages.length < 2)) fail(`incomplete build for ${portrait[0].alt}`);
      const r = row.getBoundingClientRect();
      if (r.left < rect.left - 1 || r.right > rect.right + 1 || r.top < rect.top || r.bottom > rect.bottom + 1) {
        fail("hero rows extend outside the crop");
      }
      return { hero: new URL(row.href).pathname, stats, images: all(row, "img").map((img) => img.currentSrc || img.src) };
    });
    if (new Set(heroes.map((h) => h.hero)).size !== rows.length) fail(`duplicate heroes in ${role}`);
    const r = column.getBoundingClientRect();
    return { role, heroes, x: r.x, y: r.y, width: r.width };
  });
  const counts = columns.map((c) => c.heroes.length);
  if (new Set(counts).size !== 1 || heroLinks(root).length !== counts.reduce((a, b) => a + b, 0)) {
    fail("extra or missing hero rows outside the five columns");
  }
  for (let i = 1; i < columns.length; i++) {
    if (columns[i].x < columns[i - 1].x + columns[i - 1].width - 2 || Math.abs(columns[i].y - columns[0].y) > 3) {
      fail("roles are not arranged side by side in desktop layout");
    }
  }
  if (builds) {
    const toggles = all(root, "button,[role=switch]").filter((b) => /hide builds/i.test(`${text(b)} ${b.getAttribute("aria-label") || ""}`));
    if (toggles.length !== 1 || toggles[0].getAttribute("aria-pressed") === "false" || toggles[0].getAttribute("aria-checked") === "false") {
      fail("builds are not enabled in this component");
    }
  }
  const images = all(root, "img");
  if (assets && images.some((img) => !img.complete || img.naturalWidth === 0)) fail("images have not loaded successfully");
  if (assets && document.fonts.status !== "loaded") fail("fonts have not loaded");
  if (uncovered) {
    // Check a grid across the crop, including its header and rows, for cookie dialogs/ads.
    for (const fx of [0.02, 0.25, 0.5, 0.75, 0.98]) {
      for (const fy of [0.02, 0.15, 0.35, 0.6, 0.85, 0.98]) {
        const x = rect.left + rect.width * fx, y = rect.top + rect.height * fy;
        const hit = document.elementFromPoint(x, y);
        if (!hit || !root.contains(hit)) fail("component is covered or outside the viewport");
      }
    }
    if (all(root, "iframe").length) fail("unexpected embedded frame inside the meta component");
  }
  return {
    heading, counts, width: rect.width, height: rect.height, imageCount: images.length,
    fingerprint: JSON.stringify({ heading, columns }),
  };
}

export async function findMetaTarget(page, selector = "") {
  await page.getByRole("heading", { name: /^Dota 2 Meta\s+\d+\./i }).waitFor({ timeout: 30000 });
  const preferred = page.locator(selector || META_SELECTOR).filter({ visible: true });
  const count = await preferred.count();
  if (count > 1 || (selector && count !== 1)) throw new Error("Meta selector must match exactly one visible component");
  if (count === 1) {
    await preferred.evaluate(inspectMetaElement, { builds: false, assets: false });
    return preferred;
  }
  // A tracking attribute may be renamed. Only consider semantic sections, never arbitrary ancestors.
  const candidates = page.locator('section,article,[role="region"]').filter({
    has: page.getByRole("heading", { name: /^Dota 2 Meta\s+\d+\./i }),
    visible: true,
  });
  const valid = [];
  for (const candidate of await candidates.all()) {
    try {
      const info = await candidate.evaluate(inspectMetaElement, { builds: false, assets: false });
      valid.push({ candidate, area: info.width * info.height });
    } catch { /* Invalid sections are never screenshot candidates. */ }
  }
  valid.sort((a, b) => a.area - b.area);
  if (!valid.length || (valid.length > 1 && valid[0].area === valid[1].area)) {
    throw new Error("No unambiguous validated meta section found; refusing to capture the page");
  }
  console.log("Using validated semantic-section fallback (tracking selector changed).");
  return valid[0].candidate;
}

async function dismissConsent(page) {
  // Use the site's privacy control instead of deleting arbitrary page elements.
  const reject = page.getByRole("button", { name: /^(Do not consent|Reject all|Reject optional cookies)$/i });
  if (await reject.count() === 1 && await reject.isVisible()) await reject.click({ timeout: 5000 });
}

export async function prepareMeta(page, selector = "") {
  await dismissConsent(page);
  let target = await findMetaTarget(page, selector);
  await target.scrollIntoViewIfNeeded();
  const show = target.getByRole("button", { name: /^show builds$/i });
  if (await show.count() === 1) {
    await dismissConsent(page);
    await show.click({ timeout: 10000 });
  }
  // The component can be replaced by the site's framework when the toggle changes.
  target = await findMetaTarget(page, selector);
  await target.getByRole("button", { name: /^hide builds$/i }).waitFor({ timeout: 15000 });
  await target.evaluate((root) => {
    for (const img of root.querySelectorAll("img")) img.loading = "eager";
  });
  await target.scrollIntoViewIfNeeded();
  await page.mouse.move(0, 0);
  let lastError;
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      await dismissConsent(page);
      await target.evaluate(inspectMetaElement, { builds: true, assets: true, uncovered: true });
      return target;
    } catch (error) { lastError = error; }
    await sleep(500);
  }
  throw lastError;
}

export function validatePng(buffer, expected) {
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      buffer.toString("ascii", 12, 16) !== "IHDR") throw new Error("Not a PNG screenshot");
  const width = buffer.readUInt32BE(16), height = buffer.readUInt32BE(20);
  if (Math.abs(width - expected.width) > 2 || Math.abs(height - expected.height) > 2 ||
      width < 1000 || width > 1900 || height < 300 || height > 1400 || width / height < 1.05 || width / height > 4 ||
      buffer.length > 9 * 1024 * 1024) throw new Error(`Invalid screenshot dimensions/size: ${width}x${height}`);
  return { width, height, bytes: buffer.length };
}

export async function snapshotMeta(page, selector = "", {
  screenshot = (target) => target.screenshot({ type: "png", animations: "disabled", caret: "hide", timeout: 15000 }),
  delay = sleep,
} = {}) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const target = await prepareMeta(page, selector);
      const before = await target.evaluate(inspectMetaElement, { builds: true, assets: true, uncovered: true });
      const png = await screenshot(target);
      const after = await target.evaluate(inspectMetaElement, { builds: true, assets: true, uncovered: true });
      if (before.fingerprint !== after.fingerprint || before.width !== after.width || before.height !== after.height) {
        throw new Error("Meta changed while taking the screenshot");
      }
      const dimensions = validatePng(png, after);
      return { png, metadata: { source: page.url(), capturedAt: new Date().toISOString(), heading: after.heading, heroesPerRole: after.counts, imageCount: after.imageCount, ...dimensions } };
    } catch (error) { lastError = error; }
    // A consent dialog can appear DURING the screenshot. Dismiss and recapture in the same
    // session, so reloading does not repeatedly reset the consent dialog's delayed appearance.
    if (attempt < 2) { await dismissConsent(page); await delay(750); }
  }
  throw lastError;
}

export async function captureMeta(browser, { url, selector = "", attempts = 3, delay = sleep } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const context = await browser.newContext({
      viewport: { width: 1600, height: 1600 }, deviceScaleFactor: 1, locale: "en-US", reducedMotion: "reduce",
      // Preserve the previous script's desktop-browser compatibility, using the actual engine version.
      userAgent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browser.version()} Safari/537.36`,
    });
    try {
      const page = await context.newPage();
      const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      if (!response?.ok()) throw new Error(`Source returned HTTP ${response?.status() ?? "unknown"}`);
      if (new URL(page.url()).origin !== new URL(url).origin) throw new Error("Source redirected to another website");
      return await snapshotMeta(page, selector);
    } catch (error) {
      lastError = error;
      console.error(`Capture attempt ${attempt}/${attempts} failed: ${error.message}`);
    } finally { await context.close(); }
    if (attempt < attempts) await delay(attempt * 3000);
  }
  throw lastError;
}

export async function sendScreenshot(webhook, png, metadata, { request = fetch, delay = sleep } = {}) {
  validatePng(png, metadata);
  const url = new URL(webhook);
  if (url.protocol !== "https:" || !["discord.com", "discordapp.com"].includes(url.hostname) || !url.pathname.startsWith("/api/webhooks/")) {
    throw new Error("Invalid Discord webhook configuration");
  }
  url.searchParams.set("wait", "true");
  for (let attempt = 0; attempt < 3; attempt++) {
    const form = new FormData();
    form.append("payload_json", JSON.stringify({
      username: "Current meta agent",
      avatar_url: "https://raw.githubusercontent.com/alek-the-creator/stratz-meta-screenshot/main/edited.jpg",
      allowed_mentions: { parse: [] },
      embeds: [{ title: "Dnešná meta je:", description: "Implemented with ♥ by @trauma", color: 3447003, image: { url: "attachment://meta.png" } }],
      attachments: [{ id: 0, filename: "meta.png" }],
    }));
    form.append("files[0]", new Blob([png], { type: "image/png" }), "meta.png");
    let response;
    try {
      response = await request(url.toString(), { method: "POST", body: form, signal: AbortSignal.timeout(30000) });
    } catch {
      // A timed-out POST may already have been delivered. Do not create duplicate messages.
      throw new Error("Discord delivery was not confirmed; not retrying an ambiguous POST");
    }
    if (response.status === 429 && attempt < 2) {
      const body = await response.json().catch(() => ({}));
      const seconds = Number(body.retry_after ?? response.headers.get("retry-after"));
      if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 60) throw new Error("Discord rate limit exceeds bounded retry window");
      await delay(Math.ceil(seconds * 1000) + 250);
      continue;
    }
    if (!response.ok) throw new Error(`Discord returned HTTP ${response.status}; no error message was posted`);
    const receipt = await response.json().catch(() => null);
    // Discord can consume an attachment into the embed and return an empty attachments array.
    // See https://github.com/discord/discord-api-docs/discussions/3231
    const attached = receipt?.attachments?.some((a) => a.filename === "meta.png");
    const embedded = receipt?.embeds?.some((embed) => {
      try {
        const image = embed.image;
        const imageUrl = new URL(image.url);
        return imageUrl.protocol === "https:" &&
          ["cdn.discordapp.com", "media.discordapp.net"].includes(imageUrl.hostname) &&
          /^\/attachments\/.*\/meta\.png$/.test(imageUrl.pathname) &&
          (image.width === undefined || Math.abs(image.width - metadata.width) <= 2) &&
          (image.height === undefined || Math.abs(image.height - metadata.height) <= 2);
      } catch { return false; }
    });
    if (!receipt?.id || (!attached && !embedded)) {
      throw new Error("Discord did not confirm the image attachment; not retrying an ambiguous POST");
    }
    return receipt.id;
  }
}

export async function run(env = process.env) {
  const dryRun = env.DRY_RUN === "true" || env.DRY_RUN === "1" || process.argv.includes("--dry-run");
  await mkdir("artifacts", { recursive: true });
  // Never reuse yesterday's image if today's capture fails.
  for (const file of ["meta.png", "meta.json", "failure.txt"]) await rm(`artifacts/${file}`, { force: true });
  if (!dryRun && !env.DISCORD_WEBHOOK_URL) throw new Error("Missing DISCORD_WEBHOOK_URL");
  const browser = await chromium.launch({ headless: true, ...(env.BROWSER_CHANNEL ? { channel: env.BROWSER_CHANNEL } : {}) });
  let capture;
  try {
    capture = await captureMeta(browser, { url: env.PAGE_URL || "https://dota2protracker.com/", selector: env.SCREENSHOT_SELECTOR || "" });
  } finally { await browser.close(); }
  await writeFile("artifacts/meta.png", capture.png);
  await writeFile("artifacts/meta.json", JSON.stringify(capture.metadata, null, 2));
  console.log(`Validated ${capture.metadata.heading}: ${capture.metadata.heroesPerRole.join("/")} heroes, ${capture.metadata.width}x${capture.metadata.height}, ${capture.metadata.imageCount} loaded images.`);
  if (dryRun) console.log("Dry run: no Discord request was made.");
  else {
    const id = await sendScreenshot(env.DISCORD_WEBHOOK_URL, capture.png, capture.metadata);
    console.log(`Discord confirmed image message ${id}.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch(async (error) => {
    // Errors belong in Actions, not in the user's meta-only Discord channel. Never log webhook URLs.
    const message = String(error.message).replace(/https:\/\/(?:discord(?:app)?\.com)\/api\/webhooks\/[^\s"']+/g, "[redacted webhook]");
    console.error(message);
    await mkdir("artifacts", { recursive: true });
    await writeFile("artifacts/failure.txt", message);
    process.exitCode = 1;
  });
}
