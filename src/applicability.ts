// Applicability and completion views; never overwrite raw observations.
// Pure functions: they return Result values and the store lifts them into Effects.
import { Result } from "effect";
import { ApplicabilityConflict, RequiresReview, reject } from "./errors.ts";
import {
  addDays,
  fromMelbourne,
  isoformat,
  isoformatUtc,
  melbourneParts,
  parseDate,
  parseDateTime,
  TIMEZONE,
  type Micros,
} from "./instants.ts";
import { sameJson } from "./encoding.ts";

/** Alphabetical, which is the order Python's sorted(HABITS) produced everywhere. */
export const HABITS = ["journalling", "magnesium", "planks", "protein", "stretching"] as const;
export type Habit = (typeof HABITS)[number];
export const isHabit = (value: unknown): value is Habit => HABITS.includes(value as Habit);

export const TABLE_SQL = `CREATE TABLE applicability_exceptions(
 id TEXT PRIMARY KEY,
 habit TEXT NOT NULL CHECK(habit IN ('magnesium','protein','stretching','journalling','planks')),
 start_date TEXT,
 end_date TEXT NOT NULL,
 reason TEXT NOT NULL,
 CHECK(start_date IS NULL OR start_date <= end_date)
);`;

export interface ExceptionRow {
  readonly id: string;
  readonly habit: Habit;
  readonly start_date: string | null;
  readonly end_date: string;
  readonly reason: string;
}

const EXCEPTION_FIELDS = ["id", "habit", "start_date", "end_date", "reason"];

export const validateException = (
  row: Record<string, unknown>,
  existing: ReadonlyArray<Record<string, unknown>>,
): Result.Result<"replayed" | "new", RequiresReview> => {
  const keys = Object.keys(row);
  if (keys.length !== EXCEPTION_FIELDS.length || !EXCEPTION_FIELDS.every((k) => keys.includes(k))) {
    return Result.fail(reject("Exactly id, habit, start_date, end_date and reason are required"));
  }
  const reason = row.reason;
  if (!row.id || typeof reason !== "string" || reason.trim() === "" || !isHabit(row.habit)) {
    return Result.fail(reject("Valid ID, habit and reason are required"));
  }
  for (const field of ["start_date", "end_date"] as const) {
    const value = row[field];
    if (value === null && field === "start_date") continue;
    if (typeof value !== "string") return Result.fail(reject("Use ISO calendar dates"));
    const parsed = parseDate(value);
    if (Result.isFailure(parsed)) return Result.fail(reject(parsed.failure));
    if (parsed.success !== value) return Result.fail(reject("Use ISO calendar dates"));
  }
  const start = (row.start_date as string | null) ?? "0001-01-01";
  const end = row.end_date as string;
  if (start > end) return Result.fail(reject("Exception dates are reversed"));
  for (const old of existing) {
    if (old.id === row.id) {
      if (sameJson(old, row)) return Result.succeed("replayed");
      return Result.fail(reject("Exception ID already has different content"));
    }
    if (
      old.habit === row.habit &&
      start <= (old.end_date as string) &&
      ((old.start_date as string | null) ?? "0001-01-01") <= end
    ) {
      return Result.fail(reject("Overlapping exceptions for the same habit"));
    }
  }
  return Result.succeed("new");
};

export const applies = (exception: ExceptionRow, habit: Habit, day: string): boolean =>
  exception.habit === habit &&
  (exception.start_date === null || exception.start_date <= day) &&
  day <= exception.end_date;

export type CellStatus = "done" | "not_done" | "not_applicable" | "unreported";
export type CellBasis = "exception" | "source_report" | "explicit_report" | "missing_after_close" | "open_day";

export interface Cell {
  readonly status: CellStatus;
  readonly basis: CellBasis;
  readonly raw: unknown;
  readonly applicable: boolean;
  readonly included_in_completion: boolean;
  readonly exception_id: string | null;
}

/**
 * Closure is explicit input until the reporting cutoff is agreed.
 *
 * sourceDone can preserve a verified legacy completion without duration; callers must supply its
 * evidence rather than treating missing seconds as no.
 */
export const derive = (
  habit: Habit,
  day: string,
  raw: unknown,
  exceptions: ReadonlyArray<ExceptionRow>,
  closedThrough: string | null,
  sourceDone = false,
): Result.Result<Cell, ApplicabilityConflict | RequiresReview> => {
  if (!isHabit(habit)) return Result.fail(reject("Unknown habit"));
  const present = raw !== null && raw !== undefined;
  const done = sourceDone || (present && (habit === "planks" ? Number(raw) > 0 : Boolean(raw)));
  const match = exceptions.find((x) => applies(x, habit, day));
  if (match && done) {
    return Result.fail(
      new ApplicabilityConflict({ message: `${day} ${habit}: positive report conflicts with exception ${match.id}` }),
    );
  }
  const closed = closedThrough !== null && day <= closedThrough;
  let status: CellStatus;
  let basis: CellBasis;
  if (match) [status, basis] = ["not_applicable", "exception"];
  else if (done) [status, basis] = ["done", sourceDone ? "source_report" : "explicit_report"];
  else if (present) [status, basis] = ["not_done", "explicit_report"];
  else if (closed) [status, basis] = ["not_done", "missing_after_close"];
  else [status, basis] = ["unreported", "open_day"];
  return Result.succeed({
    status,
    basis,
    raw: present ? raw : null,
    applicable: match === undefined,
    included_in_completion: closed && match === undefined,
    exception_id: match ? match.id : null,
  });
};

