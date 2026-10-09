// Dashboard-only API projections and frontends; source records are never exposed.
//
// Daily rituals show derived habit cells; the weekly review shows only each week's answer text.
import { Effect, Result } from "effect";
import type { PlatformError } from "effect/PlatformError";
import type { SqlError } from "effect/sql/SqlError";
import { type Cell, type Habit, statusReport } from "./applicability.ts";
import { sha256Base64 } from "./encoding.ts";
import type { ApplicabilityConflict, RequiresReview } from "./errors.ts";
import { isoformatUtc, type Micros, nowMicros, TIMEZONE, updatedDisplay } from "./instants.ts";
import * as dashboard from "./dashboard.ts";
import * as theme from "./dashboardTheme.ts";

export const HABITS: ReadonlyArray<readonly [Habit, string]> = [
  ["magnesium", "Magnesium"],
  ["protein", "Protein"],
  ["stretching", "Stretches"],
  ["planks", "Plank"],
  ["journalling", "Journalling"],
];

export interface CellView {
  readonly status: Cell["status"];
  readonly text: string;
  readonly label: string;
  readonly numeric: boolean;
}

const LABELS: Record<Cell["status"], string> = {
  done: "Done",
  not_done: "Not done",
  not_applicable: "Not applicable",
  unreported: "Open — not reported",
};
const TEXT: Record<Cell["status"], string> = { done: "✓", not_done: "×", not_applicable: "N/A", unreported: "·" };

export const cellView = (cell: Cell, seconds: number | null = null): CellView => {
  const state = cell.status;
  const numeric = state === "done" && seconds !== null;
  const text = numeric ? (dashboard.plank(seconds) as string) : TEXT[state];
  return { status: state, text, label: numeric ? `${seconds} seconds` : LABELS[state], numeric };
};

export interface Rate {
  readonly done: number;
  readonly denominator: number;
  readonly percentage: number | null;
}

export interface DashboardRow {
  readonly date: string;
  readonly display_date: string;
  readonly full_date: string;
  readonly period: string;
  readonly annotation: string;
  readonly checkin_times: ReadonlyArray<dashboard.CheckinItem>;
  readonly cells: Record<Habit, CellView>;
  readonly workouts: { readonly types: ReadonlyArray<string>; readonly count: number };
}

export interface DashboardData {
  readonly generated_at: string;
  readonly updated_display: string;
  readonly timezone: string;
  readonly count: number;
  readonly rates: Record<string, Rate>;
  readonly rows: ReadonlyArray<DashboardRow>;
}

export type DataError = RequiresReview | ApplicabilityConflict;

/** The daily projection from already-read records, so the noon cutoff is computed for `asOf`. */
export const dashboardData = (records: dashboard.Records, asOf: Micros): Result.Result<DashboardData, DataError> => {
  const reported = statusReport(records.rituals, records.workouts, records.exceptions, asOf);
  if (Result.isFailure(reported)) return Result.fail(reported.failure);
  const report = reported.success;
  const derived = new Map(report.records.map((r) => [r.date, r] as const));
  const rows: Array<DashboardRow> = [];
  let workoutDays = 0;
  let closedDays = 0;
  for (const row of dashboard.matrix(records.rituals, records.workouts)) {
    const state = derived.get(row.date);
    if (state === undefined) continue;
    const closed = state.period === "closed";
    closedDays += closed ? 1 : 0;
    workoutDays += closed && row.workout_count > 0 ? 1 : 0;
    const annotation = !closed
      ? state.period.charAt(0).toUpperCase() + state.period.slice(1) + " · not counted"
      : row.has_ritual
        ? ""
        : row.workout_count > 0
          ? "Activities only"
          : "No report";
    const times = dashboard.checkinTimes(row);
    if (Result.isFailure(times)) return Result.fail(times.failure);
    const labels = dashboard.dateLabels(row.date);
    const cells = {} as Record<Habit, CellView>;
    for (const [habit] of HABITS)
      cells[habit] = cellView(state.habits[habit], habit === "planks" ? row.plank_seconds : null);
    rows.push({
      date: row.date,
      display_date: labels.display,
      full_date: labels.full,
      period: state.period,
      annotation,
      checkin_times: times.success,
      cells,
      workouts: { types: row.activities, count: row.workout_count },
    });
  }
  const rates: Record<string, Rate> = {};
  for (const [habit] of HABITS) {
    const metric = report.by_habit[habit];
    rates[habit] = { done: metric.done, denominator: metric.applicable, percentage: metric.percentage };
  }
  rates.workout = {
    done: workoutDays,
    denominator: closedDays,
    percentage: closedDays > 0 ? (100 * workoutDays) / closedDays : null,
  };
  return Result.succeed({
    generated_at: isoformatUtc(asOf),
    updated_display: updatedDisplay(asOf),
    timezone: TIMEZONE,
    count: rows.length,
    rates,
    rows,
  });
};

