#!/usr/bin/env node
// Watches the Berlin Serviceportal for free Einschulungsuntersuchung slots
// at the Lichtenberg Kinder- und Jugendgesundheitsdienst.
//
//   Service:  324254  Einschulungsuntersuchung
//   Provider: 326385  Gesundheitsamt Lichtenberg, Alfred-Kowalke-Str. 24
//
// The site sits behind a WAF that rejects plain HTTP clients (curl/fetch get
// 403 "Unerwünschter Zugriff"), so a real browser is required. Playwright
// drives Chrome through the same flow a human would.

import { chromium } from "playwright";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

const SERVICE = process.env.ESU_SERVICE ?? "324254";
const PROVIDER = process.env.ESU_PROVIDER ?? "326385";
const BOOKING_URL = `https://service.berlin.de/terminvereinbarung/termin/provider/${PROVIDER}/${SERVICE}/`;

const MIN_INTERVAL = 180; // Berlin's stated minimum refresh
const BACKOFF_MINUTES = [5, 10, 20, 30];

// ---------------------------------------------------------------- arguments

const args = {
  interval: MIN_INTERVAL,
  once: false,
  open: true,
  headful: false,
  verbose: false,
  bundled: false,
  timeout: 30_000,
};

for (const raw of process.argv.slice(2)) {
  if (!raw.startsWith("--")) continue;
  const [key, value] = raw.slice(2).split("=");
  switch (key) {
    case "once": args.once = true; break;
    case "no-open": args.open = false; break;
    case "headful": args.headful = true; break;
    case "verbose": args.verbose = true; break;
    case "bundled": args.bundled = true; break;
    case "interval": args.interval = Math.max(MIN_INTERVAL, Number(value) || MIN_INTERVAL); break;
    case "help":
      console.log(`Usage: node watch.mjs [options]

  --interval=SECONDS  polling interval, minimum ${MIN_INTERVAL} (default ${MIN_INTERVAL})
  --once              check once and exit (0 = check ran, 1 = check failed)
  --no-open           do not open the booking page when a slot appears
  --headful           show the browser window
  --bundled           use Playwright's Chromium instead of system Chrome
  --verbose           log the page URL/title on every check
  --help              this text`);
      process.exit(0);
    default:
      console.warn(`Unknown option --${key}, ignoring`);
  }
}

// ----------------------------------------------------------------- logging

