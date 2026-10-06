# Scheduled Web Snapshot

Posts the **live Dota2ProTracker homepage meta table with builds** to the existing Discord webhook. Schedule is unchanged: `0 7 * * *` (07:00 UTC daily; GitHub may delay scheduled jobs).

## What is sent

Only the validated meta component, with the existing bot name and embed text. Heroes, patch and statistics come from that run's live page; no archived image is reused. The site currently shows five heroes per role, whereas its older layout showed six.

The primary selector is `section[data-track-view="fp-fable-meta-simple"]`. If the tracking attribute changes, the script considers only semantic sections with the meta heading, and applies the same validation. It never expands to `main`, `body`, or a whole-page screenshot.

Before AND after capturing, it checks:

- Exactly one meta heading and five separate, horizontally arranged role columns.
- Complete rows, hero portraits, percentages, ratings and item builds in every role.
- Loaded images/fonts, crop dimensions and absence of overlapping dialogs.
- Stable content and geometry during capture, then matching PNG dimensions.

Consent dialogs are rejected using their visible control. A dialog that appears during capture causes a new capture in the same session. Transient page/asset failures get up to three fresh-page attempts. If validation still fails, the Actions run fails and **nothing is posted to Discord**, including error messages. This intentionally prefers a missing update over a wrong picture. An external outage or major redesign cannot be made impossible.

Discord delivery uses `wait=true` to confirm the image attachment. Explicit HTTP 429 rate limits get bounded retries; ambiguous network failures/timeouts are not retried, to avoid duplicate posts. Manual and scheduled runs cannot post concurrently.

## Verify or run

Requires Node 20+ and the matching Playwright browser. CI uses Playwright **1.56.0** in its matching container.

```sh
npm install
npx playwright install chromium
npm test
npm run preview
```

`preview` does not require the Discord secret and never posts. Inspect `artifacts/meta.png` and `artifacts/meta.json`. For a locally installed Chrome, set `BROWSER_CHANNEL=chrome`.

To post, set the existing `DISCORD_WEBHOOK_URL` secret/environment variable and run `npm run run`. Never commit the webhook. Optional `PAGE_URL` and `SCREENSHOT_SELECTOR` overrides still undergo all validation.

GitHub Actions → **Scheduled Web Snapshot** → **Run workflow** defaults to a dry run. Uncheck `dry_run` only when a real post is intended. Scheduled runs continue posting automatically at the original frequency. Every run retains its validated image/metadata or failure reason as a GitHub artifact for seven days; the Discord channel receives only successful images.

## Regression coverage

`npm test` uses an isolated local fixture and simulated Discord responses. Tests cover the changed Tier + Rating label that caused the original full-page bug, renamed tracking attributes, five/six rows, future patch values, broad selectors, incomplete tables/builds/images, mobile layout, overlays including a late consent dialog, source retries, PNG size guards and Discord receipt/rate-limit/timeout handling.