export type ReadError = SqlError | PlatformError | DataError;

/** Read the store fresh and project it; every request recomputes the noon cutoff. */
export const readDashboardData = (root: string, asOf?: Micros): Effect.Effect<DashboardData, ReadError> =>
  Effect.gen(function* () {
    const records = yield* dashboard.readRecords(root);
    const stamp = asOf ?? (yield* nowMicros);
    return yield* Effect.fromResult(dashboardData(records, stamp));
  });

export interface WeeklyData {
  readonly generated_at: string;
  readonly updated_display: string;
  readonly timezone: string;
  readonly count: number;
  readonly weeks: ReadonlyArray<dashboard.WeekView>;
}

export const weeklyData = (entries: ReadonlyArray<dashboard.WeeklyEntry>, asOf: Micros): WeeklyData => {
  const weeks = entries.map(dashboard.weekView);
  return {
    generated_at: isoformatUtc(asOf),
    updated_display: updatedDisplay(asOf),
    timezone: TIMEZONE,
    count: weeks.length,
    weeks,
  };
};

export const readWeeklyData = (root: string, asOf?: Micros): Effect.Effect<WeeklyData, SqlError> =>
  Effect.gen(function* () {
    const entries = yield* dashboard.readWeekly(root);
    return weeklyData(entries, asOf ?? (yield* nowMicros));
  });

