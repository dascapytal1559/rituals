# Operating cookbook

Run logging, reads, service and backup commands from the live folder (its path is in LOCAL.md). Code/docs/UI work runs from a separate clone or worktree (see Code changes). Read AGENTS.md and LOCAL.md first. Commands here need an authorized Mac executor; they do not provide cloud access while the Mac is unavailable. No previous chat or agent workspace is required.

## First run (new installation only)

```sh
bin/ritualctl --init          # creates an empty data/ritual.sqlite3; refuses if one exists
bin/ritualctl <<'JSON'
{"op":"status"}
JSON
```

Never use `--init` to "fix" a live folder whose database is missing: that is a recovery situation (see Backup, export and restore).

## Start a turn

```sh
cd /path/to/live-folder       # path in LOCAL.md
bin/ritual-agent status
bin/ritualctl --queue-status
bin/ritualctl <<'JSON'
{"op":"status"}
JSON
```

Read the latest PROGRESS.local.md (when present) and PROGRESS.md entries, then current records relevant to the request. Normal logging requires no edit claim or commit. For landing code, deploying or migrating in the live folder use `bin/ritual-agent claim YOUR_UNIQUE_TASK_ID 'specific scope'` there; release that same ID after recording progress. A claim prevents cooperating agents taking the same edit role; it does not block ordinary CLI writes or uncooperative editors. Coordinate and hold reports for migrations. Never forcibly remove an active claim.

## Reads

Send one JSON object on stdin to bin/ritualctl:

```json
{"op":"rituals","from":"2026-10-01","to":"2026-10-03"}
{"op":"history","entity":"rituals","id":"2026-10-03"}
{"op":"ritual_status","from":"2026-09-01","to":"2026-10-03"}
{"op":"applicability_exceptions"}
{"op":"workouts","from":"2026-09-01","to":"2026-09-30","group_by":"week"}
{"op":"workouts","from":"2026-09-01","to":"2026-09-30","group_by":"month"}
{"op":"reminders","mode":"review"}
{"op":"reminders","mode":"due","as_of":"2026-10-05T08:00:00+11:00"}
{"op":"weekly_reviews","from":"2026-09-01","to":"2026-10-31"}
{"op":"history","entity":"weekly_reviews","id":"2026-09-28"}
```

Use actual requested dates/as_of; omit as_of for current-time behavior. Rituals/workouts/reminders/weekly_reviews records return entity revision for corrections. Review includes stashed/outstanding reminders; due returns timed pending items whose time arrived. Neither sends a message or changes state. Status derives noon closure using Australia/Melbourne, including DST; raw null remains unchanged. The derived range is bounded to observed coverage. source/id retrieves original evidence privately.

## Writes: templates, not real reports

Replace every example value with an established user report before production use. Every action needs stable request_id and source_text containing verbatim words, original message ID, receipt instant, occurrence qualification and disclosed date inference. Omitted fields remain intact. A completion report does not establish check-in.

Partial habit report:
```json
{"op":"ritual_put","date":"2026-10-03","patch":{"journalling":true},"request_id":"ORIGINAL_MESSAGE_ID:ritual","source_text":"Verbatim words. Source ID ORIGINAL_MESSAGE_ID. Received at OFFSET_BEARING_INSTANT. Assigned ritual date from stated/contextual intent; actual completion time unknown."}
```

Explicit check-in with only receipt instant available:
```json
{"op":"ritual_put","date":"2026-10-03","patch":{"checkins":["2026-10-03T12:00:00Z"]},"request_id":"ORIGINAL_MESSAGE_ID:checkin","source_text":"Checking in [replace with exact words]. Source ID ORIGINAL_MESSAGE_ID. Received at 2026-10-03T12:00:00Z. This is message receipt time; exact physical check-in instant unknown. Ritual date 2026-10-03 [replace with established interpretation]."}
```

Patch fields: checkins array of offset-bearing instants; magnesium/protein/stretching/journalling true/false/null; plank_seconds nonnegative integer/null; notes text/null. checkins merges without discarding existing timestamps. A changed existing nonnull habit requires correction, not another put.