const timeFormat = new Intl.DateTimeFormat("de-DE", {
  timeZone: "Europe/Berlin",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

const log = (...parts) => console.log(`[${timeFormat.format(new Date())}]`, ...parts);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------------------------------------------------------ helpers

class BlockedError extends Error {}

const isoDateFormat = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Berlin" });

function dateFromText(text) {
  const match = /(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(text ?? "");
  if (!match) return null;
  const [, day, month, year] = match;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function dateFromHref(href) {
  // Bookable days link to /terminvereinbarung/termin/time/<unix seconds>/
  const match = /\/(?:day|time|termin)\/(\d{10})/.exec(href ?? "");
  return match ? isoDateFormat.format(new Date(Number(match[1]) * 1000)) : null;
}

function absoluteUrl(href) {
  try {
    return href ? new URL(href, "https://service.berlin.de").toString() : BOOKING_URL;
  } catch {
    return BOOKING_URL;
  }
}

async function notify(title, message) {
  if (process.platform !== "darwin") return;
  const escape = (value) => String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  try {
    await run("osascript", [
      "-e",
      `display notification "${escape(message)}" with title "${escape(title)}" sound name "Glass"`,
    ]);
  } catch (error) {
    log("notification failed:", error.message);
  }
}

// ---------------------------------------------------------------- the check

async function findSlots(browser) {
  const context = await browser.newContext({
    locale: "de-DE",
    timezoneId: "Europe/Berlin",
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(args.timeout);

  try {
    const response = await page.goto(BOOKING_URL, { waitUntil: "domcontentloaded" });
    if (response && response.status() === 403) throw new BlockedError("HTTP 403");

    let body = await page.locator("body").innerText().catch(() => "");
    if (/Unerwünschter Zugriff|Forbidden access/i.test(body)) {
      throw new BlockedError("WAF block page");
    }

    // The provider URL opens a time-restriction form first; "Buchbare Tage
    // anzeigen" submits it and either shows the calendar or /termin/taken/.
    const submit = page.locator("button:has-text('Buchbare Tage anzeigen')");
    if (await submit.count()) {
      await submit.first().click();
      await page
        .waitForURL((url) => !url.pathname.includes("/time/restriction/"), { timeout: args.timeout })
        .catch(() => {});
      await page.waitForLoadState("domcontentloaded").catch(() => {});
    }

    if (args.verbose) log(`page: ${page.url()} — ${await page.title()}`);

    if (/\/termin\/taken\//.test(page.url())) return [];

    body = await page.locator("body").innerText().catch(() => "");
    if (/keine Termine für ihre Auswahl|keine Termine verfügbar/i.test(body)) return [];

    const links = page.locator("td.buchbar a");
    const count = await links.count();
    const slots = new Map();

    for (let i = 0; i < count; i += 1) {
      const link = links.nth(i);
      const title = (await link.getAttribute("title").catch(() => null)) ?? "";
      const href = (await link.getAttribute("href").catch(() => null)) ?? "";
      const label = (await link.innerText().catch(() => "")).trim();
      const date = dateFromText(title) ?? dateFromHref(href);
      if (!date) continue;
      slots.set(date, { date, href: absoluteUrl(href), label: title || label });
    }

    return [...slots.values()].sort((a, b) => a.date.localeCompare(b.date));
  } finally {
    await context.close();
  }
}

// ------------------------------------------------------------------- launch

async function launchBrowser() {
  const headless = !args.headful;
  if (args.bundled) return chromium.launch({ headless });

  try {
    return await chromium.launch({ headless, channel: "chrome" });
  } catch (error) {
    log(`system Chrome unavailable (${error.message.split("\n")[0]}), trying bundled Chromium`);
    try {
      return await chromium.launch({ headless });
    } catch (fallbackError) {
      console.error(
        "Could not start a browser. Install one with:\n  npx playwright install chromium\n" +
          `Reason: ${fallbackError.message.split("\n")[0]}`,
      );
      process.exit(1);
    }
  }
}

// --------------------------------------------------------------------- main

const browser = await launchBrowser();
log(`watching Lichtenberg ESU (service ${SERVICE}, provider ${PROVIDER}), every ${args.interval}s`);

const seenDates = new Set();
let blockedCount = 0;
let failed = false;

// No SIGINT handler on purpose: Playwright already closes its browsers on
// Ctrl-C and exits with the conventional 130.

for (;;) {
  let waitMs = args.interval * 1000 * (0.9 + Math.random() * 0.2);

  try {
    const slots = await findSlots(browser);
    blockedCount = 0;

    if (slots.length === 0) {
      log("0 slots");
      failed = false;
    } else {
      failed = false;
      const fresh = slots.filter((slot) => !seenDates.has(slot.date));

      log(`${slots.length} bookable day(s): ${slots.map((s) => s.date).join(", ")}`);

      if (fresh.length) {
        for (const slot of fresh) seenDates.add(slot.date);
        log(`NEW: ${fresh.map((s) => s.date).join(", ")} → ${fresh[0].href}`);
        await notify(
          "Einschulungsuntersuchung Lichtenberg",
          `${fresh.length} freie(r) Tag(e): ${fresh.map((s) => s.date).join(", ")}`,
        );
        // The day links (…/termin/time/<ts>/) only work inside a live portal
        // session, so always send the browser to the service page itself.
        if (args.open) {
          await run("open", [BOOKING_URL]).catch((error) => log("could not open browser:", error.message));
        }
      } else if (args.verbose) {
        log("no new dates since the last check");
      }
    }
  } catch (error) {
    failed = true;
    if (error instanceof BlockedError) {
      const minutes = BACKOFF_MINUTES[Math.min(blockedCount, BACKOFF_MINUTES.length - 1)];
      blockedCount += 1;
      log(`blocked (${error.message}) — backing off ${minutes} min`);
      waitMs = minutes * 60_000;
    } else {
      log(`error: ${error.message.split("\n")[0]}`);
    }
  }

  if (args.once) break;
  await sleep(waitMs);
}

await browser.close().catch(() => {});
process.exit(failed ? 1 : 0);