export interface Completion {
  readonly done: number;
  readonly applicable: number;
  readonly percentage: number | null;
}

export const completion = (cells: ReadonlyArray<Cell>): Completion => {
  const eligible = cells.filter((cell) => cell.included_in_completion);
  const done = eligible.filter((cell) => cell.status === "done").length;
  return { done, applicable: eligible.length, percentage: eligible.length > 0 ? (100 * done) / eligible.length : null };
};

/** An instant given as microseconds or as an offset-bearing ISO string (Z accepted). */
export const asInstant = (value: Micros | string): Result.Result<Micros, RequiresReview> => {
  if (typeof value === "number") return Result.succeed(value);
  const parsed = parseDateTime(value.replace("Z", "+00:00"));
  if (Result.isFailure(parsed)) return Result.fail(reject(parsed.failure));
  if (parsed.success.offsetSeconds === null) return Result.fail(reject("as_of must be an instant with an offset"));
  return Result.succeed(parsed.success.micros);
};

export const closesAt = (day: string): string => {
  const noon = fromMelbourne(addDays(day, 1), 12);
  return isoformat(noon.micros, noon.offsetSeconds);
};

export interface Period {
  readonly as_of: string;
  readonly timezone: string;
  readonly cutoff: string;
  readonly active_date: string;
  readonly closed_through: string;
  readonly active_closes_at: string;
}

export const period = (value: Micros | string): Result.Result<Period, RequiresReview> =>
  Result.map(asInstant(value), (stamp) => {
    const local = melbourneParts(stamp);
    const active = addDays(local.date, local.hour < 12 ? -1 : 0);
    return {
      as_of: isoformatUtc(stamp),
      timezone: TIMEZONE,
      cutoff: "12:00 next day",
      active_date: active,
      closed_through: addDays(active, -1),
      active_closes_at: closesAt(active),
    };
  });

export interface RitualLike {
  readonly date: string;
  readonly [field: string]: unknown;
}

export interface StatusRow {
  readonly date: string;
  readonly has_ritual: boolean;
  readonly has_activity: boolean;
  readonly period: "closed" | "open" | "upcoming";
  readonly closes_at: string;
  readonly habits: Record<Habit, Cell>;
}

export interface StatusReport extends Period {
  readonly coverage: { readonly from: string; readonly to: string } | null;
  readonly records: ReadonlyArray<StatusRow>;
  readonly count: number;
  readonly active_period: StatusRow;
  readonly completion: Completion;
  readonly by_habit: Record<Habit, Completion>;
}

/** Derive a requested logical day without creating an observation or changing coverage. */
export const dailyStatus = (
  day: string,
  original: RitualLike | undefined,
  hasActivity: boolean,
  exceptions: ReadonlyArray<ExceptionRow>,
  context: Period,
): Result.Result<StatusRow, ApplicabilityConflict | RequiresReview> => {
  const habits = {} as Record<Habit, Cell>;
  for (const habit of HABITS) {
    const cell = derive(
      habit,
      day,
      original?.[habit === "planks" ? "plank_seconds" : habit],
      exceptions,
      context.closed_through,
    );
    if (Result.isFailure(cell)) return Result.fail(cell.failure);
    habits[habit] = cell.success;
  }
  return Result.succeed({
    date: day,
    has_ritual: original !== undefined,
    has_activity: hasActivity,
    period: day <= context.closed_through ? "closed" : day === context.active_date ? "open" : "upcoming",
    closes_at: closesAt(day),
    habits,
  });
};

export const statusReport = (
  rituals: ReadonlyArray<RitualLike>,
  workouts: ReadonlyArray<{ readonly date: string }>,
  exceptions: ReadonlyArray<ExceptionRow>,
  asOf: Micros | string,
  start?: string | null,
  end?: string | null,
): Result.Result<StatusReport, ApplicabilityConflict | RequiresReview> => {
  const contextResult = period(asOf);
  if (Result.isFailure(contextResult)) return Result.fail(contextResult.failure);
  const context = contextResult.success;
  const raw = new Map(rituals.map((r) => [r.date, r] as const));
  const activityDates = new Set(workouts.map((w) => w.date));
  const known = [...new Set([...raw.keys(), ...activityDates])].toSorted();
  const row = (day: string) => dailyStatus(day, raw.get(day), activityDates.has(day), exceptions, context);
  const records: Array<StatusRow> = [];
  if (known.length > 0) {
    const firstKnown = known[0] as string;
    const lastKnown = known[known.length - 1] as string;
    const first = [firstKnown, start ?? firstKnown].toSorted()[1] as string;
    const last = [lastKnown, end ?? lastKnown].toSorted()[0] as string;
    for (let day = first; day <= last; day = addDays(day, 1)) {
      const built = row(day);
      if (Result.isFailure(built)) return Result.fail(built.failure);
      records.push(built.success);
    }
  }
  const active = row(context.active_date);
  if (Result.isFailure(active)) return Result.fail(active.failure);
  const byHabit = {} as Record<Habit, Completion>;
  for (const habit of HABITS) byHabit[habit] = completion(records.map((r) => r.habits[habit]));
  return Result.succeed({
    ...context,
    coverage: known.length > 0 ? { from: known[0] as string, to: known[known.length - 1] as string } : null,
    records,
    count: records.length,
    active_period: active.success,
    completion: completion(records.flatMap((r) => Object.values(r.habits))),
    by_habit: byHabit,
  });
};