Correction after reading current entity revision (replace 123):
```json
{"op":"correct","entity":"rituals","id":"2026-10-03","patch":{"journalling":false},"expected_revision":123,"reason":"User corrected the original report","request_id":"NEW_CORRECTION_MESSAGE_ID:ritual","source_text":"Exact correction words, ID and receipt time; original intent/date qualification."}
```

On stale revision, read/reconcile the original correction intent before preparing a new guarded action. Don't remove the guard or reuse an ID with changed content. Identity fields cannot change; date reassignment needs an explicit supported multi-record plan, preserving original evidence.

Workout:
```json
{"op":"workout_add","record":{"date":"2026-10-03","type":"gym push","details":"Verbatim sets/weights or other free text"},"request_id":"ORIGINAL_MESSAGE_ID:workout:1","source_text":"Original words, source ID and receipt/date context"}
```

Workouts have no duration/distance/split/sets columns; type is open text. Multiple workouts/day have separate IDs. Reminder:
```json
{"op":"reminder_add","record":{"text":"Exact task","due_at":"2026-10-05T08:00:00+11:00"},"request_id":"ORIGINAL_MESSAGE_ID:reminder:1","source_text":"Exact timing words, source ID, receipt and resolved Melbourne timing"}
```

Weekly review answer (the reply to the weekly "What did you get done this week?" question):
```json
{"op":"weekly_put","week_start":"2026-09-28","answer":"Verbatim answer","request_id":"ORIGINAL_MESSAGE_ID:weekly","source_text":"Original words, source ID, receipt instant and which week it answers"}
```

`week_start` is the Monday of the Monday-to-Sunday week the answer reviews (a Sunday 2026-10-04 reply about that week uses 2026-09-28); any other day is rejected. Decide the week from context, as with after-midnight ritual dates, and disclose that in source_text. One record per week: a further answer for the same week is appended on a new line; changing earlier words is `correct` with entity=weekly_reviews, id=the Monday, patch={"answer":...}. Answers never go in ritual notes.

Omit/null due_at for stashed. States pending/delivered/done/cancelled: delivery isn't completion. `reminder_mark` needs id,status,expected_revision,reason,request_id,source_text. Snooze is `correct` on reminders/due_at. Don't invent a date or replace explicit early timing with noon review. Applicability: exception_add record={habit,start_date,end_date,reason}, optional id, same provenance. Bounds inclusive; null start covers earlier dates. Overlap/positive-report conflicts require review. Corrections use entity=applicability_exceptions.

## Offline queue and lost acknowledgements

Parent holds unreachable-Mac inputs durably with message_id,received_at,original_text,interpretation,delivery_state=held_for_mac and prepared_requests. This envelope is not a CLI request. Do not invent correction revisions offline. On reconnect deliver exact prepared JSON to `bin/ritualctl --enqueue`, then `bin/ritualctl --replay` in original order. --queue-status lists outstanding IDs.

Enqueue means queued_on_mac/database_confirmed=false; replay confirms application. Receipts and original requests remain in queue/sent. Lost acknowledgement: retry identical ID/payload, which returns existing revision. Same ID/different payload is rejected. Replay stops at conflict and retains it and later inputs. Resolve original intent with current record; never discard pending inputs to make the queue appear clear. --queue-on-failure handles local storage failures while the Mac executor runs, not a powered-off Mac. Reads report unavailability, not fabricated emptiness.

## Code changes

The live folder is a git repository on `main`; AGENTS.md lists what is tracked and ignored. Work on a branch in a separate clone or worktree; it needs no `data/` or `evidence/` because tests use `tests/fixtures/`. A local evidence folder can still be used with `RITUAL_FIXTURE_DIR=/path/to/evidence bin/ritual-tests`.

```sh
git clone /path/to/live-folder ritual-work && cd ritual-work
git checkout -b YOUR_BRANCH
# edit, then:
bin/ritual-tests && bin/ritual-ui-check
git add -A && git commit -m 'Describe the change'
```

