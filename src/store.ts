// Private SQLite store behind bin/ritualctl. No listener, credentials or network calls.
//
// The schema, validation rules, idempotency guard, revision guard, audit rows, backups, import,
// export, restore and the reviewed migration are exactly those of the Python store; the same
// database file carries over untouched. Everything here returns Effects; the SQLite connection is
// an @effect/sql-sqlite-node client opened for the store's lifetime (a Scope).
import { Context, Effect, FileSystem, Layer, Result, Schema, type Scope } from "effect";
import type { PlatformError } from "effect/PlatformError";
import type { SqlError } from "effect/sql/SqlError";
import * as Reactivity from "effect/reactivity/Reactivity";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  applies,
  dailyStatus,
  type ExceptionRow,
  isHabit,
  period as ritualPeriod,
  statusReport,
  TABLE_SQL,
  validateException,
} from "./applicability.ts";
import {
  ATTACHMENT_SQL,
  AttachmentRole,
  attachmentApplies,
  attachmentViews,
  checkId,
  fullCompletion,
  type Attachment,
  type AttachmentCheck,
} from "./attachments.ts";
import { dumps, isRecord, pack, sameJson, sha } from "./encoding.ts";
import { type ApplicabilityConflict, reject, RequiresReview } from "./errors.ts";
import {
  compactStamp,
  dateToDays,
  instantZ,
  nowMicros,
  parseDate,
  parseDateTime,
  stampZ,
  TIMEZONE,
  weekStart as mondayOf,
} from "./instants.ts";

export const SCHEMA = `
CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE rituals(
 date TEXT PRIMARY KEY,
 checkins TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(checkins)),
 magnesium INTEGER CHECK(magnesium IN (0,1)),
 protein INTEGER CHECK(protein IN (0,1)),
 stretching INTEGER CHECK(stretching IN (0,1)),
 journalling INTEGER CHECK(journalling IN (0,1)),
 plank_seconds INTEGER CHECK(plank_seconds >= 0),
 notes TEXT
);
CREATE TABLE workouts(id TEXT PRIMARY KEY, date TEXT NOT NULL, type TEXT NOT NULL, details TEXT NOT NULL);
CREATE INDEX idx_workouts_date ON workouts(date);
CREATE INDEX idx_workouts_type_date ON workouts(type,date);
CREATE TABLE reminders(id TEXT PRIMARY KEY, text TEXT NOT NULL, due_at TEXT, status TEXT NOT NULL CHECK(status IN ('pending','delivered','done','cancelled')));
CREATE INDEX idx_reminders_status_due ON reminders(status,due_at);
CREATE TABLE source_documents(id TEXT PRIMARY KEY, path TEXT NOT NULL, sha256 TEXT NOT NULL, content TEXT NOT NULL);
CREATE TABLE legacy_checkpoints(id TEXT PRIMARY KEY, date TEXT NOT NULL, checkpoint TEXT NOT NULL CHECK(checkpoint IN ('midday','evening')), source_id TEXT NOT NULL REFERENCES source_documents(id), text TEXT NOT NULL);
CREATE INDEX idx_legacy_checkpoints_date ON legacy_checkpoints(date);
CREATE TABLE imports(id TEXT PRIMARY KEY, imported_at TEXT NOT NULL, manifest TEXT NOT NULL);
CREATE TABLE changes(id INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL, recorded_at TEXT NOT NULL, action TEXT NOT NULL, entity TEXT NOT NULL, entity_id TEXT NOT NULL, before_json TEXT, after_json TEXT, source_text TEXT NOT NULL, reason TEXT, response_json TEXT NOT NULL);
CREATE INDEX idx_changes_entity ON changes(entity,entity_id,id);
`;
// Version 3: weekly review answers get their own table (one row per Monday-to-Sunday week).
export const WEEKLY_SQL = `CREATE TABLE weekly_reviews(
 week_start TEXT PRIMARY KEY CHECK(date(week_start) IS week_start AND strftime('%w',week_start)='1'),
 answer TEXT NOT NULL CHECK(length(trim(answer))>0)
);`;
export const SCHEMA_VERSION = 4;
const VERSION_1_TABLES = [
  "rituals",
  "workouts",
  "reminders",
  "source_documents",
  "legacy_checkpoints",
  "imports",
  "changes",
];
export const TABLES_BY_VERSION: Record<number, ReadonlyArray<string>> = {
  1: VERSION_1_TABLES,
  2: [...VERSION_1_TABLES, "applicability_exceptions"],
  3: [...VERSION_1_TABLES, "applicability_exceptions", "weekly_reviews"],
  4: [
    ...VERSION_1_TABLES,
    "applicability_exceptions",
    "weekly_reviews",
    "ritual_attachments",
    "ritual_attachment_checks",
  ],
};
export const TABLES = TABLES_BY_VERSION[SCHEMA_VERSION] as ReadonlyArray<string>;
export const BOOLS = ["magnesium", "protein", "stretching", "journalling"] as const;
export const FIELDS: Record<string, ReadonlyArray<string>> = {
  rituals: ["date", "checkins", ...BOOLS, "plank_seconds", "notes"],
  workouts: ["id", "date", "type", "details"],
  reminders: ["id", "text", "due_at", "status"],
  applicability_exceptions: ["id", "habit", "start_date", "end_date", "reason"],
  weekly_reviews: ["week_start", "answer"],
  ritual_attachments: ["id", "ritual", "text", "start_date", "end_date", "role"],
  ritual_attachment_checks: ["id", "attachment_id", "date", "done"],
};
const KEYS: Record<string, string> = { rituals: "date", weekly_reviews: "week_start" };
export const WRITES: ReadonlySet<string> = new Set([
  "ritual_put",
  "workout_add",
  "reminder_add",
  "correct",
  "reminder_mark",
  "exception_add",
  "weekly_put",
  "attachment_add",
  "attachment_check",
]);
const WEEKLY_NOTE = /^Weekly:\s*(\S.*?)\s*$/;
const MIGRATION_REQUIRED = (version: number) =>
  `Schema version ${version} needs the reviewed migration: back up, then run bin/ritualctl --migrate (HANDOFF.md)`;
const REMINDER_STATUSES = ["pending", "delivered", "done", "cancelled"];
const ENTITY_OF_ADD: Record<string, string> = {
  workout_add: "workouts",
  reminder_add: "reminders",
  exception_add: "applicability_exceptions",
  attachment_add: "ritual_attachments",
};
const ID_PREFIX: Record<string, string> = {
  workouts: "w_",
  reminders: "r_",
  applicability_exceptions: "ae_",
  ritual_attachments: "ra_",
};
const REQUIRED: Record<string, ReadonlyArray<string>> = {
  rituals: ["date", "checkins"],
  workouts: ["id", "date", "type", "details"],
  reminders: ["id", "text", "due_at", "status"],
  applicability_exceptions: FIELDS.applicability_exceptions as ReadonlyArray<string>,
  weekly_reviews: FIELDS.weekly_reviews as ReadonlyArray<string>,
  ritual_attachments: FIELDS.ritual_attachments as ReadonlyArray<string>,
  ritual_attachment_checks: FIELDS.ritual_attachment_checks as ReadonlyArray<string>,
};

