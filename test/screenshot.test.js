import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chromium } from "playwright";
import { META_SELECTOR, findMetaTarget, inspectMetaElement, prepareMeta, snapshotMeta, captureMeta, validatePng, sendScreenshot } from "../screenshot.js";

let browser, page;
const image = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><rect width="40" height="30" fill="#448899"/></svg>';
const roles = ["Carry", "Mid", "Offlane", "Support", "Hard Support"];
function fixture({ rows = 5, patch = "7.41f", tracking = true } = {}) {
  return `<html><head><base href="http://fixture.test/"><style>
    body{margin:20px;background:#111;color:white;font:16px Arial}section.meta{width:1250px;background:#222}
    header{padding:10px;height:90px}h2{margin:0}.grid{display:flex}.column{width:250px}.role{height:55px}
    a.hero{display:block;height:90px;color:white;text-decoration:none}.portrait{width:50px;height:35px}
    .build img{width:28px;height:20px}.build{height:25px}[data-builds=false] .build{display:none}
    .mobile{display:none}button{font-size:16px}
  </style></head><body><main><h1>Welcome</h1>
    <section class="meta" ${tracking ? 'data-track-view="fp-fable-meta-simple"' : ''} data-builds="false">
      <header><h2>Dota 2 Meta ${patch}</h2><p>7000+ MMR Meta · last 8 days</p>
        <button aria-label="Show builds" aria-pressed="false" onclick="this.closest('section').dataset.builds='true';this.setAttribute('aria-pressed','true');this.setAttribute('aria-label','Hide builds');this.textContent='Hide Builds'">Show Builds</button>
      </header><div class="mobile"><a href="/meta?position=pos+1">Full</a><a href="/hero/Hidden">Hidden</a></div>
      <div class="grid">${roles.map((role, i) => `<div class="column"><div class="role"><span>${role}</span><a href="/meta?position=pos+${i+1}">Full</a><div>Matches · Win · Tier + Rating · Build</div></div>
        ${Array.from({ length: rows }, (_, j) => `<a class="hero" href="/hero/Hero-${i}-${j}"><img class="portrait" src="/static/heroes/${i}-${j}.png" alt="Hero ${i}-${j}"><span>7.5K · 52.8% <span aria-label="S tier, D2PT Rating 94 out of 100">S 94/100</span></span>
          <div class="build">${Array.from({ length: 6 }, (_, k) => `<img src="/static/items/${k}.png" alt="Item ${k}">`).join("")}52%</div></a>`).join("")}</div>`).join("")}</div>
    </section><section><h2>D2PT Win Prediction</h2><p>Unrelated content must never be captured.</p></section>
  </main></body></html>`;
}

before(async () => { browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}) }); });
after(async () => { await browser?.close(); });
beforeEach(async () => {
  page = await browser.newPage({ viewport: { width: 1600, height: 1600 } });
  await page.route("**/static/**", (route) => route.fulfill({ contentType: "image/svg+xml", body: image }));
  await page.setContent(fixture());
});
afterEach(async () => { await page?.close(); });

test("regression: new Tier + Rating labels never expand the crop to main with D2PT text", async () => {
  assert.equal((await page.locator(META_SELECTOR).innerText()).includes("D2PT"), false);
  const target = await prepareMeta(page);
  const info = await target.evaluate(inspectMetaElement, { builds: true, assets: true, uncovered: true });
  assert.deepEqual(info.counts, [5, 5, 5, 5, 5]);
  assert.equal(await target.getAttribute("class"), "meta");
  const png = await target.screenshot();
  assert.equal(validatePng(png, info).width, 1250);
});

test("a renamed tracking attribute still finds only a validated semantic section", async () => {
  await page.setContent(fixture({ tracking: false, rows: 6, patch: "8.00b" }));
  const target = await prepareMeta(page);
  const info = await target.evaluate(inspectMetaElement);
  assert.equal(info.heading, "Dota 2 Meta 8.00b");
  assert.deepEqual(info.counts, [6, 6, 6, 6, 6]);
});

test("manual selectors cannot bypass validation or select the whole page", async () => {
  for (const selector of ["body", "main", "section"]) await assert.rejects(findMetaTarget(page, selector));
});

test("missing role, missing row, unrelated section and mobile layout are rejected", async () => {
  const mutations = [
    () => document.querySelector(".column").remove(),
    () => document.querySelector(".hero").remove(),
    () => document.querySelector(".meta").insertAdjacentHTML("beforeend", "<h2>Matches</h2>"),
    () => document.querySelector(".grid").style.flexDirection = "column",
    () => document.querySelector(".hero span").textContent = "Loading...",
  ];
  for (const mutation of mutations) {
    await page.setContent(fixture());
    await page.evaluate(mutation);
    await assert.rejects(findMetaTarget(page));
  }
});

test("partially loaded images and missing builds are rejected", async () => {
  let target = await prepareMeta(page);
  await page.route("**/static/heroes/broken.png", (route) => route.fulfill({ status: 404, body: "missing" }));
  await target.evaluate(async (el) => {
    const img = el.querySelector(".portrait");
    img.src = "/static/heroes/broken.png";
    await img.decode().catch(() => {});
  });
  await assert.rejects(target.evaluate(inspectMetaElement), /images have not loaded/);
  await page.setContent(fixture());
  target = await prepareMeta(page);
  await target.evaluate((el) => el.querySelector(".build").remove());
  await assert.rejects(target.evaluate(inspectMetaElement), /incomplete build/);
});