Land in the live folder as a fast-forward, then deploy if needed:

```sh
cd /path/to/live-folder
bin/ritual-agent claim YOUR_UNIQUE_TASK_ID 'land YOUR_BRANCH'
git status --short            # must be clean; never land over uncommitted edits
git fetch /path/to/ritual-work YOUR_BRANCH
git merge --ff-only FETCH_HEAD   # if refused, rebase the branch onto main and retry
```

Commit when done. Never leave uncommitted or half-finished edits in the live folder.

## UI development and service

`dashboard.py` owns shared matrix, weekly view, title bar/ritual picker and static views; `dashboard_web.py` live API projection/frontend; `dashboard_theme.py` theme; `dashboard_server.py` authorization/routes. Production DB and private config are not fixtures. Keep the existing privacy/display rules in AGENTS.md.

```sh
bin/ritual-tests
bin/ritual-tests --smoke
bin/ritual-ui-check
bin/ritual-service status
```

Backend tests write only temporary stores. Smoke exercises two sequential fresh clients, queue replay, retry, conflict/correction/history and export/restore. Browser check uses fictional records and isolated installed Chrome, testing live/static HTML at mobile/desktop and light/dark. It requires existing Node/Playwright; no install is automatic. Playwright only drives the installed `/Applications/Google Chrome.app` and needs no browser download. `tests/check_ui.cjs` looks for Playwright in this order: `RITUAL_PLAYWRIGHT_MODULE`, normal Node resolution of `playwright`, then the first `~/.npm/_npx/*/node_modules/playwright`. If discovery fails, point the check at any existing copy: `RITUAL_PLAYWRIGHT_MODULE=/path/to/node_modules/playwright bin/ritual-ui-check`. It aborts unexpected fixture network requests. `bin/ritual-ui-check --live` additionally reads the actual private page/API without injecting an identity or changing data.

Python/frontend edits are deployed by a controlled restart, not just saving a file. Claim ownership, test, then:
```sh
bin/ritual-service restart
bin/ritual-ui-check --live
```

Restart stops the existing named app/backend and bootstraps the unchanged authorized LaunchAgent. It does not modify login/network/access config. `stop` unloads it for maintenance; `start` loads/kickstarts the existing job. Status shows loaded/running/reachability without exposing owner identity. Direct app menu Retry/Quit remains available. Reload the browser once for changed frontend code; data otherwise refreshes on load/visibility/each visible minute. Never start a second raw Python service on the occupied port.

