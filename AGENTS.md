# AGENTS.md

Instructions for coding agents working in this repo.

## What this is

A single-file watcher (`watch.mjs`) that polls Berlin's Serviceportal for free appointment
slots and notifies the user. Which service and location it watches comes from
`targets.json`. Node 22 ESM + Playwright. No build step, no test framework, no server, no
secrets.

```
watch.mjs      the whole watcher (CLI, browser flow, parsing, alerts)
targets.json   service/provider pairs to watch; ships with Lichtenberg + service-wide
package.json   playwright dependency; "start", "once" and "list" scripts
README.md      human-facing docs
```

## Commands

```sh
npm install                                   # deps only; no browser download
npm run list                                  # targets, URLs, * marks the current one
node watch.mjs --once --verbose               # safe smoke test, ~5 s
node watch.mjs --target=lichtenberg --once    # single-Standort target
node watch.mjs                                # real run, polls every 180 s
node watch.mjs --headful --verbose --once     # watch the browser, debugging
node watch.mjs --target=nope                  # must fail with the valid names, exit 1
node --check watch.mjs                        # syntax check after edits
```

Always use `--once` for validation. Do not leave the loop running while you work, and do
not run repeated checks in a tight loop.

## Expected smoke-test result

```
[HH:MM:SS] watching Einschulungsuntersuchung Berlin (alle Standorte) (service 324254, provider all), every 180s
[HH:MM:SS] 0 slots
```

Exit code `0` = the check ran. `1` = the check failed (WAF block, bad target, error). With
`--verbose` the line before the result shows the final URL — `…/termin/taken/` means "no
appointments". The default `berlin` target currently reports bookable days, so a smoke test
can legitimately print a list of dates and fire a notification. Use
`--target=lichtenberg` for a quiet check; it is normally `0 slots`. Booking windows run
Nov 2026 – Jun 2027.

The two targets differ by design: `berlin` is the service-wide search (`provider: all`),
`lichtenberg` filters to one Standort. The service-wide search can report days while the
Lichtenberg filter reports `0 slots`; that is the site's per-Standort filter working, not a
parser bug. Do not "fix" it by dropping the provider filter.

If you see `blocked (…)` during development, stop testing for a while. The WAF is IP-based
and retrying aggressively makes it worse.

## Targets

`targets.json`:

```json
{ "default": "berlin",
  "targets": { "<key>": { "label": "…", "service": "<dienstleistung id>",
                          "provider": "<standort id> | all" } } }
```

Resolution order, per field:

1. CLI flags `--service`, `--provider`, `--label`, `--target`
2. environment `ESU_SERVICE`, `ESU_PROVIDER`, `ESU_LABEL`, `ESU_TARGET`
3. the selected entry in `targets.json`
4. `default` from the file, or the first entry
5. built-in `FALLBACK_TARGETS` (service-wide `berlin`, plus `lichtenberg`) if the file is
   missing or invalid

`provider: "all"` builds `/terminvereinbarung/termin/all/<service>/`; anything else builds
`/terminvereinbarung/termin/provider/<provider>/<service>/`.

To add a target, find the service's Standort page, press „Termin buchen“ and read
`/provider/<provider>/<service>/` from the link, or read `dienstleister[]` and `anliegen[]`
from the booking form. Add the entry, then verify with `--target=NAME --once --verbose`.

## How the flow works

`findSlots(browser, bookingUrl)` in `watch.mjs`:

1. `page.goto` the target URL → 302 `session/init` → `/termin/time/restriction/`.
2. Click the button matching `Buchbare Tage anzeigen`.
3. Wait until the URL leaves `/time/restriction/`. It settles on either
   `/termin/taken/` (no slots) or the day calendar.
4. No slots: `/termin/taken/` in the URL or "keine Termine …" in the body.
5. Slots: `td.buchbar a`, date from the `title` attribute (`DD.MM.YYYY - …`), fallback to the
   epoch in `/termin/time/<unix>/`.

`main` resolves the target once, then calls `findSlots` on an interval, compares against
`seenDates`, and on new dates runs the macOS notification and opens the target URL.

## Fragile spots (check these first when it breaks)

| What | Where | Symptom if it changes |
|---|---|---|
| Target IDs | `targets.json` | Wrong district, or redirect to a start page |
| Button text `Buchbare Tage anzeigen` | `findSlots` | Never leaves the restriction page |
| `td.buchbar a` | `findSlots` | Always `0 slots`, even when the calendar shows free days |
| `title` date format | `dateFromText` | Slots skipped (`if (!date) continue`) |
| `/termin/taken/` check | `findSlots` | Reports slots that aren't there |
| WAF block text | `findSlots` | 403 page parsed as a calendar instead of backing off |
| `"all"` URL shape | `buildBookingUrl` | `/all/<service>/` or provider URL 404s |

To inspect the real markup, run `node watch.mjs --headful --verbose --once`. Berlin's
bookable-day cell has been:

```html
<td class="buchbar">
  <a title="29.06.2023 - An diesem Tag einen Termin buchen"
     href="/terminvereinbarung/termin/time/1687989600/">29</a>
</td>
```

## Hard rules

- **Never lower the 180 s floor** (`MIN_INTERVAL`) or remove the jitter/backoff. This is
  rate-limit hygiene, not a preference.
- **Never add form submission, login, or automatic booking.** The tool detects and
  notifies; a human completes the booking (including the „Ich bin kein Bot“ check). This is
  also why there are no stored child or guardian details anywhere in the repo.
- **Never hard-code service or provider IDs in logic.** They belong in `targets.json` and
  in `FALLBACK_TARGETS` only.
- **No secrets, no credentials, no analytics, no telemetry.**
- **Don't add CI.** GitHub Actions runners are datacenter IPs and get blocked by the WAF;
  a red pipeline there means nothing.
- Keep it a single JavaScript file with Node's standard library plus Playwright. No
  frameworks, no extra config files, no abstractions unless the user asks.

## Other districts

Only districts booking through the Serviceportal can be watched. Their Standort pages link
either to the Serviceportal or to `fms.verwalt-berlin.de/esu/…` (a JSF app; closed to online
booking when this was written). Charlottenburg-Wilmersdorf, Marzahn-Hellersdorf, Neukölln and
Pankow use FMS, the rest have no online ESU booking. Do not bolt an FMS scraper onto this
file — if the user wants it, that is a separate module and a separate decision.

The default target is the service-wide search (`provider: all`), not a district. Don't
re-introduce a district as the default unless the user asks for it explicitly.

## Before you claim it works

1. `node --check watch.mjs`
2. `npm run list` → both targets with correct URLs
3. `node watch.mjs --once --verbose` → a URL and a slot count, exit code 0
4. `node watch.mjs --target=nope --once` → error naming the valid targets, exit code 1
5. If you touched parsing, confirm real dates: `--target=berlin --once --verbose`
   (it currently returns dates; Lichtenberg may return 0)
6. `README.md` / this file still match the flags and behaviour you changed