test("a dialog covering the table is rejected instead of appearing in Discord", async () => {
  const target = await prepareMeta(page);
  await page.evaluate(() => {
    const overlay = document.createElement("div");
    overlay.style = "position:fixed;inset:0;z-index:999999;background:white";
    document.body.append(overlay);
  });
  await assert.rejects(target.evaluate(inspectMetaElement, { builds: true, assets: true, uncovered: true }), /covered/);
});

test("full-page/tall PNGs and PNGs that differ from the validated crop are rejected", async () => {
  const target = await prepareMeta(page);
  const info = await target.evaluate(inspectMetaElement);
  const png = await target.screenshot();
  assert.throws(() => validatePng(Buffer.from("not png"), info));
  assert.throws(() => validatePng(png, { width: 1600, height: 4000 }));
  const tall = Buffer.from(png);
  tall.writeUInt32BE(4000, 20);
  assert.throws(() => validatePng(tall, { width: 1250, height: 4000 }));
});

test("a consent dialog appearing during capture is dismissed and the image is retaken", async () => {
  let captures = 0;
  const result = await snapshotMeta(page, "", {
    delay: async () => {},
    screenshot: async (target) => {
      captures++;
      if (captures === 1) await page.evaluate(() => {
        const overlay = document.createElement("div");
        overlay.style = "position:fixed;inset:0;z-index:999999;background:white";
        overlay.innerHTML = '<button onclick="this.parentElement.remove()">Do not consent</button>';
        document.body.append(overlay);
      });
      return target.screenshot();
    },
  });
  assert.equal(captures, 2);
  assert.equal(result.metadata.width, 1250);
  assert.equal(await page.getByRole("button", { name: "Do not consent" }).count(), 0);
});

test("transient source failure retries a new page; exhausted failures produce no image", async () => {
  let visits = 0;
  const server = createServer((req, res) => {
    if (req.url.startsWith("/static/")) { res.writeHead(200, { "Content-Type": "image/svg+xml" }); res.end(image); }
    else if (req.url === "/" && ++visits > 1) { res.writeHead(200, { "Content-Type": "text/html" }); res.end(fixture().replace('<base href="http://fixture.test/">', "")); }
    else { res.writeHead(503); res.end("temporary failure"); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  try {
    const result = await captureMeta(browser, { url, delay: async () => {} });
    assert.equal(visits, 2);
    assert.deepEqual(result.metadata.heroesPerRole, [5, 5, 5, 5, 5]);
    await assert.rejects(captureMeta(browser, { url: `${url}unavailable`, attempts: 2, delay: async () => {} }), /503/);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("Discord sends only one validated image, retries explicit rate limits, confirms receipt", async () => {
  const target = await prepareMeta(page);
  const info = await target.evaluate(inspectMetaElement);
  const png = await target.screenshot();
  let requests = 0, pauses = 0;
  const id = await sendScreenshot("https://discord.com/api/webhooks/test/fake", png, info, {
    delay: async () => { pauses++; },
    request: async (url, options) => {
      requests++;
      assert.equal(new URL(url).searchParams.get("wait"), "true");
      const payload = JSON.parse(options.body.get("payload_json"));
      assert.equal(payload.embeds.length, 1);
      assert.equal(payload.embeds[0].image.url, "attachment://meta.png");
      assert.equal(options.body.get("files[0]").name, "meta.png");
      return requests === 1 ? Response.json({ retry_after: 0.01 }, { status: 429 }) : Response.json({ id: "123", attachments: [{ filename: "meta.png" }] });
    },
  });
  assert.equal(id, "123"); assert.equal(requests, 2); assert.equal(pauses, 1);
});

test("Discord timeout/500/missing acknowledgement are not retried or posted as error messages", async () => {
  const target = await prepareMeta(page);
  const info = await target.evaluate(inspectMetaElement);
  const png = await target.screenshot();
  for (const response of [() => { throw new Error("network"); }, () => new Response("failure", { status: 500 }), () => Response.json({})]) {
    let requests = 0;
    await assert.rejects(sendScreenshot("https://discord.com/api/webhooks/test/fake", png, info, {
      request: async () => { requests++; return response(); },
    }));
    assert.equal(requests, 1);
  }
  let requests = 0;
  await assert.rejects(sendScreenshot("https://discord.com/api/webhooks/test/fake", Buffer.from("bad"), info, { request: async () => { requests++; } }));
  assert.equal(requests, 0);
});

test("Discord may return an embedded CDN image with no standalone attachments", async () => {
  const target = await prepareMeta(page);
  const info = await target.evaluate(inspectMetaElement);
  const png = await target.screenshot();
  for (const host of ["cdn.discordapp.com", "media.discordapp.net"]) {
    const id = await sendScreenshot("https://discord.com/api/webhooks/test/fake", png, info, {
      request: async () => Response.json({ id: "456", attachments: [], embeds: [{ image: {
        url: `https://${host}/attachments/123/456/meta.png?ex=example`, width: info.width, height: info.height,
      } }] }),
    });
    assert.equal(id, "456");
  }
  for (const image of [
    { url: "https://example.com/attachments/123/456/meta.png" },
    { url: "https://cdn.discordapp.com/attachments/123/456/other.png" },
    { url: "https://cdn.discordapp.com/attachments/123/456/meta.png", width: 1600, height: 4000 },
  ]) await assert.rejects(sendScreenshot("https://discord.com/api/webhooks/test/fake", png, info, {
    request: async () => Response.json({ id: "456", attachments: [], embeds: [{ image }] }),
  }), /did not confirm/);
});
