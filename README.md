# Berlin appointment watcher — Einschulungsuntersuchung

Checks Berlin's Serviceportal for free appointment slots and pings you when one opens up.
Ships with two targets:

| Target | What it watches | Booking page |
|---|---|---|
| `lichtenberg` (default) | Einschulungsuntersuchung at the Lichtenberg Kinder- und Jugendgesundheitsdienst, Alfred-Kowalke-Str. 24 | `/provider/326385/324254/` |
| `berlin` | Einschulungsuntersuchung at **every** Standort the Serviceportal knows (service-wide search) | `/all/324254/` |

Lichtenberg has handled ESU bookings through the Serviceportal since 2026-11-02 and
releases slots continuously for examinations from November 2026 to June 2027.

## Quick start

```sh
git clone <this repo> einschulung && cd einschulung
npm install
npm run list     # see the configured targets
npm start        # watch the default target
```

`npm install` downloads no browser: the script uses your installed Google Chrome. Leave it
running in a terminal tab; stop it with `Ctrl-C`.

First time? Do one check before walking away:

```sh
npm run once
```

```
[08:30:53] watching Einschulungsuntersuchung Lichtenberg (service 324254, provider 326385), every 180s
[08:30:55] 0 slots
```

## Choosing where to watch

```sh
node watch.mjs --target=berlin            # service-wide instead of one Standort
node watch.mjs --list                     # list targets, * marks the current one
node watch.mjs --target=lichtenberg --once
```

Everything lives in [`targets.json`](targets.json):

```json
{
  "default": "lichtenberg",
  "targets": {
    "lichtenberg": {
      "label": "Einschulungsuntersuchung Lichtenberg",
      "service": "324254",
      "provider": "326385"
    },
    "berlin": {
      "label": "Einschulungsuntersuchung Berlin (alle Standorte)",
      "service": "324254",
      "provider": "all"
    }
  }
}
```

- `service` is the Dienstleistung ID, `provider` the Standort ID — or `"all"` to search every
  location. `label` is what the logs and notifications say.
- Precedence: CLI flags (`--service`, `--provider`, `--label`) → environment
  (`ESU_SERVICE`, `ESU_PROVIDER`, `ESU_LABEL`, `ESU_TARGET`) → the target entry → the
  file's `default`.
- If `targets.json` is missing or broken, the built-in Lichtenberg target is used with a
  warning.

### Adding another target

1. Open the service on <https://service.berlin.de>, pick the Standort and press
   **„Termin buchen“**. The link looks like
   `/terminvereinbarung/termin/provider/<provider>/<service>/`.
2. If the button is a form instead, read `dienstleister[]` and `anliegen[]` from it — those
   are the provider and service IDs.
3. Add an entry to `targets.json`, then check it with `node watch.mjs --target=NAME --once --verbose`.

### Which districts this covers

Only districts that book through the Serviceportal can be watched here. Today that is
Lichtenberg. Charlottenburg-Wilmersdorf, Marzahn-Hellersdorf, Neukölln and Pankow link to
the separate FMS portal (`fms.verwalt-berlin.de/esu/`), which was closed to online booking
when this repo was written; the remaining districts have no online ESU booking at all.

The `berlin` target queries every Standort registered for the service, so it can report
days even when a single provider shows none. ESU is tied to the district of your child's
*Einzugsschule*, so those extra days may not be bookable for you — use it as an overview,
not as a replacement for the Lichtenberg target.

## What happens when a slot appears

```
[09:14:02] 1 bookable day(s): 2026-12-03
[09:14:02] NEW: 2026-12-03 → https://service.berlin.de/terminvereinbarung/termin/time/…
```

- a macOS notification appears with the Glass sound, titled after the target's label,
- the booking page opens in your default browser,
- the date is remembered, so a slot that stays free won't notify you again on the next
  cycle.

You then finish the booking yourself (child's data, legal guardian, questionnaire). The
portal asks „Ich bin kein Bot“ before showing times; the watcher never gets that far.

## Options

| Flag | Meaning |
|---|---|
| `--target=NAME` | Target from `targets.json` (default: the file's `default`) |
| `--service=ID` | Override the service ID of the target |
| `--provider=ID\|all` | Override the provider ID; `all` searches every location |
| `--label=TEXT` | Override the label used in logs and notifications |
| `--list` | Show configured targets and exit |
| `--interval=SECONDS` | Polling interval, clamped to a 180 s minimum (default 180) |
| `--once` | One check, then exit |
| `--no-open` | Don't open the booking page when a slot appears |
| `--headful` | Show the browser window |
| `--bundled` | Use Playwright's Chromium instead of system Chrome |
| `--verbose` | Log the page URL and title on every check |

Exit codes with `--once`: `0` = the check ran (with or without slots), `1` = the check
failed (blocked, bad target, or error). `Ctrl-C` on the loop exits with the usual 130.

## How it works

The Serviceportal sits behind a WAF: plain HTTP clients (`curl`, `fetch`) get
`403 Unerwünschter Zugriff`, so no cookie or token trick gets you in. A browser is required.

Each check:

1. opens the target URL — `/provider/<provider>/<service>/` or `/all/<service>/`
   (redirects through `session/init`),
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
| `Unknown target "…"` | Typo, or the entry is missing from `targets.json`. `npm run list` shows the valid names. |
| `Could not start a browser` | No Chrome and no bundled Chromium. Run `npx playwright install chromium`, then `npm start -- --bundled`. |
| Repeated `blocked (HTTP 403)` | Your IP got flagged by the WAF. Let the backoff run, or stop for a while. Don't shorten the interval. |
| Always `0 slots`, forever | Either genuinely no slots (normal outside release windows) or the page markup changed. Run `node watch.mjs --headful --verbose --once` and watch what the site shows. |
| `--target=berlin` finds days, Lichtenberg finds none | Expected: the service-wide search includes Standorte that currently have free days. Check whether the day is bookable for your district. |
| Notification doesn't show | macOS notification permissions for Terminal/Chrome, or Do Not Disturb. The terminal line is always printed regardless. |
| Browser opens on a slot but the calendar is empty | Slots are gone by the time you click through — they go fast. |

## Important

- **Detection only.** Automating the booking form is fragile and risks an IP ban.
- ESU is only available at the Gesundheitsamt of the district of your child's
  *Einzugsschule*.
- Keep the 180 s minimum. Hammering the portal is how IPs get blocked.

## For AI agents

See [AGENTS.md](AGENTS.md) for run/verify commands, the fragile spots, and the rules that
must not be broken.
