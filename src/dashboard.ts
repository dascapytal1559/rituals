// Render a private, read-only SQLite snapshot. No server or network requests.
import { Effect, FileSystem, Option, Result } from "effect";
import type { PlatformError } from "effect/PlatformError";
import type { SqlError } from "effect/sql/SqlError";
import * as Reactivity from "effect/reactivity/Reactivity";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { join, resolve } from "node:path";
import { type Cell, type ExceptionRow, type StatusReport, statusReport } from "./applicability.ts";
import { escapeHtml as escape, fixed1 } from "./encoding.ts";
import { type ApplicabilityConflict, type RequiresReview, reject } from "./errors.ts";
import { atomicWrite, ensureFile } from "./files.ts";
import {
  dateToDays,
  DAYS_LONG,
  DAYS_SHORT,
  isoformatMelbourne,
  isoformatUtc,
  hhmm,
  melbourneAbbreviation,
  melbourneParts,
  type Micros,
  MONTHS_LONG,
  MONTHS_SHORT,
  nowMicros,
  parseDateTime,
  updatedDisplay,
  addDays,
  civilFromDays,
} from "./instants.ts";
import { withFileLock } from "./locks.ts";
import { BOOLS } from "./store.ts";
import * as theme from "./dashboardTheme.ts";

export type Basis = "message_received" | "source_recorded" | "recorded";

export interface RitualRow {
  readonly date: string;
  readonly checkins?: ReadonlyArray<string>;
  readonly plank_seconds?: number | null;
  readonly _checkin_origins?: ReadonlyMap<Micros, Basis>;
  readonly [field: string]: unknown;
}

export interface WorkoutRow {
  readonly id: string;
  readonly date: string;
  readonly type: string;
}

export interface Records {
  readonly rituals: ReadonlyArray<RitualRow>;
  readonly workouts: ReadonlyArray<WorkoutRow>;
  readonly exceptions: ReadonlyArray<ExceptionRow>;
}

interface ChangeRow {
  readonly entity_id: string;
  readonly action: string;
  readonly before_json: string | null;
  readonly after_json: string | null;
  readonly source_text: string;
}

export const readOnlyClient = (root: string) =>
  SqliteClient.make({
    filename: "file:" + join(root, "data", "ritual.sqlite3") + "?mode=ro",
    readonly: true,
    disableWAL: true,
  }).pipe(Effect.provide(Reactivity.layer));

/** Every ritual and workout row the dashboard needs, read in one read-only transaction. */
export const readRecords = (root: string): Effect.Effect<Records, SqlError | RequiresReview> =>
  Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* readOnlyClient(root);
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<
            RitualRow & { checkins: string }
          >`SELECT date,checkins,magnesium,protein,stretching,journalling,plank_seconds FROM rituals ORDER BY date`;
          const history = yield* sql<ChangeRow>`SELECT entity_id,action,before_json,after_json,source_text
            FROM changes WHERE entity='rituals'
            AND COALESCE(json_extract(before_json,'$.checkins'),'[]')
                != COALESCE(json_extract(after_json,'$.checkins'),'[]') ORDER BY id`;
          const origins = yield* Effect.fromResult(checkinOrigins(history));
          const rituals = rows.map((row) => ({
            ...row,
            checkins: JSON.parse(row.checkins) as Array<string>,
            _checkin_origins: origins.get(row.date) ?? new Map<Micros, Basis>(),
          }));
          const workouts = (yield* sql<WorkoutRow>`SELECT id,date,type FROM workouts ORDER BY date,id`).map((r) => ({
            ...r,
          }));
          const exceptions =
            (yield* sql<ExceptionRow>`SELECT * FROM applicability_exceptions ORDER BY habit,start_date,id`).map(
              (r) => ({ ...r }),
            );
          return { rituals, workouts, exceptions };
        }),
      );
    }),
  );

export interface WeeklyEntry {
  readonly week_start: string;
  readonly answer: string;
}

/** Weekly answers only, newest week first; nothing else from the store. */
export const readWeekly = (root: string): Effect.Effect<Array<WeeklyEntry>, SqlError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* readOnlyClient(root);
      const rows = yield* sql<WeeklyEntry>`SELECT week_start,answer FROM weekly_reviews ORDER BY week_start DESC`;
      return rows.map((r) => ({ week_start: r.week_start, answer: r.answer }));
    }),
  );

