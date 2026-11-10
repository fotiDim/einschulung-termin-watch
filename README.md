# Einschulungsuntersuchung Lichtenberg — Termin-Watcher

Checks Berlin's Serviceportal for free **Einschulungsuntersuchung** appointments at the
Lichtenberg Kinder- und Jugendgesundheitsdienst and pings you when one opens up.

| | |
|---|---|
| Service | Einschulungsuntersuchung (`324254`) |
| Standort | Gesundheitsamt – Kinder- und Jugendgesundheitsdienst, Alfred-Kowalke-Str. 24, 10315 Berlin |
| Provider ID | `326385` |
| Booking page | <https://service.berlin.de/terminvereinbarung/termin/provider/326385/324254/> |

Lichtenberg has handled ESU bookings through the Serviceportal since 2026-11-02 and
releases slots continuously for examinations from November 2026 to June 2027.

## Quick start

```sh
git clone <this repo> einschulung && cd einschulung
npm install
npm start
```

That's it. The script uses your installed Google Chrome, so `npm install` downloads no
browser. Leave it running in a terminal tab; stop it with `Ctrl-C`.

First time? Do one check and look at the output before walking away:

```sh
npm run once
```

```
[08:30:53] watching Lichtenberg ESU (service 324254, provider 326385), every 180s
[08:30:55] 0 slots
```

## What happens when a slot appears

```
[09:14:02] 1 bookable day(s): 2026-12-03
[09:14:02] NEW: 2026-12-03 → https://service.berlin.de/terminvereinbarung/termin/time/…
```

- a macOS notification appears with the Glass sound,
- the booking page opens in your default browser,
- the date is remembered, so a slot that stays free won't notify you again on the next
  cycle.

You then finish the booking yourself (child's data, legal guardian, questionnaire). The
script never fills or submits the form.

## Options

| Flag | Meaning |
|---|---|
| `--interval=SECONDS` | Polling interval, clamped to a 180 s minimum (default 180) |
| `--once` | One check, then exit |
| `--no-open` | Don't open the booking page when a slot appears |
| `--headful` | Show the browser window |
| `--bundled` | Use Playwright's Chromium instead of system Chrome |
| `--verbose` | Log the page URL and title on every check |

Exit codes with `--once`: `0` = the check ran (with or without slots), `1` = the check
failed (blocked or errored). Handy for cron; `Ctrl-C` on the loop exits with the usual 130.

## How it works

The Serviceportal sits behind a WAF: plain HTTP clients (`curl`, `fetch`) get
`403 Unerwünschter Zugriff`, so no cookie or token trick gets you in. A browser is required.

Each check:

1. opens `…/provider/326385/324254/` (redirects through `session/init`),
2. clicks **„Buchbare Tage anzeigen“** on the time-restriction page,
3. if the site lands on `…/termin/taken/` („keine Termine für ihre Auswahl“), there are no slots,
4. otherwise it reads every `td.buchbar a` — the bookable days — and takes the date from the
   link's `title`, falling back to the `/termin/time/<unix-seconds>/` URL.

A block is detected from the 403 status or the block page text and triggers a
5/10/20/30-minute backoff. Polling never goes below 180 s, carries ±10 % jitter, and an
error on one cycle doesn't kill the loop.

## Keeping it running

```sh
caffeinate -is npm start   # keeps the Mac awake while the watcher runs
```

Run it in a terminal tab, `tmux`, or a `launchd` agent. Don't put it on a server or in CI:
the WAF treats datacenter IPs as suspicious, and the point is to have the booking page open
on the machine you'll actually book from.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Could not start a browser` | No Chrome and no bundled Chromium. Run `npx playwright install chromium`, then `npm start -- --bundled`. |
| Repeated `blocked (HTTP 403)` | Your IP got flagged by the WAF. Let the backoff run, or stop for a while. Don't shorten the interval. |
| Always `0 slots`, forever | Either genuinely no slots (normal outside release windows) or the page markup changed. Run `node watch.mjs --headful --verbose --once` and watch what the site shows. |
| Notification doesn't show | macOS notification permissions for Terminal/Chrome, or Do Not Disturb. The terminal line is always printed regardless. |
| Browser opens on a slot but the calendar is empty | Slots are gone by the time you click through — they go fast. |

## Important

- **Detection only.** Automating the booking form is fragile and risks an IP ban.
- ESU is only available at the Gesundheitsamt of the district of your child's
  *Einzugsschule* — this script is hard-wired to Lichtenberg.
- Keep the 180 s minimum. Hammering the portal is how IPs get blocked.

## For AI agents

See [AGENTS.md](AGENTS.md) for run/verify commands, the fragile spots, and the rules that
must not be broken.