// Shared by both pages: text-only DOM building and a refresh on load, on return to the tab and each visible minute.
export const LOADER = `const body = document.querySelector('tbody');
const message = document.querySelector('#message');
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function load(url, render) {
  let loading = false;
  async function refresh() {
    if (loading) return;
    loading = true;
    try {
      const response = await fetch(url, {cache:'no-store',credentials:'same-origin'});
      if (!response.ok) throw new Error('Unavailable');
      render(await response.json());
    } catch (_) {
      message.textContent = 'Dashboard unavailable. Last loaded values may be out of date. Refresh to retry.';
      message.hidden = false;
    } finally { loading = false; }
  }
  refresh();
  setInterval(() => { if (!document.hidden) refresh(); }, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
}
`;
// The daily page is the app's base address. Serve forwards a mount without its trailing slash (/rituals) as / too,
// so add the slash before anything resolves a relative URL, or api/dashboard and weekly would escape the mount.
export const DAILY_SCRIPT =
  `if (!location.pathname.endsWith('/')) history.replaceState(null, '', location.pathname + '/' + location.search + location.hash);
` +
  LOADER +
  `const habits = ['magnesium','protein','stretching','planks','journalling'];
function render(data) {
  const fragment = document.createDocumentFragment();
  for (const row of data.rows) {
    const tr = element('tr');
    const date = element('th', undefined, 'date'); date.scope = 'row';
    const time = element('time', row.display_date); time.dateTime = row.date;
    time.title = row.full_date; time.setAttribute('aria-label', row.full_date); date.append(time);
    if (row.annotation) date.append(element('small', row.annotation, row.period === 'closed' ? '' : 'open-badge'));
    tr.append(date);
    const checkin = element('td', undefined, 'checkin');
    const times = row.checkin_times || [];
    if (!times.length) {
      const empty = element('span', '—', 'none');
      empty.title = 'No evening check-in recorded'; checkin.append(empty);
    }
    for (const item of times) {
      const entry = element('div', undefined, 'checkin-entry');
      const time = element('time', item.text); time.dateTime = item.datetime;
      time.title = item.label; time.setAttribute('aria-label', item.label); entry.append(time);
      checkin.append(entry);
    }
    tr.append(checkin);
    for (const habit of habits) {
      const cell = row.cells[habit];
      const td = element('td');
      const classes = {done:'done',not_done:'not-done',not_applicable:'na',unreported:'unknown'};
      const mark = element('span', cell.text, cell.numeric ? 'time' : 'mark '+classes[cell.status]);
      mark.title = cell.label; mark.setAttribute('aria-label', cell.label);
      if (!cell.numeric) mark.setAttribute('role','img');
      td.append(mark);tr.append(td);
    }
    const workouts = element('td', undefined, 'activities');
    const types = element('span', row.workouts.types.length ? row.workouts.types.join(', ') : '—', row.workouts.types.length ? 'activity-text' : 'none');
    types.title = row.workouts.count+' recorded workouts';workouts.append(types);tr.append(workouts);
    fragment.append(tr);
  }
  body.replaceChildren(fragment);
  document.querySelector('#day-count').textContent = data.count+' '+(data.count === 1 ? 'day' : 'days');
  for (const node of document.querySelectorAll('[data-rate]')) {
    const metric = data.rates[node.dataset.rate];
    node.textContent = metric.percentage === null ? '—' : metric.percentage.toFixed(1)+'%';
    node.title = metric.done+' of '+metric.denominator+(node.dataset.rate === 'workout' ? ' closed days with a recorded workout' : ' applicable closed days');
  }
  document.querySelector('#updated').textContent = 'Updated '+data.updated_display;
  message.textContent = data.count ? '' : 'No dates recorded yet.';message.hidden = data.count !== 0;
}
load('api/dashboard', render);`;
export const WEEKLY_SCRIPT =
  LOADER +
  `function render(data) {
  const fragment = document.createDocumentFragment();
  for (const week of data.weeks) {
    const tr = element('tr');
    const date = element('th', undefined, 'date'); date.scope = 'row';
    const time = element('time', week.display); time.dateTime = week.week_start;
    time.title = week.full; time.setAttribute('aria-label', week.full); date.append(time);
    tr.append(date, element('td', week.answer, 'answer'));
    fragment.append(tr);
  }
  body.replaceChildren(fragment);
  document.querySelector('#week-count').textContent = data.count+' '+(data.count === 1 ? 'week' : 'weeks');
  document.querySelector('#updated').textContent = 'Updated '+data.updated_display;
  message.textContent = data.count ? '' : ` +
  JSON.stringify(dashboard.WEEKLY_EMPTY) +
  `;message.hidden = data.count !== 0;
}
load('api/weekly', render);`;
export const SCRIPTS: Record<dashboard.Ritual, string> = { daily: DAILY_SCRIPT, weekly: WEEKLY_SCRIPT };
export const scriptHash = (script: string): string => sha256Base64(script);
export const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src " +
  [...Object.values(SCRIPTS), theme.SCRIPT].map((x) => `'sha256-${scriptHash(x)}'`).join(" ") +
  "; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
export const LOADING = '<p class="empty" id="message" role="status">Loading dashboard…</p>';

export const frontend = (ritual: dashboard.Ritual = "daily"): string => {
  let table: string;
  if (ritual === "daily") {
    const headers = HABITS.map(
      ([h, label]) =>
        `<th class="${h === "planks" ? "plank-col" : "check-col"}" scope="col">${label}<span class="header-metric">(<span data-rate="${h}">—</span>)</span></th>`,
    ).join("");
    table = `<table aria-label="Daily ritual and workout matrix"><thead><tr><th class="date" scope="col">Date<span class="header-metric">(<span id="day-count">—</span>)</span></th>${dashboard.CHECKIN_HEADER}${headers}<th class="activities" scope="col">Workout<span class="header-metric">(<span data-rate="workout">—</span>)</span></th></tr></thead><tbody></tbody></table>`;
  } else {
    table = `<table class="weekly-table" aria-label="Weekly review answers"><thead><tr>${dashboard.weeklyHeader("—")}</tr></thead><tbody></tbody></table>`;
  }
  const body = `<div class="sheet"><div class="scroll">${table}${LOADING}</div></div>\n<script>${SCRIPTS[ritual]}</script>`;
  return dashboard.page(ritual, CSP, body, dashboard.LIVE_PATHS, '<p class="snapshot" id="updated">Updated —</p>');
};

export const jsonResponse = (root: string): Effect.Effect<string, ReadError> =>
  Effect.map(readDashboardData(root), (data) => JSON.stringify(data));

export const weeklyResponse = (root: string): Effect.Effect<string, SqlError> =>
  Effect.map(readWeeklyData(root), (data) => JSON.stringify(data));