export interface WeekView extends WeeklyEntry {
  readonly week_end: string;
  readonly display: string;
  readonly full: string;
}

export const weekView = (entry: WeeklyEntry): WeekView => {
  const start = civilFromDays(dateToDays(entry.week_start));
  const endDays = dateToDays(entry.week_start) + 6;
  const end = civilFromDays(endDays);
  const display =
    `${MONTHS_SHORT[start.month - 1]} ${start.day} – ` +
    (end.month === start.month ? String(end.day) : `${MONTHS_SHORT[end.month - 1]} ${end.day}`);
  const first =
    `${DAYS_LONG[0]} ${start.day} ${MONTHS_LONG[start.month - 1]}` + (end.year === start.year ? "" : ` ${start.year}`);
  const full = `Week of ${first} – ${DAYS_LONG[6]} ${end.day} ${MONTHS_LONG[end.month - 1]} ${end.year}`;
  return { week_start: entry.week_start, week_end: addDays(entry.week_start, 6), display, full, answer: entry.answer };
};

const RECEIPT_STAMP =
  /\breceived(?:\s+at)?\s*:?\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))/gi;

export const checkinInstant = (value: string): Result.Result<Micros, RequiresReview> => {
  const parsed = parseDateTime(value.replace("Z", "+00:00"));
  if (Result.isFailure(parsed)) return Result.fail(reject(parsed.failure));
  if (parsed.success.offsetSeconds === null) return Result.fail(reject("Check-in timestamp has no timezone"));
  return Result.succeed(parsed.success.micros);
};

const instantSet = (json: string | null): Result.Result<Set<Micros>, RequiresReview> => {
  const parsed = JSON.parse(json ?? "{}") as { checkins?: Array<string> };
  const out = new Set<Micros>();
  for (const stamp of parsed.checkins ?? []) {
    const instant = checkinInstant(stamp);
    if (Result.isFailure(instant)) return Result.fail(instant.failure);
    out.add(instant.success);
  }
  return Result.succeed(out);
};

/**
 * Qualify only timestamps actually introduced by each audit entry.
 *
 * Sources stay private. A labelled receipt instant must match the check-in; later habit reports
 * and their receipt times cannot create or relabel it. Historical midday checkpoints are
 * deliberately never queried.
 */
export const checkinOrigins = (
  history: ReadonlyArray<ChangeRow>,
): Result.Result<Map<string, Map<Micros, Basis>>, RequiresReview> => {
  const origins = new Map<string, Map<Micros, Basis>>();
  for (const change of history) {
    const before = instantSet(change.before_json);
    if (Result.isFailure(before)) return Result.fail(before.failure);
    const after = instantSet(change.after_json);
    if (Result.isFailure(after)) return Result.fail(after.failure);
    const receiptTimes = new Set<Micros>();
    for (const match of change.source_text.matchAll(RECEIPT_STAMP)) {
      const instant = checkinInstant(match[1] as string);
      if (Result.isSuccess(instant)) receiptTimes.add(instant.success);
    }
    const day = origins.get(change.entity_id) ?? new Map<Micros, Basis>();
    origins.set(change.entity_id, day);
    for (const stamp of before.success) if (!after.success.has(stamp)) day.delete(stamp);
    for (const stamp of after.success) {
      if (before.success.has(stamp)) continue;
      day.set(
        stamp,
        receiptTimes.has(stamp) ? "message_received" : change.action === "import" ? "source_recorded" : "recorded",
      );
    }
  }
  return Result.succeed(origins);
};

export interface CheckinItem {
  readonly datetime: string;
  readonly text: string;
  readonly day_offset: number;
  readonly day_label: string;
  readonly basis: Basis;
  readonly label: string;
}

const QUALIFICATION: Record<Basis, string> = {
  message_received: "Check-in message receipt time",
  source_recorded: "Evening check-in recorded in the imported source",
  recorded: "Recorded evening check-in",
};

const pad2 = (value: number): string => String(value).padStart(2, "0");

