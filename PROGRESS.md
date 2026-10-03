# Agent progress and handover

Append a short entry per meaningful turn: change, files, tests, deployed or not, unresolved items and pending input ownership. Current database state comes from the CLI, not this log. Keep personal report text and credentials out of this file. An installation with an ignored `PROGRESS.local.md` keeps its own log there instead (see AGENTS.md).

## 2026-10-04 — initial public release

Published as "Rituals": the local SQLite store, `bin/ritualctl`, the static and live read-only dashboard, the macOS host app, the multi-agent instructions (AGENTS.md, HANDOFF.md, this log) and the tests on made-up fixtures. Installation-specific details live in ignored `LOCAL.md` and `PROGRESS.local.md`. `bin/ritualctl --init` creates a new empty store; `bin/ritual-screenshots` regenerates the README images. Tests: `bin/ritual-tests`, `bin/ritual-tests --smoke`, `bin/ritual-ui-check` pass from a fresh clone with no data folder.