export type Row = Record<string, unknown>;
export type StoreError = RequiresReview | ApplicabilityConflict | SqlError | PlatformError;

export const keyOf = (entity: string): string => KEYS[entity] ?? "id";

const isEntity = (value: unknown): value is string => typeof value === "string" && Object.hasOwn(FIELDS, value);

const codePointLength = (value: string): number => Array.from(value).length;

/** Python `text(x, name, limit, empty)`: a string within the limit, non-blank unless empty is allowed. */
export const text = (
  value: unknown,
  name: string,
  limit = 20000,
  empty = false,
): Effect.Effect<string, RequiresReview> =>
  typeof value !== "string" || codePointLength(value) > limit || (!empty && value.trim() === "")
    ? Effect.fail(reject(`${name} must be a non-empty string of at most ${limit} characters`))
    : Effect.succeed(value);

export const date = (value: unknown): Effect.Effect<string, RequiresReview> => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return Effect.fail(reject("Use a Melbourne calendar date YYYY-MM-DD"));
  }
  const parsed = parseDate(value);
  return Result.isFailure(parsed) ? Effect.fail(reject(parsed.failure)) : Effect.succeed(value);
};

/** An offset-bearing timestamp, normalised to whole UTC seconds with a Z suffix. */
export const instant = (value: unknown): Effect.Effect<string, RequiresReview> =>
  Effect.gen(function* () {
    const raw = yield* text(value, "timestamp", 50);
    const parsed = parseDateTime(raw.replace("Z", "+00:00"));
    if (Result.isFailure(parsed)) return yield* Effect.fail(reject(parsed.failure));
    if (parsed.success.offsetSeconds === null) {
      return yield* Effect.fail(reject("Timestamp must include UTC offset; resolve local timing before saving"));
    }
    return instantZ(parsed.success.micros);
  });

const isBoolField = (key: string): key is (typeof BOOLS)[number] => (BOOLS as ReadonlyArray<string>).includes(key);

export const validated = (entity: string, row: unknown, complete = false): Effect.Effect<Row, RequiresReview> =>
  Effect.gen(function* () {
    const fields = FIELDS[entity] as ReadonlyArray<string>;
    if (!isRecord(row) || Object.keys(row).some((k) => !fields.includes(k))) {
      return yield* Effect.fail(reject("Unknown record fields; add an explicit migration when a new column is needed"));
    }
    const out: Row = { ...row };
    for (const [k, v] of Object.entries(row)) {
      if (k === "date") out[k] = yield* date(v);
      else if (k === "id") out[k] = yield* text(v, "id", 180);
      else if (k === "attachment_id") out[k] = yield* text(v, k, 180);
      else if (k === "ritual") out[k] = yield* text(v, k, 120);
      else if (k === "role") {
        const role = Schema.decodeUnknownResult(AttachmentRole)(v);
        if (Result.isFailure(role)) return yield* Effect.fail(reject("role must be required_check or reminder_only"));
        out[k] = role.success;
      } else if (k === "done") {
        if (v !== null && typeof v !== "boolean")
          return yield* Effect.fail(reject("done must be true, false, or null"));
      } else if (isBoolField(k)) {
        if (v !== null && typeof v !== "boolean")
          return yield* Effect.fail(reject(`${k} must be true, false, or null`));
      } else if (k === "checkins") {
        if (!Array.isArray(v) || v.length > 200)
          return yield* Effect.fail(reject("checkins must be a timestamp array"));
        const instants = yield* Effect.forEach(v, instant);
        out[k] = [...new Set(instants)].toSorted();
      } else if (k === "plank_seconds") {
        if (v !== null && (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 86400)) {
          return yield* Effect.fail(reject("plank_seconds must be a nonnegative integer or null"));
        }
      } else if (k === "notes" || k === "details") {
        if (v !== null) yield* text(v, k, 30000, true);
        if (k === "details" && v === null) return yield* Effect.fail(reject("details must be text"));
      } else if (k === "type") out[k] = (yield* text(v, k, 120)).trim();
      else if (k === "text") out[k] = yield* text(v, k, 10000);
      else if (k === "due_at") out[k] = v === null ? null : yield* instant(v);
      else if (k === "status") {
        if (!REMINDER_STATUSES.includes(v as string)) return yield* Effect.fail(reject("Unknown reminder status"));
      } else if (k === "habit") {
        if (!isHabit(v)) return yield* Effect.fail(reject("Unknown habit"));
      } else if (k === "start_date" || k === "end_date") {
        out[k] = v === null && (k === "start_date" || entity === "ritual_attachments") ? null : yield* date(v);
      } else if (k === "reason") out[k] = yield* text(v, "reason", 2000);
      else if (k === "week_start") {
        const day = yield* date(v);
        if (day !== mondayOf(day)) {
          return yield* Effect.fail(
            reject("week_start must be the Monday that starts the Monday-to-Sunday week being reviewed"),
          );
        }
      } else if (k === "answer") out[k] = yield* text(v, "answer", 30000);
    }
    if (complete) {
      const required = REQUIRED[entity] as ReadonlyArray<string>;
      if (!required.every((k) => k in out)) return yield* Effect.fail(reject("Required record fields are missing"));
      if (entity === "applicability_exceptions") yield* Effect.fromResult(validateException(out, []));
      if (
        entity === "ritual_attachments" &&
        (out.start_date === null || (out.end_date !== null && (out.start_date as string) > (out.end_date as string)))
      )
        return yield* Effect.fail(reject("Attachment date range must have an inclusive start and a valid end"));
      if (entity === "ritual_attachment_checks" && out.id !== checkId(out.attachment_id as string, out.date as string))
        return yield* Effect.fail(reject("Attachment check identity must match attachment and logical date"));
    }
    return out;
  });

const dbValue = (value: unknown): unknown =>
  typeof value === "object" && value !== null ? pack(value) : typeof value === "boolean" ? (value ? 1 : 0) : value;

export const decode = (entity: string, row: Row | null | undefined): Row | null => {
  if (row === null || row === undefined) return null;
  const obj: Row = { ...row };
  if (entity === "rituals") {
    obj.checkins = JSON.parse(obj.checkins as string);
    for (const k of BOOLS) obj[k] = obj[k] === null ? null : Boolean(obj[k]);
  }
  if (entity === "ritual_attachment_checks") obj.done = obj.done === null ? null : Boolean(obj.done);
  return obj;
};

const statements = (script: string): Array<string> =>
  script
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