/** Display the first recorded evening show-up; retain all stored history. */
export const checkinTimes = (row: RitualRow): Result.Result<Array<CheckinItem>, RequiresReview> => {
  const instants = new Set<Micros>();
  for (const stamp of row.checkins ?? []) {
    const instant = checkinInstant(stamp);
    if (Result.isFailure(instant)) return Result.fail(instant.failure);
    instants.add(instant.success);
  }
  const origins = row._checkin_origins ?? new Map<Micros, Basis>();
  const result: Array<CheckinItem> = [];
  for (const stamp of [...instants].toSorted((a, b) => a - b).slice(0, 1)) {
    const local = melbourneParts(stamp);
    const offset = dateToDays(local.date) - dateToDays(row.date);
    const dayLabel =
      offset === 0 ? "" : `${offset > 0 ? "+" : ""}${offset} ` + (Math.abs(offset) === 1 ? "day" : "days");
    const basis = origins.get(stamp) ?? "recorded";
    result.push({
      datetime: isoformatMelbourne(stamp),
      text: hhmm(local),
      day_offset: offset,
      day_label: dayLabel,
      basis,
      label:
        `${pad2(local.day)} ${MONTHS_SHORT[local.month - 1]} ${local.year}, ${hhmm(local)}:${pad2(local.second)} ${melbourneAbbreviation(stamp)}` +
        " · " +
        QUALIFICATION[basis],
    });
  }
  return Result.succeed(result);
};

export const checkinCell = (row: RitualRow): Result.Result<string, RequiresReview> =>
  Result.map(checkinTimes(row), (times) => {
    if (times.length === 0) return '<span class="none" title="No evening check-in recorded">—</span>';
    return times
      .map(
        (item) =>
          `<div class="checkin-entry"><time datetime="${escape(item.datetime)}" title="${escape(item.label)}" aria-label="${escape(item.label)}">${escape(item.text)}</time></div>`,
      )
      .join("");
  });

export interface MatrixRow extends RitualRow {
  readonly activities: Array<string>;
  readonly workout_count: number;
  readonly has_ritual: boolean;
  readonly plank_seconds: number | null;
}

const emptyDay = (day: string): MatrixRow => ({
  date: day,
  magnesium: null,
  protein: null,
  stretching: null,
  journalling: null,
  plank_seconds: null,
  activities: [],
  workout_count: 0,
  has_ritual: false,
});