Native changes need `native/build.sh NEW_OUTPUT_APP_PATH STORE_ROOT` (fresh output path; STORE_ROOT is the live folder's absolute path); it builds/signs but doesn't install. Before replacing the installed app: preserve its full bundle in evidence, stop existing service, install the reviewed build at ~/Applications/Ritual Dashboard.app preserving bundle ID, then start/test. Never change privacy permissions to bypass a failure. The store root is explicit: build.sh writes STORE_ROOT into the bundle's Info.plist as `RitualStoreRoot`, and the app refuses to start without it. The LaunchAgent is ~/Library/LaunchAgents/local.ritual-dashboard.plist, label local.ritual-dashboard in gui/currentUID. Logs contain generic events under ~/Library/Logs/RitualDashboard. Installation-specific notes are in LOCAL.md.

Each ritual is its own page: Daily rituals at `/` (snapshot `data/views/ritual-dashboard.html`) and Weekly review at `/weekly` (snapshot `data/views/weekly-review.html`, API `/api/weekly`). The title's dropdown icon opens a native select over the title that switches between them; a new ritual is a new entry in `dashboard.RITUALS` with its page, route and API.

`bin/ritual-dashboard` regenerates the local HTML snapshots. That is independent from live service deployment. A returned dashboard.updated=false/record_saved=true means save succeeded: fix view only. Serve HTTPS 443 remains private→127.0.0.1:8765; no public Funnel or new write endpoints. API serves only safe dashboard fields, requires existing owner, and opens SQLite mode=ro. Never print config owner_login.

## Schema migrations

A schema change that moves data is never applied implicitly. When new code needs a newer schema, every request except status, backup and export fails with "needs the reviewed migration" until it is applied, and status shows `"migration_required": true`. Apply it once, in a maintenance window with incoming reports held and the edit claim taken:

```sh
bin/ritualctl <<'JSON'
{"op":"export","save":true}
JSON
bin/ritualctl --migrate
```

`--migrate` takes its own consistent backup first (path and sha256 in the result), applies the change in one transaction, audits every moved record in `changes`, regenerates the snapshots and is a no-op once applied. It refuses on a frozen backup copy. Version 3 adds `weekly_reviews` and moves every whole `Weekly: ...` line out of ritual notes into the week (Monday) of that ritual date, dropping the prefix; the result lists the dates and weeks moved. Restoring an older export into a current store applies the same move. A new store from `--init` starts at the current schema.

## Setting up the dashboard service (new installation)

`bin/ritual-service` only controls an existing setup; it never creates one. To create one:

1. `cp examples/dashboard-server.json config/` and set `tailscale_hostname` (your machine's `name.tailnet.ts.net`) and `owner_login` (the Tailscale login allowed to read). The loader accepts exactly these four fields, `127.0.0.1` and port 8765.
2. `native/build.sh ~/Applications/'Ritual Dashboard.app' "$PWD"` from the live folder.
3. Copy `examples/local.ritual-dashboard.plist` to `~/Library/LaunchAgents/`, replace `/Users/you` with your home folder, then `bin/ritual-service start`.
4. Serve it privately on your tailnet, for example `tailscale serve --bg --https=443 http://127.0.0.1:8765` (check `tailscale serve --help` for your version). Never use Funnel: Serve adds the `Tailscale-User-Login` header the backend checks, and Funnel would expose it publicly.

## README screenshots

README images live in `docs/screenshots/` and are generated, never hand-edited. After any change that alters how the dashboard looks (CSS, columns, labels, theme), regenerate them on the same branch and commit them with the change:

```sh
bin/ritual-screenshots --db /path/to/live-folder/data/ritual.sqlite3
git add docs/screenshots && git commit -m 'Refresh README screenshots'
```

Run it from your working copy, not the live folder (it writes tracked files). It takes a consistent read-only copy of the database, renders the real live page and API payload at fixed sizes (desktop 1440x900 @2x, mobile 390x844 @3x; light and dark), and writes stable file names, so the README never needs editing. To add or change a picture, edit the `SHOTS` list in `tools/screenshots.cjs`. The images show real data: look at them before committing. It needs the same Node/Playwright/Chrome as `bin/ritual-ui-check`.

## Backup, export and restore

Each write automatically creates a consistent backup before applying it. Explicit commands:
```sh
bin/ritualctl <<'JSON'
{"op":"backup"}
JSON
bin/ritualctl <<'JSON'
{"op":"export","save":true}
JSON
```

Full exports include private source/audit records: retain locally with existing private modes, never put in UI/public logs/repos. Export without save returns snapshot JSON on stdout, so redirect privately rather than printing it into a transcript. Verify an export by restoring it to a new empty temporary Store through the supported API and comparing returned data_sha256. See tests/test_agent_handover.py for a complete isolated roundtrip. Restore accepts only an empty store; don't run restore against production or replace the live DB ad hoc. Production recovery requires an explicit plan, current backup/export, stopped writers/service and preservation of the displaced DB/queue. This handbook does not authorize deleting originals or applying a destructive restore.

## End a turn

Append to PROGRESS.local.md in the live folder when it exists, otherwise PROGRESS.md: time/owner, intent/result, touched code/docs, test commands/results, service deployment and unresolved work. Record acknowledgement IDs/revisions only if useful; don't copy personal text. Release your edit claim. The next agent queries live state instead of relying on stale progress values. Never claim simultaneous code edits are safe: only sequential workflow and existing transaction/idempotency/revision/replay guards are validated.