const randomSuffix = Effect.sync(() => randomUUID().replace(/-/g, "").slice(0, 8));

/** A previously acknowledged request is answered again only when its content is byte-identical. */
const replayedResponse = (old: { request_hash: string; response_json: string }, requestHash: string) =>
  old.request_hash !== requestHash
    ? Effect.fail(reject("request_id already used for different content"))
    : Effect.succeed({ ...(JSON.parse(old.response_json) as Row), replayed: true });

const dateRange = (req: Row) =>
  Effect.gen(function* () {
    const start = yield* date(req.from);
    const end = yield* date(req.to);
    if (start > end || dateToDays(end) - dateToDays(start) > 3660) {
      return yield* Effect.fail(reject("Invalid or excessive date range"));
    }
    return [start, end] as const;
  });

export interface MigrateResult {
  readonly migrated: boolean;
  readonly from_version?: number;
  readonly schema_version: number;
  readonly backup?: string;
  readonly backup_sha256?: string;
  readonly moved_weekly_answers?: ReadonlyArray<{ date: string; week_start: string; lines: number }>;
}

export interface StoreShape {
  readonly directory: string;
  readonly path: string;
  readonly sql: SqliteClient.SqliteClient;
  readonly frozen: () => boolean;
  readonly schemaVersion: () => number;
  readonly migrationRequired: () => boolean;
  readonly tableNames: () => ReadonlyArray<string>;
  readonly request: (request: unknown) => Effect.Effect<unknown, StoreError>;
  readonly migrate: Effect.Effect<MigrateResult, StoreError>;
  readonly backup: Effect.Effect<string, StoreError>;
  readonly counts: Effect.Effect<Record<string, number>, StoreError>;
  readonly get: (entity: string, key: string) => Effect.Effect<Row | null, StoreError>;
  readonly revision: (entity: string, key: string) => Effect.Effect<number, StoreError>;
  readonly exceptions: Effect.Effect<Array<ExceptionRow>, StoreError>;
}