export const matrix = (rituals: ReadonlyArray<RitualRow>, workouts: ReadonlyArray<WorkoutRow>): Array<MatrixRow> => {
  const rows = new Map<string, MatrixRow>();
  for (const r of rituals) {
    rows.set(r.date, {
      ...r,
      plank_seconds: r.plank_seconds ?? null,
      activities: [],
      workout_count: 0,
      has_ritual: true,
    });
  }
  for (const workout of workouts) {
    const row = rows.get(workout.date) ?? emptyDay(workout.date);
    rows.set(workout.date, row);
    (row as { workout_count: number }).workout_count += 1;
    if (!row.activities.includes(workout.type)) row.activities.push(workout.type);
  }
  if (rows.size > 0) {
    const dates = [...rows.keys()].toSorted();
    const last = dates[dates.length - 1] as string;
    for (let day = dates[0] as string; day <= last; day = addDays(day, 1)) {
      if (!rows.has(day)) rows.set(day, emptyDay(day));
    }
  }
  return [...rows.values()].toSorted((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
};

export const plank = (value: number | null | undefined): string | null =>
  value === null || value === undefined ? null : `${Math.floor(value / 60)}:${pad2(value % 60)}`;

export const mark = (value: boolean | number | null | undefined): string => {
  const [kind, label, glyph] =
    value === null || value === undefined
      ? ["unknown", "Unreported", "·"]
      : value
        ? ["done", "Done", "✓"]
        : ["not-done", "Not done", "×"];
  return `<span class="mark ${kind}" role="img" aria-label="${label}" title="${label}">${glyph}</span>`;
};

const STATUS_LABEL: Record<string, string> = {
  done: "Done",
  not_done: "Not done",
  not_applicable: "Not applicable",
  unreported: "Open — not reported",
};
const BASIS_LABEL: Record<string, string> = {
  missing_after_close: "No report by the next-day noon cutoff; stored value remains unknown",
  exception: "Outside the habit expectation",
  explicit_report: "Explicit report",
  open_day: "Open period; excluded from percentages",
};
const STATUS_GLYPH: Record<string, [string, string]> = {
  done: ["done", "✓"],
  not_done: ["not-done", "×"],
  not_applicable: ["na", "N/A"],
  unreported: ["unknown", "·"],
};

export const statusMark = (cell: Cell, seconds: number | null = null): string => {
  const state = cell.status;
  const label = STATUS_LABEL[state] as string;
  const basis = BASIS_LABEL[cell.basis] ?? cell.basis;
  if (state === "done" && seconds !== null)
    return `<span class="time" title="${seconds} seconds">${plank(seconds)}</span>`;
  const [kind, glyph] = STATUS_GLYPH[state] as [string, string];
  return `<span class="mark ${kind}" role="img" aria-label="${label}" title="${escape(label + ": " + basis)}">${glyph}</span>`;
};

export const rate = (value: { readonly percentage: number | null }): string =>
  value.percentage === null ? "—" : `${fixed1(value.percentage)}%`;

export let CSS = `
:root{color-scheme:light;--ink:#243c36;--subtle:#64736b;--line:#dce5df;--paper:#fff;--wash:#f3f6f2;--green:#256449}
*{box-sizing:border-box}body{margin:0;background:var(--wash);color:var(--ink);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:1440px;margin:auto;padding:34px 32px 24px}.eyebrow{font-size:11px;letter-spacing:.14em;text-transform:uppercase;font-weight:650;color:var(--subtle);margin:0 0 9px}header{display:flex;align-items:flex-start;justify-content:space-between;gap:20px}h1{margin:0;font:550 32px/1.2 -apple-system,BlinkMacSystemFont,sans-serif;letter-spacing:-1px}.subhead{margin:8px 0 0;color:var(--subtle)}.snapshot{margin:0;text-align:right;font-size:12px;line-height:1.8;color:var(--subtle)}.snapshot strong{font-weight:550;color:var(--ink)}.toolbar{display:flex;justify-content:space-between;align-items:end;gap:18px;margin:28px 0 14px;flex-wrap:wrap}.filters{display:flex;gap:10px;align-items:end}label{display:block;font-size:11px;font-weight:650;letter-spacing:.04em;color:var(--subtle)}select,button{font:inherit;color:var(--ink);background:var(--paper);border:1px solid #cbd7ce;border-radius:6px;padding:8px 12px;margin-top:5px;min-height:38px}select{min-width:150px}button{cursor:pointer;background:transparent}button:hover{background:#e9efe9}button:focus-visible,select:focus-visible{outline:2px solid var(--green);outline-offset:2px}.legend{display:flex;align-items:center;gap:16px;font-size:12px;color:var(--subtle);flex-wrap:wrap}.legend span{display:inline-flex;align-items:center;gap:6px}.legend .mark{width:23px;height:23px;font-size:17px}.sheet{margin-top:28px;border:1px solid #cfdbd2;border-radius:9px;background:var(--paper);overflow:hidden;box-shadow:0 2px 4px #173c2310}.scroll{max-height:calc(100vh - 260px);min-height:280px;overflow:auto}table{border-collapse:separate;border-spacing:0;width:100%;min-width:945px;table-layout:fixed}thead th{position:sticky;top:0;z-index:3;background:#e7eee7;border-bottom:1px solid #bccdbe;height:48px;font-size:12px;font-weight:650;color:#4d6255}th,td{border-right:1px solid var(--line);text-align:center;padding:7px 14px}th:last-child,td:last-child{border-right:0}tbody td,tbody th{border-bottom:1px solid var(--line);height:48px}tbody tr:last-child td,tbody tr:last-child th{border-bottom:0}tbody tr{--row-bg:#fff;background:var(--row-bg)}tbody tr:nth-child(even){--row-bg:#fafcf9}tbody tr:first-child{--row-bg:#f0f6ec}tbody tr:hover{--row-bg:#edf4ef}th.date,td.date{position:sticky;left:0;z-index:2;background:var(--row-bg,#e7eee7);width:156px;text-align:left}thead th.date{z-index:4;background:#e7eee7}.date time{font-weight:600;font-variant-numeric:tabular-nums}.weekday{font-size:11px;color:var(--subtle);font-weight:400;margin-left:7px}.date small{display:block;font-size:10px;font-weight:400;color:var(--subtle)}.check-col{width:113px}.plank-col{width:110px}.activities{text-align:left;width:auto;min-width:210px}.activity-text{line-height:1.4;overflow-wrap:anywhere}.mark{display:inline-flex;justify-content:center;align-items:center;border-radius:5px;width:27px;height:27px;font-size:19px;font-weight:500}.done{background:#e0eee0;color:#2d6949}.not-done{background:#f9e9d8;color:#9d5e28}.unknown{color:#9aa79e;font-size:24px}.time{font:600 14px ui-monospace,SFMono-Regular,Menlo,monospace;font-variant-numeric:tabular-nums;color:#354d40}.none{color:#9aa79e}.table-foot{padding:10px 14px;display:flex;justify-content:space-between;border-top:1px solid var(--line);font-size:11px;color:var(--subtle);gap:12px}.footnote{font-size:12px;color:var(--subtle);margin:14px 0 0;max-width:950px}.empty{text-align:center;padding:28px;color:var(--subtle)}[hidden]{display:none!important}details{margin-top:16px;font-size:12px;color:var(--subtle)}summary{cursor:pointer}code{font-size:11px;overflow-wrap:anywhere}details p{max-width:1000px}noscript{display:block;padding:10px;color:#9d5e28}@media(max-width:760px){main{padding:22px 14px}header{display:block}.snapshot{text-align:left;margin-top:12px}.toolbar{margin-top:20px}.legend{gap:12px}.scroll{max-height:65vh}.filters{flex-wrap:wrap}select{min-width:125px}.table-foot{flex-wrap:wrap}}@media print{body{background:white}main{padding:0}.filters,details{display:none}.scroll{max-height:none;overflow:visible}table{min-width:0;font-size:10px}.sheet{overflow:visible}th.date,td.date,thead th{position:static}}
`;
CSS +=
  ".na{font-size:10px;color:#637588;background:#edf0f4}.open-badge{color:#346883!important}.period-note{padding:10px 12px;border:1px solid #d4e0dc;background:#eef4f0;border-radius:6px;margin-top:18px;font-size:12px}.completion-note{font-size:12px;color:var(--subtle);margin:10px 0}.completion-note strong{color:var(--ink)}.header-metric{display:block;font-variant-numeric:tabular-nums;font-weight:500;color:#4d6255;margin-top:2px}";

CSS += theme.CSS;
CSS +=
  "table{min-width:1105px}.checkin-col{width:160px}.checkin{font-variant-numeric:tabular-nums;vertical-align:middle}.checkin-entry{white-space:nowrap}.checkin-entry+.checkin-entry{margin-top:5px}.checkin-entry time{font-weight:550}.checkin-offset{margin-left:6px;color:var(--subtle);font-size:11px}.checkin-basis{display:block;color:var(--subtle);font-size:10px;font-weight:400}.checkin-zone{display:block;color:var(--subtle);font-size:10px;font-weight:400}@media print{table{min-width:0}}";
export const CHECKIN_HEADER = '<th class="checkin-col" scope="col">Check-in time</th>';
// iOS 26 home-screen web apps report a 0 top inset yet blur about 40pt at the top of the page; only there, start the title bar below it.
// display-mode needs a manifest in WebKit, so the theme script also flags navigator.standalone (iOS web clips).
CSS += `:root{--web-app-top:0px}
@media (display-mode:standalone),(display-mode:fullscreen){:root{--web-app-top:10px}}
:root[data-web-app]{--web-app-top:10px}
`;
CSS += `
@media screen and (max-width:760px){
html,body{height:100%;overflow:hidden}
main{width:100%;max-width:none;height:100vh;height:100dvh;margin:0;padding:0;display:flex;flex-direction:column}
header{display:flex;flex:none;align-items:center;justify-content:space-between;gap:12px;padding:calc(4px + var(--web-app-top) + env(safe-area-inset-top)) calc(8px + env(safe-area-inset-right)) 4px calc(12px + env(safe-area-inset-left));background:var(--paper);border-bottom:1px solid var(--border)}
header h1{font-size:18px;font-weight:600;letter-spacing:-.3px}
.header-actions{margin:0}
header .snapshot{display:none}
.sheet{flex:1;min-height:0;margin:0;border:0;border-radius:0;box-shadow:none}
.scroll{width:100%;height:100%;max-height:none;min-height:0;overflow:auto;overscroll-behavior:contain;padding-bottom:env(safe-area-inset-bottom)}
table{min-width:680px;font-size:12px}
th,td{padding:4px 6px}
thead th{height:42px;font-size:10px}
tbody td,tbody th{height:34px}
th.date,td.date{width:108px;padding-left:8px;line-height:1.3}
.date small{font-size:9px;line-height:1.2}
.checkin-col{width:80px}
.check-col{width:74px}
.plank-col{width:62px}
.activities{min-width:120px}
.mark{width:22px;height:22px;font-size:16px}
.na{font-size:9px}
.time{font-size:12px}
.header-metric{margin-top:1px}
.theme-toggle{width:44px;height:44px;min-width:44px;min-height:44px;margin:0;padding:0;border:1px solid var(--border);border-radius:50%;font-size:0;background:var(--paper)}
.theme-toggle::before{content:'◐';font-size:21px;line-height:1}
:root[data-theme="light"] .theme-toggle::before{content:'☀'}
:root[data-theme="dark"] .theme-toggle::before{content:'☾'}
}
`;

CSS += `
.ritual-switch{position:relative;display:inline-flex;align-items:center;gap:6px;min-width:0;border-radius:8px}
.ritual-switch h1{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.picker-icon{display:inline-flex;flex:none;align-items:center;justify-content:center;width:32px;height:32px;border-radius:50%;color:var(--subtle)}
.picker-icon svg{width:18px;height:18px}
.ritual-switch:hover .picker-icon{background:var(--hover);color:var(--ink)}
.ritual-switch select{position:absolute;inset:0;width:100%;height:100%;min-width:0;min-height:0;margin:0;padding:0;border:0;opacity:0;cursor:pointer;font-size:16px;-webkit-appearance:none;appearance:none}
.ritual-switch:has(select:focus-visible){outline:2px solid var(--green);outline-offset:3px}
table.weekly-table{min-width:0}.scroll:has(.weekly-table){min-height:0}
.weekly-table th.date,.weekly-table td.answer{vertical-align:top;padding-top:13px;padding-bottom:13px}
.weekly-table td.answer{text-align:left;white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px;line-height:21px}
.weekly-table thead th.answer{text-align:left}
@media screen and (max-width:760px){.ritual-switch{min-height:44px;gap:2px}.picker-icon{width:28px;height:28px}.weekly-table th.date,.weekly-table td.answer{padding-top:10px;padding-bottom:10px}.weekly-table td.answer{font-size:13px;line-height:20px}}
@media print{.picker-icon{display:none}}
`;

// Each ritual is its own page; the title opens a native picker between them.
export type Ritual = "daily" | "weekly";
export const RITUALS: ReadonlyArray<readonly [Ritual, string]> = [
  ["daily", "Daily rituals"],
  ["weekly", "Weekly review"],
];
export const RITUAL_NAMES: Record<Ritual, string> = { daily: "Daily rituals", weekly: "Weekly review" };
// Relative to the app's base, so the live pages work at the root and under a Tailscale Serve path mount alike.
export const LIVE_PATHS: Record<Ritual, string> = { daily: "./", weekly: "weekly" };
export const SNAPSHOT_FILES: Record<Ritual, string> = { daily: "ritual-dashboard.html", weekly: "weekly-review.html" };
export const CHEVRON =
  '<svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true" focusable="false"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export const titleBar = (current: Ritual, links: Record<Ritual, string>, snapshot: string): string => {
  const options = RITUALS.map(
    ([key, name]) =>
      `<option value="${escape(links[key])}"${key === current ? " selected" : ""}>${escape(name)}</option>`,
  ).join("");
  return (
    `<header><div class="ritual-switch"><h1>${escape(RITUAL_NAMES[current])}</h1><span class="picker-icon">${CHEVRON}</span>` +
    `<select id="ritual-picker" aria-label="Choose a ritual">${options}</select></div>` +
    `<div class="header-actions">${snapshot}${theme.BUTTON}</div></header>`
  );
};

export const page = (
  current: Ritual,
  csp: string,
  body: string,
  links: Record<Ritual, string> = SNAPSHOT_FILES,
  snapshot = "",
): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta http-equiv="Content-Security-Policy" content="${escape(csp)}"><title>${escape(RITUAL_NAMES[current])}</title><script>${theme.SCRIPT}</script><style>${CSS}</style></head><body><main>
${titleBar(current, links, snapshot)}
${body}</main></body></html>`;

export const STATIC_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-" +
  theme.HASH +
  "'; base-uri 'none'; form-action 'none'";
export const WEEKLY_EMPTY = "No weekly reviews recorded yet.";

export const weeksLabel = (count: number): string => `${count} ${count === 1 ? "week" : "weeks"}`;

export const weeklyHeader = (countText: string): string =>
  `<th class="date" scope="col">Week <span class="header-metric">(<span id="week-count" aria-live="polite">${countText}</span>)</span></th><th class="answer" scope="col">Done this week</th>`;

export const renderWeekly = (entries: ReadonlyArray<WeeklyEntry>, generatedAt: Micros): string => {
  const stamp = updatedDisplay(generatedAt);
  const body = entries
    .map(weekView)
    .map(
      (w) =>
        `<tr data-week="${escape(w.week_start)}"><th scope="row" class="date"><time datetime="${escape(w.week_start)}" title="${escape(w.full)}" aria-label="${escape(w.full)}">${escape(w.display)}</time></th><td class="answer">${escape(w.answer)}</td></tr>`,
    )
    .join("");
  return page(
    "weekly",
    STATIC_CSP,
    `<div class="sheet"><div class="scroll"><table class="weekly-table" aria-label="Weekly review answers"><thead><tr>${weeklyHeader(weeksLabel(entries.length))}</tr></thead><tbody>${body}</tbody></table><p class="empty"${entries.length > 0 ? " hidden" : ""}>${WEEKLY_EMPTY}</p></div></div>
`,
    SNAPSHOT_FILES,
    `<p class="snapshot">Updated ${escape(stamp)}</p>`,
  );
};

const HABIT_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ["magnesium", "Magnesium"],
  ["protein", "Protein"],
  ["stretching", "Stretches"],
  ["planks", "Plank"],
  ["journalling", "Journalling"],
];

export const dateLabels = (day: string): { display: string; full: string } => {
  const civil = civilFromDays(dateToDays(day));
  const dow = (((dateToDays(day) + 3) % 7) + 7) % 7;
  return {
    display: `${DAYS_SHORT[dow]} · ${MONTHS_SHORT[civil.month - 1]} ${civil.day}`,
    full: `${DAYS_LONG[dow]}, ${civil.day} ${MONTHS_LONG[civil.month - 1]} ${civil.year}`,
  };
};

export const render = (
  rows: ReadonlyArray<MatrixRow>,
  generatedAt: Micros,
  report?: StatusReport,
): Result.Result<string, RequiresReview | ApplicabilityConflict> => {
  if (report === undefined) {
    const computed = statusReport(rows, [], [], generatedAt);
    if (Result.isFailure(computed)) return Result.fail(computed.failure);
    report = computed.success;
  }
  const derived = new Map(report.records.map((r) => [r.date, r] as const));
  const stamp = updatedDisplay(generatedAt);
  const body: Array<string> = [];
  let workoutDays = 0;
  let closedDays = 0;
  for (const row of rows) {
    const state = derived.get(row.date);
    if (state === undefined) return Result.fail(reject(`No derived status for ${row.date}`));
    const labels = dateLabels(row.date);
    let dateCell = `<time datetime="${row.date}" title="${escape(labels.full)}" aria-label="${escape(labels.full)}">${labels.display}</time>`;
    if (state.period !== "closed") {
      dateCell += `<small class="open-badge">${state.period.charAt(0).toUpperCase() + state.period.slice(1)} · not counted</small>`;
    } else if (!row.has_ritual)
      dateCell += "<small>" + (row.workout_count > 0 ? "Activities only" : "No report") + "</small>";
    const cells = [`<th scope="row" class="date">${dateCell}</th>`];
    const checkin = checkinCell(row);
    if (Result.isFailure(checkin)) return Result.fail(checkin.failure);
    cells.push(`<td class="checkin">${checkin.success}</td>`);
    for (const field of ["magnesium", "protein", "stretching"] as const) {
      const cell = state.habits[field];
      cells.push(`<td data-field="${field}" data-status="${cell.status}">${statusMark(cell)}</td>`);
    }
    const plankCell = state.habits.planks;
    cells.push(
      `<td data-field="plank_seconds" data-status="${plankCell.status}">${statusMark(plankCell, row.plank_seconds)}</td>`,
    );
    const journal = state.habits.journalling;
    cells.push(`<td data-field="journalling" data-status="${journal.status}">${statusMark(journal)}</td>`);
    const categories =
      row.activities.length > 0
        ? escape(row.activities.join(", "))
        : '<span class="none" title="No activities recorded">—</span>';
    cells.push(
      `<td class="activities"><span class="activity-text" title="${row.workout_count} recorded workouts">${categories}</span></td>`,
    );
    const closed = state.period === "closed";
    workoutDays += closed && row.workout_count > 0 ? 1 : 0;
    closedDays += closed ? 1 : 0;
    body.push(`<tr data-date="${row.date}" data-period="${state.period}">` + cells.join("") + "</tr>");
  }
  const habitHeaders = HABIT_COLUMNS.map(([h, label]) => {
    const metric = report.by_habit[h as keyof typeof report.by_habit];
    return `<th class="${h === "planks" ? "plank-col" : "check-col"}" scope="col">${label} <span class="header-metric">(<span data-rate-habit="${h}" title="${metric.done} of ${metric.applicable} applicable closed days">${rate(metric)}</span>)</span></th>`;
  }).join("");
  const workoutRate = rate({ percentage: closedDays > 0 ? (100 * workoutDays) / closedDays : null });
  const workoutHeader = `<th class="activities" scope="col">Workout <span class="header-metric">(<span data-rate-habit="workout" title="${workoutDays} of ${closedDays} closed days with a recorded workout">${workoutRate}</span>)</span></th>`;
  return Result.succeed(
    page(
      "daily",
      STATIC_CSP,
      `<div class="sheet"><div class="scroll"><table aria-label="Daily ritual and workout matrix"><thead><tr><th class="date" scope="col">Date <span class="header-metric">(<span id="visible-count" aria-live="polite">${rows.length} ${rows.length === 1 ? "day" : "days"}</span>)</span></th>${CHECKIN_HEADER}${habitHeaders}${workoutHeader}</tr></thead><tbody>${body.join("")}</tbody></table><p class="empty"${rows.length > 0 ? " hidden" : ""}>No dates recorded yet.</p></div></div>
`,
      SNAPSHOT_FILES,
      `<p class="snapshot">Updated ${escape(stamp)}</p>`,
    ),
  );
};

export interface GenerateResult {
  readonly updated: true;
  readonly path: string;
  readonly weekly_path: string;
  readonly generated_at: string;
  readonly days: number;
  readonly workouts: number;
  readonly weeks: number;
}

export type GenerateError = SqlError | PlatformError | RequiresReview | ApplicabilityConflict;

/** Regenerate both static snapshots under data/views, one writer at a time. */
export const generate = (root: string): Effect.Effect<GenerateResult, GenerateError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const resolved = resolve(root);
    const folder = join(resolved, "data", "views");
    yield* fs.makeDirectory(folder, { recursive: true, mode: 0o700 });
    const lock = join(folder, ".dashboard.lock");
    yield* ensureFile(lock, 0o600);
    const target = join(folder, SNAPSHOT_FILES.daily);
    const weekly = join(folder, SNAPSHOT_FILES.weekly);
    const outcome = yield* withFileLock(
      lock,
      true,
      Effect.gen(function* () {
        const records = yield* readRecords(resolved);
        const rows = matrix(records.rituals, records.workouts);
        const stamp = yield* nowMicros;
        const report = yield* Effect.fromResult(
          statusReport(records.rituals, records.workouts, records.exceptions, stamp),
        );
        const weeks = yield* readWeekly(resolved);
        yield* atomicWrite(target, yield* Effect.fromResult(render(rows, stamp, report)), { prefix: ".dashboard-" });
        yield* atomicWrite(weekly, renderWeekly(weeks, stamp), { prefix: ".dashboard-" });
        return { stamp, days: rows.length, workouts: records.workouts.length, weeks: weeks.length };
      }),
    );
    const done = Option.getOrThrow(outcome);
    return {
      updated: true,
      path: target,
      weekly_path: weekly,
      generated_at: isoformatUtc(done.stamp),
      days: done.days,
      workouts: done.workouts,
      weeks: done.weeks,
    };
  });

export { BOOLS };
