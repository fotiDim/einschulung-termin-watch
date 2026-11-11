#!/usr/bin/env node
// Watches the Berlin Serviceportal for free appointment slots.
//
// Which service and location it watches comes from targets.json (see --list).
// The default target is the service-wide Einschulungsuntersuchung search:
//
//   Service: 324254  Einschulungsuntersuchung
//   Scope:   every Standort in the Serviceportal
//
// The optional "lichtenberg" target narrows it to that Gesundheitsamt
// (provider 326385, Alfred-Kowalke-Str. 24).
//
// The site sits behind a WAF that rejects plain HTTP clients (curl/fetch get
// 403 "Unerwünschter Zugriff"), so a real browser is required. Playwright
// drives Chrome through the same flow a human would.

import { chromium } from "playwright";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";

const run = promisify(execFile);

const MIN_INTERVAL = 180; // Berlin's stated minimum refresh
const BACKOFF_MINUTES = [5, 10, 20, 30];

// Used when targets.json is missing, so a copy of this file alone still works.
const FALLBACK_TARGETS = {
  default: "berlin",
  targets: {
    berlin: { label: "Einschulungsuntersuchung Berlin (alle Standorte)", service: "324254", provider: "all" },
    lichtenberg: { label: "Einschulungsuntersuchung Lichtenberg", service: "324254", provider: "326385" },
  },
};

// ---------------------------------------------------------------- arguments

const args = {
  interval: MIN_INTERVAL,
  once: false,
  open: true,
  headful: false,
  verbose: false,
  bundled: false,
  list: false,
  help: false,
  target: null,
  service: null,
  provider: null,
  label: null,
  timeout: 30_000,
};

const usage = `Usage: node watch.mjs [options]

  --target=NAME       target from targets.json (default: the file's "default")
  --service=ID        override the service id of the target
  --provider=ID|all   override the provider id, "all" = every location
  --label=TEXT        override the label used in logs and notifications
  --list              show the configured targets and exit
  --interval=SECONDS  polling interval, minimum ${MIN_INTERVAL} (default ${MIN_INTERVAL})
  --once              check once and exit (0 = check ran, 1 = check failed)
  --no-open           do not open the booking page when a slot appears
  --headful           show the browser window
  --bundled           use Playwright's Chromium instead of system Chrome
  --verbose           log the page URL/title on every check
  --help              this text`;

for (const raw of process.argv.slice(2)) {
  if (!raw.startsWith("--")) continue;
  const [key, value] = raw.slice(2).split("=");
  switch (key) {
    case "once": args.once = true; break;
    case "no-open": args.open = false; break;
    case "headful": args.headful = true; break;
    case "verbose": args.verbose = true; break;
    case "bundled": args.bundled = true; break;
    case "list": args.list = true; break;
    case "help": args.help = true; break;
    case "target": args.target = value; break;
    case "service": args.service = value; break;
    case "provider": args.provider = value; break;
    case "label": args.label = value; break;
    case "interval": args.interval = Math.max(MIN_INTERVAL, Number(value) || MIN_INTERVAL); break;
    default:
      console.warn(`Unknown option --${key}, ignoring`);
  }
}

if (args.help) {
  console.log(usage);
  process.exit(0);
}

// ------------------------------------------------------------------- targets

function loadTargets() {
  try {
    const parsed = JSON.parse(readFileSync(new URL("./targets.json", import.meta.url), "utf8"));
    if (!parsed?.targets || typeof parsed.targets !== "object" || Object.keys(parsed.targets).length === 0) {
      throw new Error('no "targets" entries');
    }
    return parsed;
  } catch (error) {
    if (error.code === "ENOENT") {
      console.warn("targets.json not found, using the built-in Lichtenberg target");
    } else {
      console.warn(`targets.json ignored (${error.message}), using the built-in Lichtenberg target`);
    }
    return FALLBACK_TARGETS;
  }
}

function buildBookingUrl(service, provider) {
  const base = "https://service.berlin.de/terminvereinbarung/termin";
  return provider === "all" ? `${base}/all/${service}/` : `${base}/provider/${provider}/${service}/`;
}

function resolveTarget(config) {
  const name = args.target || process.env.ESU_TARGET || config.default || Object.keys(config.targets)[0];
  const entry = config.targets[name];
  if (!entry) {
    console.error(`Unknown target "${name}". Available: ${Object.keys(config.targets).join(", ")}`);
    process.exit(1);
  }

  const service = args.service || process.env.ESU_SERVICE || entry.service;
  const provider = args.provider || process.env.ESU_PROVIDER || entry.provider;
  const label = args.label || process.env.ESU_LABEL || entry.label || name;

  if (!/^\d+$/.test(String(service ?? ""))) {
    console.error(`Target "${name}" has no valid service id (got "${service}")`);
    process.exit(1);
  }
  if (provider !== "all" && !/^\d+$/.test(String(provider ?? ""))) {
    console.error(`Target "${name}" has no valid provider id (got "${provider}", use "all" for every location)`);
    process.exit(1);
  }

  return { name, label, service, provider, url: buildBookingUrl(service, provider) };
}

const targets = loadTargets();

if (args.list) {
  const current = args.target || process.env.ESU_TARGET || targets.default;
  for (const [key, entry] of Object.entries(targets.targets)) {
    const url = buildBookingUrl(entry.service, entry.provider);
    console.log(`${key === current ? "*" : " "} ${key.padEnd(14)} ${(entry.label ?? key).padEnd(48)} ${url}`);
  }
  process.exit(0);
}

const TARGET = resolveTarget(targets);

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

function absoluteUrl(href, fallback) {
  try {
    return href ? new URL(href, "https://service.berlin.de").toString() : fallback;
  } catch {
    return fallback;
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

async function findSlots(browser, bookingUrl) {
  const context = await browser.newContext({
    locale: "de-DE",
    timezoneId: "Europe/Berlin",
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(args.timeout);

  try {
    const response = await page.goto(bookingUrl, { waitUntil: "domcontentloaded" });
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
      slots.set(date, { date, href: absoluteUrl(href, bookingUrl), label: title || label });
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
log(
  `watching ${TARGET.label} (service ${TARGET.service}, provider ${TARGET.provider}), every ${args.interval}s`,
);

const seenDates = new Set();
let blockedCount = 0;
let failed = false;

// No SIGINT handler on purpose: Playwright already closes its browsers on
// Ctrl-C and exits with the conventional 130.

for (;;) {
  let waitMs = args.interval * 1000 * (0.9 + Math.random() * 0.2);

  try {
    const slots = await findSlots(browser, TARGET.url);
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
          `Termin frei: ${TARGET.label}`,
          `${fresh.length} freie(r) Tag(e): ${fresh.map((s) => s.date).join(", ")}`,
        );
        // The day links (…/termin/time/<ts>/) only work inside a live portal
        // session, so always send the browser to the service page itself.
        if (args.open) {
          await run("open", [TARGET.url]).catch((error) => log("could not open browser:", error.message));
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