export const openStore = (
  directory: string,
): Effect.Effect<StoreShape, StoreError, Scope.Scope | FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, "ritual.sqlite3");
    const frozenMarker = join(directory, "FROZEN_BACKUP.json");
    const state = {
      frozen: yield* fs.exists(frozenMarker),
      schemaVersion: 0,
      migrationRequired: false,
      tableNames: [] as ReadonlyArray<string>,
    };
    const sql = yield* SqliteClient.make({
      filename: state.frozen ? `file:${path}?mode=ro` : path,
      readonly: state.frozen,
      disableWAL: true,
      busyTimeout: "30 seconds",
    }).pipe(Effect.provide(Reactivity.layer));
    yield* sql.unsafe("PRAGMA foreign_keys=ON");
    if (!state.frozen) yield* fs.chmod(path, 0o600);

    const versions = sql<{ version: number }>`SELECT version FROM schema_migrations ORDER BY version`.pipe(
      Effect.map((rows) => rows.map((r) => r.version)),
    );
    const runScript = (script: string) =>
      Effect.forEach(statements(script), (statement) => sql.unsafe(statement), { discard: true });

    const backup: Effect.Effect<string, StoreError> = Effect.gen(function* () {
      const folder = join(directory, "backups");
      yield* fs.makeDirectory(folder, { recursive: true, mode: 0o700 });
      const target = join(folder, `ritual-${compactStamp(yield* nowMicros)}-${yield* randomSuffix}.sqlite3`);
      yield* sql.backup(target);
      yield* fs.chmod(target, 0o600);
      return target;
    });

    const existing = yield* sql<{ x: number }>`SELECT 1 AS x FROM sqlite_schema WHERE name='schema_migrations'`;
    if (existing.length === 0) {
      // A new store starts at the current schema; there is nothing to back up or move.
      const stamp = stampZ(yield* nowMicros);
      const inserts = Object.keys(TABLES_BY_VERSION)
        .map((v) => `\nINSERT INTO schema_migrations VALUES(${v},'${stamp}');`)
        .join("");
      yield* sql.withTransaction(runScript(SCHEMA + TABLE_SQL + WEEKLY_SQL + ATTACHMENT_SQL + inserts));
    }
    let found = yield* versions;
    if (found.length === 1 && found[0] === 1 && !state.frozen) {
      yield* backup;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const second = yield* sql`SELECT 1 AS x FROM schema_migrations WHERE version=2`;
          if (second.length === 0) {
            yield* runScript(TABLE_SQL);
            yield* sql`INSERT INTO schema_migrations VALUES(2,${stampZ(yield* nowMicros)})`;
          }
        }),
      );
      found = yield* versions;
    }
    if (!["1", "1,2", "1,2,3", "1,2,3,4"].includes(found.join(","))) {
      return yield* Effect.fail(reject("Unsupported schema version; explicit migration required"));
    }
    state.schemaVersion = found[found.length - 1] as number;
    state.tableNames = TABLES_BY_VERSION[state.schemaVersion] as ReadonlyArray<string>;
    // Version 3 moves data, so it never runs implicitly: until --migrate, only status, backup and export work.
    state.migrationRequired = state.schemaVersion < SCHEMA_VERSION && !state.frozen;

    const get = (entity: string, key: string): Effect.Effect<Row | null, StoreError> =>
      sql
        .unsafe<Row>(`SELECT * FROM ${entity} WHERE ${keyOf(entity)}=?`, [key])
        .pipe(Effect.map((rows) => decode(entity, rows[0])));

    const revision = (entity: string, key: string): Effect.Effect<number, StoreError> =>
      sql<{ r: number }>`SELECT COALESCE(MAX(id),0) AS r FROM changes WHERE entity=${entity} AND entity_id=${key}`.pipe(
        Effect.map((rows) => (rows[0] as { r: number }).r),
      );

    const save = (entity: string, row: Row, replacing = false) => {
      const fields = Object.keys(row);
      const verb = replacing ? "INSERT OR REPLACE" : "INSERT";
      return sql.unsafe(
        `${verb} INTO ${entity} (${fields.join(",")}) VALUES (${fields.map(() => "?").join(",")})`,
        fields.map((k) => dbValue(row[k])),
      );
    };

    const counts: Effect.Effect<Record<string, number>, StoreError> = Effect.gen(function* () {
      const result: Record<string, number> = {};
      for (const table of state.tableNames) {
        const rows = yield* sql.unsafe<{ c: number }>(`SELECT COUNT(*) AS c FROM ${table}`);
        result[table] = (rows[0] as { c: number }).c;
      }
      return result;
    });

    const recordChange = (
      requestId: string,
      requestHash: string,
      action: string,
      entity: string,
      key: string,
      before: Row | null,
      after: Row,
      source: string,
      reason: string | null,
      extra?: Row,
    ) =>
      Effect.gen(function* () {
        const stamp = stampZ(yield* nowMicros);
        const inserted =
          (yield* sql`INSERT INTO changes(request_id,request_hash,recorded_at,action,entity,entity_id,before_json,after_json,source_text,reason,response_json) VALUES(${requestId},${requestHash},${stamp},${action},${entity},${key},${before === null ? null : pack(before)},${pack(after)},${source},${reason},${"{}"})`
            .raw) as { lastInsertRowid: number | bigint };
        const id = Number(inserted.lastInsertRowid);
        const response: Row = { record: after, revision: id, recorded_at: stamp, ...extra };
        yield* sql`UPDATE changes SET response_json=${pack(response)} WHERE id=${id}`;
        return response;
      });

    const exceptions: Effect.Effect<Array<ExceptionRow>, StoreError> = state.schemaVersion < 2
      ? Effect.succeed([])
      : sql<ExceptionRow>`SELECT * FROM applicability_exceptions ORDER BY habit,start_date,id`.pipe(
          Effect.map((rows) => rows.map((r) => ({ ...r }))),
        );

    const checkApplicability = (entity: string, row: Row): Effect.Effect<void, StoreError> =>
      Effect.gen(function* () {
        if (entity === "ritual_attachment_checks") {
          const item = yield* get("ritual_attachments", row.attachment_id as string);
          if (!item || !attachmentApplies(item as unknown as Attachment, item.ritual as string, row.date as string))
            return yield* Effect.fail(reject("Attachment does not apply to that logical date"));
          if (item.role !== "required_check")
            return yield* Effect.fail(reject("Reminder-only attachment has no tick or required response"));
        } else if (entity === "applicability_exceptions") {
          const others = (yield* exceptions).filter((r) => r.id !== row.id);
          yield* Effect.fromResult(validateException(row, others as unknown as Array<Row>));
          const habit = row.habit as string;
          const field = habit === "planks" ? "plank_seconds" : habit;
          const start = (row.start_date as string | null) ?? "0001-01-01";
          const end = row.end_date as string;
          const positive = yield* sql.unsafe<{ date: string }>(
            `SELECT date FROM rituals WHERE date>=? AND date<=? AND ${field}>0 LIMIT 1`,
            [start, end],
          );
          if (positive.length > 0) {
            return yield* Effect.fail(
              reject(
                `Positive report on ${(positive[0] as { date: string }).date} conflicts with applicability exception; resolve explicitly`,
              ),
            );
          }
          if (habit === "planks") {
            const checkpoints = yield* sql<{
              date: string;
              text: string;
            }>`SELECT date,text FROM legacy_checkpoints WHERE checkpoint='evening' AND date>=${start} AND date<=${end}`;
            for (const checkpoint of checkpoints) {
              if (/\bplanks\s+(?:yes|✓)/i.test(checkpoint.text)) {
                return yield* Effect.fail(
                  reject(
                    `Positive source plank report on ${checkpoint.date} conflicts with applicability exception; resolve explicitly`,
                  ),
                );
              }
            }
          }
        } else if (entity === "rituals") {
          for (const exception of yield* exceptions) {
            const field = exception.habit === "planks" ? "plank_seconds" : exception.habit;
            const value = row[field];
            if (
              value !== null &&
              value !== undefined &&
              Number(value) > 0 &&
              applies(exception, exception.habit, row.date as string)
            ) {
              return yield* Effect.fail(
                reject(
                  "Positive report conflicts with applicability exception; correct the exception explicitly first",
                ),
              );
            }
          }
        }
      });

    const moveWeeklyNotes = (requestPrefix: string, cause: string) =>
      Effect.gen(function* () {
        // Move whole "Weekly: ..." note lines into weekly_reviews, keyed by the Monday of the ritual date's week.
        // Runs inside the caller's transaction. The original words and their provenance stay in the earlier
        // rituals changes; each move is itself audited on both entities.
        const byWeek = new Map<string, Array<[string, Array<string>]>>();
        const moved: Array<{ date: string; week_start: string; lines: number }> = [];
        const rows = yield* sql<Row>`SELECT * FROM rituals WHERE notes LIKE '%Weekly:%' ORDER BY date`;
        for (const row of rows) {
          const before = decode("rituals", row) as Row;
          const lines = (before.notes as string).split("\n");
          const answers = lines
            .map((line) => WEEKLY_NOTE.exec(line))
            .filter((m) => m !== null)
            .map((m) => m[1] as string);
          if (answers.length === 0) continue;
          const week = mondayOf(before.date as string);
          const kept = lines.filter((line) => !WEEKLY_NOTE.test(line)).join("\n");
          const after: Row = { ...before, notes: kept.length > 0 ? kept : null };
          yield* save("rituals", after, true);
          const source = `${cause} moved the weekly answer stored as a 'Weekly:' line in the notes of ritual date ${before.date} into weekly_reviews ${week}. Original words and provenance remain in the earlier changes for rituals ${before.date}.`;
          yield* recordChange(
            `${requestPrefix}:rituals:${before.date}`,
            sha(pack(after)),
            "migrate",
            "rituals",
            before.date as string,
            before,
            after,
            source,
            "Weekly answers have their own record",
          );
          const entries = byWeek.get(week) ?? [];
          entries.push([before.date as string, answers]);
          byWeek.set(week, entries);
          moved.push({ date: before.date as string, week_start: week, lines: answers.length });
        }
        for (const [week, entries] of byWeek) {
          const before = yield* get("weekly_reviews", week);
          const joined = entries.flatMap(([, answers]) => answers).join("\n");
          const after = yield* validated(
            "weekly_reviews",
            { week_start: week, answer: before ? `${before.answer as string}\n${joined}` : joined },
            true,
          );
          yield* save("weekly_reviews", after, before !== null);
          const dates = entries.map(([day]) => day).join(", ");
          const source = `${cause} moved this weekly answer out of the notes of ritual date ${dates}. Original words and provenance remain in the earlier changes for rituals ${dates}.`;
          yield* recordChange(
            `${requestPrefix}:weekly_reviews:${week}`,
            sha(pack(after)),
            "migrate",
            "weekly_reviews",
            week,
            before,
            after,
            source,
            "Weekly answers have their own record",
          );
        }
        return moved;
      });

    const migrate: Effect.Effect<MigrateResult, StoreError> = Effect.gen(function* () {
      // Explicit, reviewed upgrade to the current schema; backs up first, idempotent once applied.
      if (state.frozen)
        return yield* Effect.fail(reject("Frozen backup copy: migrate the authoritative store, never this copy."));
      if (state.schemaVersion === SCHEMA_VERSION) return { migrated: false, schema_version: state.schemaVersion };
      const backupPath = yield* backup;
      const moved = yield* sql.withTransaction(
        Effect.gen(function* () {
          if ((yield* versions).at(-1) !== state.schemaVersion) {
            return yield* Effect.fail(reject("Schema changed during migration; reopen and retry"));
          }
          let result: Array<{ date: string; week_start: string; lines: number }> = [];
          if (state.schemaVersion < 3) {
            yield* runScript(WEEKLY_SQL);
            result = yield* moveWeeklyNotes("migration:3", "Schema migration 3");
            yield* sql`INSERT INTO schema_migrations VALUES(3,${stampZ(yield* nowMicros)})`;
          }
          yield* runScript(ATTACHMENT_SQL);
          yield* sql`INSERT INTO schema_migrations VALUES(4,${stampZ(yield* nowMicros)})`;
          return result;
        }),
      );
      const previous = state.schemaVersion;
      state.schemaVersion = SCHEMA_VERSION;
      state.tableNames = TABLES;
      state.migrationRequired = false;
      return {
        migrated: true,
        from_version: previous,
        schema_version: state.schemaVersion,
        backup: backupPath,
        backup_sha256: sha(yield* fs.readFile(backupPath)),
        moved_weekly_answers: moved,
      };
    });

    const existingChange = (requestId: string) =>
      sql<{
        request_hash: string;
        response_json: string;
      }>`SELECT request_hash,response_json FROM changes WHERE request_id=${requestId}`.pipe(
        Effect.map((rows) => rows[0] ?? null),
      );

    const attachmentRecords = Effect.gen(function* () {
      if (state.schemaVersion < 4) return { items: [] as Array<Attachment>, checks: [] as Array<AttachmentCheck> };
      const items = (yield* sql<Attachment>`SELECT * FROM ritual_attachments ORDER BY ritual,start_date,id`).map(
        (r) => ({ ...r }),
      );
      const checks: Array<AttachmentCheck> = [];
      for (const row of yield* sql<Row>`SELECT * FROM ritual_attachment_checks ORDER BY date,id`) {
        const decoded = decode("ritual_attachment_checks", row) as unknown as AttachmentCheck;
        checks.push({ ...decoded, revision: yield* revision("ritual_attachment_checks", decoded.id) });
      }
      return { items, checks };
    });

    const mutate = (req: Row): Effect.Effect<unknown, StoreError> =>
      Effect.gen(function* () {
        const requestId = yield* text(req.request_id, "request_id", 180);
        const source = yield* text(req.source_text, "source_text", 30000);
        const requestHash = sha(pack(req));
        const old = yield* existingChange(requestId);
        if (old) return yield* replayedResponse(old, requestHash);
        const backupPath = yield* backup;
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            // Recheck after obtaining the write lock to make concurrent retries safe.
            const again = yield* existingChange(requestId);
            if (again) return yield* replayedResponse(again, requestHash);
            const op = req.op as string;
            let reason: string | null = null;
            let entity: string;
            let key: string;
            let before: Row | null;
            let after: Row;
            if (op === "ritual_put") {
              entity = "rituals";
              key = yield* date(req.date);
              before = yield* get(entity, key);
              const patch = yield* validated(entity, req.patch);
              const journalEntryAt = "journal_entry_at" in req ? yield* instant(req.journal_entry_at) : null;
              if ((Object.keys(patch).length === 0 && journalEntryAt === null) || "date" in patch) {
                return yield* Effect.fail(
                  reject("Patch must contain reported fields or journal_entry_at, without date"),
                );
              }
              after = before
                ? { ...before }
                : {
                    date: key,
                    checkins: [],
                    magnesium: null,
                    protein: null,
                    stretching: null,
                    journalling: null,
                    plank_seconds: null,
                    notes: null,
                  };
              for (const [k, v] of Object.entries(patch)) {
                if (k === "checkins")
                  after[k] = [...new Set([...(after[k] as Array<string>), ...(v as Array<string>)])].toSorted();
                else if (k === "notes" && v) after[k] = [after[k], v].filter((part) => Boolean(part)).join("\n");
                else if (before && after[k] !== null && after[k] !== undefined && after[k] !== v) {
                  return yield* Effect.fail(
                    reject("Changing a recorded value requires correct with expected_revision and reason"),
                  );
                } else after[k] = v;
              }
              // The caller supplies an authorized journal's original timestamp. Decide under the write lock so a
              // default cannot replace a check-in saved by another agent or an explicit patch.
              if (journalEntryAt !== null && (after.checkins as Array<string>).length === 0)
                after.checkins = [journalEntryAt];
            } else if (op === "attachment_check") {
              entity = "ritual_attachment_checks";
              const attachmentId = yield* text(req.attachment_id, "attachment_id", 180);
              const day = yield* date(req.date);
              key = checkId(attachmentId, day);
              before = yield* get(entity, key);
              after = yield* validated(
                entity,
                { id: key, attachment_id: attachmentId, date: day, done: req.done },
                true,
              );
              if (before && before.done !== null && before.done !== after.done)
                return yield* Effect.fail(
                  reject("Changing a recorded check requires correct with expected_revision and reason"),
                );
            } else if (op === "weekly_put") {
              // Like notes, a further answer for the same week is appended; changing earlier words needs correct.
              entity = "weekly_reviews";
              const row = yield* validated(entity, { week_start: req.week_start, answer: req.answer }, true);
              key = row.week_start as string;
              before = yield* get(entity, key);
              after = before ? { ...before, answer: `${before.answer as string}\n${row.answer as string}` } : row;
            } else if (op in ENTITY_OF_ADD) {
              entity = ENTITY_OF_ADD[op] as string;
              const record = req.record ?? {};
              if (!isRecord(record)) {
                return yield* Effect.fail(
                  reject("Unknown record fields; add an explicit migration when a new column is needed"),
                );
              }
              const values: Row = { ...record };
              if (!("id" in values)) values.id = ID_PREFIX[entity] + sha(requestId).slice(0, 24);
              if (entity === "reminders") {
                if (!("due_at" in values)) values.due_at = null;
                if (!("status" in values)) values.status = "pending";
              }
              after = yield* validated(entity, values, true);
              key = after.id as string;
              before = yield* get(entity, key);
              if (before) return yield* Effect.fail(reject("Record already exists; use correct instead"));
            } else {
              const target = op === "reminder_mark" ? "reminders" : req.entity;
              if (!isEntity(target)) return yield* Effect.fail(reject("Unknown entity"));
              entity = target;
              key = yield* text(req.id, "id", 180);
              before = yield* get(entity, key);
              if (!before) return yield* Effect.fail(reject("Record not found"));
              const expected = req.expected_revision;
              if (!Number.isInteger(expected) || expected !== (yield* revision(entity, key))) {
                return yield* Effect.fail(reject("Revision conflict; read current record before changing it"));
              }
              reason = yield* text(req.reason, "reason", 2000);
              const patch = yield* validated(entity, op === "reminder_mark" ? { status: req.status } : req.patch);
              if (Object.keys(patch).length === 0 || keyOf(entity) in patch) {
                return yield* Effect.fail(reject("Cannot change record identity; correct fields only"));
              }
              if (entity === "ritual_attachments") {
                if (Object.keys(patch).some((k) => k !== "text" && k !== "end_date"))
                  return yield* Effect.fail(
                    reject(
                      "Attachment ritual, start and role preserve historical scope; create a new attachment for a new scope",
                    ),
                  );
                if ("end_date" in patch && patch.end_date !== before.end_date) {
                  const today = (yield* Effect.fromResult(ritualPeriod(stampZ(yield* nowMicros)))).active_date;
                  if (
                    (before.end_date !== null && (before.end_date as string) < today) ||
                    (patch.end_date !== null && (patch.end_date as string) < today)
                  )
                    return yield* Effect.fail(
                      reject(
                        "End-date correction cannot erase historical scope or reactivate an expired attachment; create a new attachment",
                      ),
                    );
                  if (patch.end_date !== null) {
                    const later =
                      yield* sql`SELECT id FROM ritual_attachment_checks WHERE attachment_id=${key} AND date>${patch.end_date as string} LIMIT 1`;
                    if (later.length)
                      return yield* Effect.fail(reject("End-date correction would exclude a recorded check"));
                  }
                }
              }
              if (entity === "ritual_attachment_checks" && Object.keys(patch).some((k) => k !== "done"))
                return yield* Effect.fail(reject("Cannot change an attachment check's identity or logical date"));
              after = { ...before, ...patch };
            }
            if (entity === "ritual_attachments" || entity === "ritual_attachment_checks")
              after = yield* validated(entity, after, true);
            yield* checkApplicability(entity, after);
            yield* save(entity, after, before !== null);
            return yield* recordChange(requestId, requestHash, op, entity, key, before, after, source, reason, {
              backup: backupPath,
              replayed: false,
            });
          }),
        );
      });

    const query = (req: Row): Effect.Effect<unknown, StoreError> =>
      Effect.gen(function* () {
        const entity = req.op as string;
        const [start, end] = yield* dateRange(req);
        const params: Array<unknown> = [start, end];
        const column = entity === "weekly_reviews" ? "week_start" : "date";
        let where = `${column} BETWEEN ? AND ?`;
        if (entity === "workouts" && req.type !== null && req.type !== undefined) {
          where += " AND type=?";
          params.push(yield* text(req.type, "type", 120));
        }
        const rows = yield* sql.unsafe<Row>(
          `SELECT * FROM ${entity} WHERE ${where} ORDER BY ${column}${entity === "workouts" ? ",id" : ""}`,
          params,
        );
        const records: Array<Row> = [];
        for (const raw of rows) {
          const r = decode(entity, raw) as Row;
          r.revision = yield* revision(entity, r[keyOf(entity)] as string);
          records.push(r);
        }
        const result: Row = { records, count: records.length };
        if (entity === "workouts") {
          result.active_days = new Set(records.map((r) => r.date)).size;
          const grouping = req.group_by;
          if (grouping !== undefined && grouping !== null && grouping !== "week" && grouping !== "month") {
            return yield* Effect.fail(reject("group_by must be week or month"));
          }
          if (grouping) {
            const groups = new Map<string, { workouts: number; days: Set<string>; by_type: Record<string, number> }>();
            for (const r of records) {
              const day = r.date as string;
              const period = grouping === "month" ? day.slice(0, 7) : mondayOf(day);
              const entry = groups.get(period) ?? { workouts: 0, days: new Set<string>(), by_type: {} };
              entry.workouts += 1;
              entry.days.add(day);
              entry.by_type[r.type as string] = (entry.by_type[r.type as string] ?? 0) + 1;
              groups.set(period, entry);
            }
            result.groups = [...groups.entries()]
              .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([period, v]) => ({ period, workouts: v.workouts, active_days: v.days.size, by_type: v.by_type }));
          }
        }
        return result;
      });

    const reminders = (req: Row): Effect.Effect<unknown, StoreError> =>
      Effect.gen(function* () {
        const asOf = yield* instant("as_of" in req ? req.as_of : stampZ(yield* nowMicros));
        const mode = "mode" in req ? req.mode : "due";
        let rows: ReadonlyArray<Row>;
        if (mode === "due") {
          rows =
            yield* sql<Row>`SELECT * FROM reminders WHERE status='pending' AND due_at IS NOT NULL AND due_at<=${asOf} ORDER BY due_at,id`;
        } else if (mode === "review") {
          rows =
            yield* sql<Row>`SELECT * FROM reminders WHERE status IN ('pending','delivered') ORDER BY due_at IS NOT NULL,due_at,id`;
        } else if (mode === "all") {
          rows = yield* sql<Row>`SELECT * FROM reminders ORDER BY due_at,id`;
        } else return yield* Effect.fail(reject("mode must be due, review, or all"));
        const records: Array<Row> = [];
        for (const row of rows) {
          const item: Row = { ...row };
          item.revision = yield* revision("reminders", item.id as string);
          item.is_due = Boolean(item.due_at && (item.due_at as string) <= asOf && item.status === "pending");
          records.push(item);
        }
        return { as_of: asOf, records, delivery_performed: false };
      });

    const importBundle = (req: Row): Effect.Effect<unknown, StoreError> =>
      Effect.gen(function* () {
        const bundle = req.bundle;
        if (!isRecord(bundle) || bundle.format !== "ritual-source-import-v1") {
          return yield* Effect.fail(reject("Unsupported import format"));
        }
        const batchId = sha(pack(bundle));
        const previousImport = (id: string) =>
          sql<{ manifest: string }>`SELECT manifest FROM imports WHERE id=${id}`.pipe(
            Effect.map((rows) => rows[0] ?? null),
          );
        const previous = yield* previousImport(batchId);
        if (previous) return { import_id: batchId, replayed: true, manifest: JSON.parse(previous.manifest) };
        const required = ["documents", "checkpoints", "rituals", "workouts", "uncertainties"] as const;
        if (required.some((k) => !Array.isArray(bundle[k]))) return yield* Effect.fail(reject("Incomplete import"));
        const documents = bundle.documents as Array<Row>;
        const checkpoints = bundle.checkpoints as Array<Row>;
        for (const source of documents) {
          const keys = isRecord(source) ? Object.keys(source) : [];
          if (keys.length !== 4 || !["id", "path", "sha256", "content"].every((k) => keys.includes(k))) {
            return yield* Effect.fail(reject("Invalid source document"));
          }
          if (sha(source.content as string) !== source.sha256)
            return yield* Effect.fail(reject("Source hash mismatch"));
        }
        for (const row of bundle.rituals as Array<unknown>) yield* validated("rituals", row, true);
        for (const row of bundle.workouts as Array<unknown>) yield* validated("workouts", row, true);
        const ids = new Set(documents.map((s) => s.id));
        for (const row of checkpoints) {
          const keys = isRecord(row) ? Object.keys(row) : [];
          if (
            keys.length !== 5 ||
            !["id", "date", "checkpoint", "source_id", "text"].every((k) => keys.includes(k)) ||
            !ids.has(row.source_id) ||
            !["midday", "evening"].includes(row.checkpoint as string)
          ) {
            return yield* Effect.fail(reject("Invalid source checkpoint"));
          }
          yield* date(row.date);
        }
        const backupPath = yield* backup;
        const result = yield* sql.withTransaction(
          Effect.gen(function* () {
            const again = yield* previousImport(batchId);
            if (again) return { import_id: batchId, replayed: true, manifest: JSON.parse(again.manifest) };
            // A later import may add evidence, but it must never silently overwrite edited records.
            for (const entity of ["rituals", "workouts"] as const) {
              for (const raw of bundle[entity] as Array<unknown>) {
                const row = yield* validated(entity, raw, true);
                const key = (entity === "rituals" ? row.date : row.id) as string;
                const current = yield* get(entity, key);
                if (current && !sameJson(current, row)) {
                  return yield* Effect.fail(reject(`Import conflicts with existing ${entity} record ${key}`));
                }
                yield* checkApplicability(entity, row);
                if (!current) yield* save(entity, row);
              }
            }
            for (const [entity, key] of [
              ["source_documents", "documents"],
              ["legacy_checkpoints", "checkpoints"],
            ] as const) {
              for (const row of bundle[key] as Array<Row>) {
                const current = yield* sql.unsafe<Row>(`SELECT * FROM ${entity} WHERE id=?`, [row.id]);
                if (current.length > 0 && !sameJson({ ...current[0] }, row)) {
                  return yield* Effect.fail(reject("Source evidence identity conflict"));
                }
                if (current.length === 0) yield* save(entity, row);
              }
            }
            const stamp = stampZ(yield* nowMicros);
            const manifest = {
              documents: documents.length,
              checkpoints: checkpoints.length,
              midday_checkpoints: checkpoints.filter((r) => r.checkpoint === "midday").length,
              evening_checkpoints: checkpoints.filter((r) => r.checkpoint === "evening").length,
              rituals: (bundle.rituals as Array<unknown>).length,
              workouts: (bundle.workouts as Array<unknown>).length,
              reminders_created: 0,
              uncertainties: bundle.uncertainties,
            };
            yield* sql`INSERT INTO imports VALUES(${batchId},${stamp},${pack(manifest)})`;
            for (const entity of ["rituals", "workouts"] as const) {
              for (const row of bundle[entity] as Array<Row>) {
                const key = (entity === "rituals" ? row.date : row.id) as string;
                const requestId = `import:${batchId}:${entity}:${key}`;
                yield* sql`INSERT INTO changes(request_id,request_hash,recorded_at,action,entity,entity_id,before_json,after_json,source_text,reason,response_json) VALUES(${requestId},${sha(pack(row))},${stamp},${"import"},${entity},${key},${null},${pack(row)},${"Preserved source import " + batchId},${"Source snapshot, no completion inference"},${"{}"})`;
              }
            }
            return { import_id: batchId, replayed: false, manifest, backup: backupPath };
          }),
        );
        if (!result.replayed) yield* sql.unsafe("PRAGMA optimize");
        return result;
      });

    const exportStore = (saveFile: boolean): Effect.Effect<Row, StoreError> =>
      Effect.gen(function* () {
        const tables = yield* sql.withTransaction(
          Effect.gen(function* () {
            const collected: Record<string, Array<Row>> = {};
            for (const table of state.tableNames) {
              const rows = yield* sql.unsafe<Row>(`SELECT * FROM ${table} ORDER BY ${keyOf(table)}`);
              collected[table] = rows.map((r) => decode(table, r) as Row);
            }
            return collected;
          }),
        );
        const result: Row = {
          format: "ritual-database-export-v1",
          schema_version: state.schemaVersion,
          timezone: TIMEZONE,
          exported_at: stampZ(yield* nowMicros),
          data_sha256: sha(pack(tables)),
          tables,
        };
        if (!saveFile) return result;
        const folder = join(directory, "exports");
        yield* fs.makeDirectory(folder, { recursive: true, mode: 0o700 });
        const target = join(folder, `ritual-export-${compactStamp(yield* nowMicros)}-${yield* randomSuffix}.json`);
        yield* fs.writeFileString(target, dumps(result, 2) + "\n");
        yield* fs.chmod(target, 0o600);
        const rowCounts: Record<string, number> = {};
        for (const [k, v] of Object.entries(tables)) rowCounts[k] = v.length;
        return {
          export: target,
          sha256: sha(yield* fs.readFile(target)),
          data_sha256: result.data_sha256,
          counts: rowCounts,
        };
      });

    const restore = (req: Row): Effect.Effect<unknown, StoreError> =>
      Effect.gen(function* () {
        const snap = req.snapshot;
        if (
          !isRecord(snap) ||
          snap.format !== "ritual-database-export-v1" ||
          !Object.hasOwn(TABLES_BY_VERSION, String(snap.schema_version))
        ) {
          return yield* Effect.fail(reject("Unsupported snapshot"));
        }
        if (Object.values(yield* counts).some((n) => n > 0)) {
          return yield* Effect.fail(reject("Restore requires an empty store; originals will not be overwritten"));
        }
        const tables = (isRecord(snap.tables) ? snap.tables : {}) as Record<string, Array<Row>>;
        const expected = TABLES_BY_VERSION[snap.schema_version as number] as ReadonlyArray<string>;
        const tableNames = Object.keys(tables);
        if (
          tableNames.length !== expected.length ||
          !expected.every((t) => tableNames.includes(t)) ||
          sha(pack(tables)) !== snap.data_sha256
        ) {
          return yield* Effect.fail(reject("Snapshot hash or tables mismatch"));
        }
        // Validate shape before parameterized inserts. Never execute SQL from an export.
        for (const [table, rows] of Object.entries(tables)) {
          const cols = (yield* sql.unsafe<{ name: string }>(`PRAGMA table_info(${table})`)).map((r) => r.name);
          for (const row of rows) {
            const keys = Object.keys(row);
            if (keys.length !== cols.length || !cols.every((c) => keys.includes(c))) {
              return yield* Effect.fail(reject("Snapshot record shape mismatch"));
            }
            if (table in FIELDS) yield* validated(table, row, true);
            if (table === "source_documents" && sha(row.content as string) !== row.sha256) {
              return yield* Effect.fail(reject("Snapshot source hash mismatch"));
            }
          }
        }
        yield* sql.withTransaction(
          Effect.gen(function* () {
            for (const table of TABLES) for (const row of tables[table] ?? []) yield* save(table, row);
            for (const row of yield* exceptions)
              yield* checkApplicability("applicability_exceptions", row as unknown as Row);
            const checks = yield* sql<Row>`SELECT * FROM ritual_attachment_checks`;
            for (const check of checks)
              yield* checkApplicability("ritual_attachment_checks", decode("ritual_attachment_checks", check) as Row);
            // An older snapshot gets the same weekly move as an upgraded store, so its data matches this schema.
            if ((snap.schema_version as number) < 3) {
              yield* moveWeeklyNotes(
                `restore:${snap.data_sha256}:3`,
                `Restoring a version ${snap.schema_version} snapshot`,
              );
            }
          }),
        );
        return {
          restored: true,
          counts: yield* counts,
          data_sha256: (yield* exportStore(false)).data_sha256,
          source_data_sha256: snap.data_sha256,
        };
      });

    const request = (raw: unknown): Effect.Effect<unknown, StoreError> =>
      Effect.gen(function* () {
        if (!isRecord(raw)) return yield* Effect.fail(reject("Send one JSON object"));
        const req = raw;
        const op = req.op;
        state.frozen = state.frozen || (yield* fs.exists(frozenMarker));
        if (state.frozen && (op === "import" || op === "restore" || WRITES.has(op as string))) {
          return yield* Effect.fail(
            reject("Frozen backup copy: writes go to the authoritative store. Do not sync back to this copy."),
          );
        }
        if (state.migrationRequired && op !== "status" && op !== "backup" && op !== "export") {
          return yield* Effect.fail(reject(MIGRATION_REQUIRED(state.schemaVersion)));
        }
        switch (op) {
          case "status": {
            const integrity = yield* sql.unsafe<{ integrity_check: string }>("PRAGMA integrity_check");
            return {
              schema_version: state.schemaVersion,
              migration_required: state.migrationRequired,
              timezone: TIMEZONE,
              counts: yield* counts,
              integrity: (integrity[0] as { integrity_check: string }).integrity_check,
              storage_role: state.frozen ? "frozen_backup" : "authoritative",
              scheduler_managed_externally: true,
            };
          }
          case "backup": {
            const target = yield* backup;
            return { backup: target, sha256: sha(yield* fs.readFile(target)) };
          }
          case "export":
            return yield* exportStore(Boolean(req.save ?? false));
          case "import":
            return yield* importBundle(req);
          case "restore":
            return yield* restore(req);
          case "rituals":
          case "workouts":
          case "weekly_reviews":
            return yield* query(req);
          case "applicability_exceptions": {
            const records: Array<Row> = [];
            for (const r of yield* exceptions)
              records.push({ ...r, revision: yield* revision("applicability_exceptions", r.id) });
            return { records };
          }
          case "ritual_attachments": {
            const ritual = yield* text(req.ritual, "ritual", 120);
            const records: Array<Row> = [];
            for (const item of (yield* attachmentRecords).items.filter((candidate) => candidate.ritual === ritual))
              records.push({ ...item, revision: yield* revision("ritual_attachments", item.id) });
            return { records };
          }
          case "ritual_checklist": {
            const day = yield* date(req.date);
            const ritual = yield* text(req.ritual, "ritual", 120);
            const asOf = yield* instant("as_of" in req ? req.as_of : stampZ(yield* nowMicros));
            return yield* sql.withTransaction(
              Effect.gen(function* () {
                const context = yield* Effect.fromResult(ritualPeriod(asOf));
                const original = yield* get("rituals", day);
                const activity = yield* sql`SELECT id FROM workouts WHERE date=${day} LIMIT 1`;
                const core = yield* Effect.fromResult(
                  dailyStatus(
                    day,
                    (original ?? undefined) as { date: string } | undefined,
                    activity.length > 0,
                    yield* exceptions,
                    context,
                  ),
                );
                const { items, checks } = yield* attachmentRecords;
                const attached = attachmentViews(items, checks, ritual, day);
                return {
                  ...context,
                  ...core,
                  ritual,
                  has_ritual: ritual === "evening" && core.has_ritual,
                  checkins: ritual === "evening" ? (original?.checkins ?? []) : [],
                  habits: ritual === "evening" ? core.habits : {},
                  attachments: attached,
                  full_completion: fullCompletion(ritual === "evening" ? core : null, attached),
                };
              }),
            );
          }
          case "ritual_status": {
            const [start, end] = yield* dateRange(req);
            const asOf = yield* instant("as_of" in req ? req.as_of : stampZ(yield* nowMicros));
            return yield* sql.withTransaction(
              Effect.gen(function* () {
                const rituals = (yield* sql<Row>`SELECT * FROM rituals`).map((r) => decode("rituals", r) as Row);
                const workouts = (yield* sql<{
                  id: string;
                  date: string;
                  type: string;
                }>`SELECT id,date,type FROM workouts`).map((r) => ({ ...r }));
                const report = yield* Effect.fromResult(
                  statusReport(rituals as Array<{ date: string }>, workouts, yield* exceptions, asOf, start, end),
                );
                const { items, checks } = yield* attachmentRecords;
                const includeAttachments = (row: typeof report.active_period) => {
                  const attached = attachmentViews(items, checks, "evening", row.date);
                  return {
                    ...row,
                    ritual: "evening",
                    attachments: attached,
                    full_completion: fullCompletion(row, attached),
                  };
                };
                return {
                  ...report,
                  records: report.records.map(includeAttachments),
                  active_period: includeAttachments(report.active_period),
                };
              }),
            );
          }
          case "reminders":
            return yield* reminders(req);
          case "source": {
            const ident = yield* text(req.id, "id", 200);
            const rows = yield* sql<Row>`SELECT * FROM source_documents WHERE id=${ident}`;
            return rows.length > 0 ? { ...rows[0] } : null;
          }
          case "history": {
            const entity = req.entity;
            if (!isEntity(entity)) return yield* Effect.fail(reject("Unknown entity"));
            const ident = yield* text(req.id, "id", 180);
            const rows =
              yield* sql<Row>`SELECT * FROM changes WHERE entity=${entity} AND entity_id=${ident} ORDER BY id`;
            return rows.map((r) => ({ ...r }));
          }
          default:
            if (WRITES.has(op as string)) return yield* mutate(req);
            return yield* Effect.fail(reject("Unknown operation; arbitrary SQL and shell commands are not supported"));
        }
      });

    return {
      directory,
      path,
      sql,
      frozen: () => state.frozen,
      schemaVersion: () => state.schemaVersion,
      migrationRequired: () => state.migrationRequired,
      tableNames: () => state.tableNames,
      request,
      migrate,
      backup,
      counts,
      get,
      revision,
      exceptions,
    };
  });

/** The store as a service: `yield* Store` inside an Effect provided with `Store.layer(directory)`. */
export class Store extends Context.Service<Store, StoreShape>()("rituals/Store") {
  static readonly open = openStore;
  static readonly layer = (directory: string): Layer.Layer<Store, StoreError, FileSystem.FileSystem> =>
    Layer.effect(Store, openStore(directory));
}
