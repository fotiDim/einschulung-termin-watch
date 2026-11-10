# AGENTS.md

Instructions for coding agents working in this repo.

## What this is

A single-file watcher (`watch.mjs`) that polls Berlin's Serviceportal for free
Einschulungsuntersuchung slots at the Lichtenberg Gesundheitsamt and notifies the user.
Node 22 ESM + Playwright. No build step, no test framework, no server, no secrets.

```
watch.mjs      the whole watcher (config, CLI, browser flow, parsing, alerts)
package.json   playwright dependency; "start" and "once" scripts
README.md      human-facing docs
```

## Commands

```sh
npm install                                   # deps only; no browser download
node watch.mjs --once --verbose               # safe smoke test, ~5 s
node watch.mjs                                # real run, polls every 180 s
node watch.mjs --headful --verbose --once     # watch the browser, debugging
node --check watch.mjs                        # syntax check after edits
```

Always use `--once` for validation. Do not leave the loop running while you work, and do
not run repeated checks in a tight loop.

## Expected smoke-test result

```
[HH:MM:SS] watching Lichtenberg ESU (service 324254, provider 326385), every 180s
[HH:MM:SS] 0 slots
```

Exit code `0` = the check ran. `1` = the check failed (WAF block or error). With `--verbose`
the line before the result shows the final URL — `…/termin/taken/` means "no appointments",
which is the normal state most days. Booking windows are Nov 2026 – Jun 2027, so `0 slots`
is expected outside a release.

If you ever see `blocked (…)` during development, stop testing for a while. The site's WAF
is IP-based and framing it as "just retry" makes things worse.

## How the flow works

`findSlots()` in `watch.mjs`:

1. `page.goto` the provider URL → 302 `session/init` → `/termin/time/restriction/`.
2. Click the button matching `Buchbare Tage anzeigen`.
3. Wait until the URL leaves `/time/restriction/`. It settles on either
   `/termin/taken/` (no slots) or the day calendar.
4. No slots: `/termin/taken/` in the URL or "keine Termine …" in the body.
5. Slots: `td.buchbar a`, date from the `title` attribute (`DD.MM.YYYY - …`), fallback to the
   epoch in `/termin/time/<unix>/`.

`main` calls `findSlots` on an interval, compares against `seenDates`, and on new dates
runs the macOS notification and `open` the booking page.

## Fragile spots (check these first when it breaks)

| What | Where | Symptom if it changes |
|---|---|---|
| Provider/service IDs | `SERVICE`, `PROVIDER` at the top | Redirect to a start page / wrong district |
| Button text `Buchbare Tage anzeigen` | `findSlots` | Never leaves the restriction page |
| `td.buchbar a` | `findSlots` | Always `0 slots`, even when the calendar shows free days |
| `title` date format | `dateFromText` | Slots skipped (`if (!date) continue`) |
| `/termin/taken/` check | `findSlots` | Reports slots that aren't there |
| WAF block text | `findSlots` | 403 page parsed as a calendar instead of backing off |

To inspect the real markup, run `node watch.mjs --headful --verbose --once`. If you need a
known-good sample of a bookable cell, Berlin's calendar markup has been:

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
  notifies; a human completes the booking. This is also why there are no stored child or
  guardian details anywhere in the repo.
- **No secrets, no credentials, no analytics, no telemetry.**
- **Don't add CI.** GitHub Actions runners are datacenter IPs and get blocked by the WAF;
  a red pipeline there means nothing.
- Keep it a single file with Node's standard library plus Playwright. No frameworks,
  config files, or abstractions unless the user asks.

## Retargeting to another district

Override without editing code:

```sh
ESU_SERVICE=324254 ESU_PROVIDER=<other-provider-id> node watch.mjs --once --verbose
```

To find IDs: open the service page on service.berlin.de, pick the Standort, then read the
"Termin buchen" link — it has the shape
`/terminvereinbarung/termin/provider/<provider>/<service>/`. If the new district uses a
different flow (some do their own booking or use `fms.verwalt-berlin.de/esu/`), this
script does not apply; say so instead of hacking around it.

## Before you claim it works

1. `node --check watch.mjs`
2. `node watch.mjs --once --verbose` → prints a URL and a slot count, exit code 0
3. If you touched parsing, reproduce a bookable day with `--headful` or against the markup
   above, and confirm the date lands in the output
4. `README.md` / this file still match the flags and behaviour you changed
