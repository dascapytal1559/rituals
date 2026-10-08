import { expect, layer } from "@effect/vitest";
import { Effect, Result } from "effect";
import { NodeServices } from "@effect/platform-node";
import * as fs from "node:fs";
import * as path from "node:path";
import { closesAt, period, statusReport, TABLE_SQL } from "../src/applicability.ts";
import { generate } from "../src/dashboard.ts";
import { pack, sha } from "../src/encoding.ts";
import { openStore, SCHEMA } from "../src/store.ts";
import { BUNDLE, inspect, listFiles, tempDirectory, withDatabase } from "./helpers/fixtures.ts";

const exception = (habit: string, start: string | null, end: string, key?: string) => ({
  op: "exception_add",
  record: { habit, start_date: start, end_date: end, reason: "Isolated validation" },
  request_id: key ?? "test-exception-" + habit,
  source_text: "Isolated test, not a live user entry",
});

const setup = Effect.gen(function* () {
  const root = yield* tempDirectory;
  const store = yield* openStore(path.join(root, "data"));
  yield* store.request({ op: "import", bundle: BUNDLE });
  const seed = Effect.gen(function* () {
    for (const day of ["2026-09-15", "2026-09-16"]) {
      yield* store.request({
        op: "correct",
        entity: "rituals",
        id: day,
        patch: { plank_seconds: 60 },
        expected_revision: yield* store.revision("rituals", day),
        reason: "Test confirmed duration",
        request_id: "test-plank-" + day,
        source_text: "Isolated test of confirmed duration",
      });
    }
    for (const habit of ["magnesium", "protein"]) yield* store.request(exception(habit, "2026-09-17", "2026-09-24"));
    yield* store.request(exception("planks", null, "2026-09-14"));
  });
  const report = (start = "2026-08-23", end = "2026-09-30", asOf = "2026-10-02T12:00:00+10:00") =>
    store.request({ op: "ritual_status", from: start, to: end, as_of: asOf }) as Effect.Effect<any, any>;
  return { root, store, seed, report };
});

layer(NodeServices.layer, { excludeTestServices: true })("applicability store", (it) => {
  it.effect("requested historical cases and denominators", () =>
    Effect.gen(function* () {
      const { store, seed, report } = yield* setup;
      yield* seed;
      const result = yield* report();
      const rows: Record<string, any> = Object.fromEntries(result.records.map((r: any) => [r.date, r]));
      const magnesium = rows["2026-09-27"].habits.magnesium;
      expect(magnesium.status).toBe("not_done");
      expect(magnesium.raw).toBeNull();
      expect(magnesium.basis).toBe("missing_after_close");
      for (const day of ["2026-09-17", "2026-09-24"]) {
        for (const habit of ["magnesium", "protein"]) expect(rows[day].habits[habit].status).toBe("not_applicable");
      }
      for (const day of ["2026-09-15", "2026-09-16"]) {
        expect(rows[day].habits.planks.raw).toBe(60);
        expect(rows[day].habits.planks.status).toBe("done");
      }
      expect(rows["2026-09-14"].habits.planks.status).toBe("not_applicable");
      expect(result.by_habit.planks.applicable).toBe(16);
      expect(result.by_habit.protein.applicable).toBe(31);
      expect(result.completion.applicable).toBe(156);
      expect((yield* store.get("rituals", "2026-09-27"))!.magnesium).toBeNull();
    }),
  );

  it.effect("seed idempotency and corrected exception history", () =>
    Effect.gen(function* () {
      const { store } = yield* setup;
      const request = exception("protein", "2026-09-17", "2026-09-24");
      const first = (yield* store.request(request)) as any;
      const second = (yield* store.request(request)) as any;
      expect(second.replayed).toBe(true);
      expect(first.revision).toBe(second.revision);
      const changed = (yield* store.request({
        op: "correct",
        entity: "applicability_exceptions",
        id: first.record.id,
        patch: { reason: "Clarified test rationale" },
        expected_revision: first.revision,
        reason: "Test correction",
        request_id: "test-exception-correct",
        source_text: "Isolated correction",
      })) as any;
      const history = (yield* store.request({
        op: "history",
        entity: "applicability_exceptions",
        id: first.record.id,
      })) as Array<unknown>;
      expect(history).toHaveLength(2);
      expect(changed.record.start_date).toBe("2026-09-17");
    }),
  );

  it.effect("overlap rejected without inserting a second exception", () =>
    Effect.gen(function* () {
      const { store } = yield* setup;
      yield* store.request(exception("protein", "2026-09-17", "2026-09-24"));
      const error = yield* store
        .request(exception("protein", "2026-09-24", "2026-09-25", "test-overlap"))
        .pipe(Effect.flip);
      expect(error.message).toMatch(/Overlapping/);
      expect((yield* store.counts).applicability_exceptions).toBe(1);
    }),
  );

  it.effect("numeric and source-only positive conflicts stop", () =>
    Effect.gen(function* () {
      const { store } = yield* setup;
      const numeric = yield* store.request(exception("protein", "2026-09-15", "2026-09-17")).pipe(Effect.flip);
      expect(numeric.message).toMatch(/Positive report/);
      const source = yield* store.request(exception("planks", null, "2026-09-16")).pipe(Effect.flip);
      expect(source.message).toMatch(/Positive source plank/);
      expect((yield* store.counts).applicability_exceptions).toBe(0);
    }),
  );

  it.effect("new positive report cannot silently override an exception", () =>
    Effect.gen(function* () {
      const { store } = yield* setup;
      yield* store.request(exception("protein", "2026-09-17", "2026-09-24"));
      const error = yield* store
        .request({
          op: "ritual_put",
          date: "2026-09-17",
          patch: { protein: true },
          request_id: "test-conflicting-report",
          source_text: "Isolated conflicting report",
        })
        .pipe(Effect.flip);
      expect(error.message).toMatch(/Positive report conflicts/);
      expect((yield* store.get("rituals", "2026-09-17"))!.protein).toBeNull();
    }),
  );

  it.effect("late actual report updates past derived status", () =>
    Effect.gen(function* () {
      const { store, seed, report } = yield* setup;
      yield* seed;
      const before = (yield* report("2026-09-27", "2026-09-27")).records[0];
      expect(before.habits.magnesium.status).toBe("not_done");
      const previous = (yield* store.get("rituals", "2026-09-27"))!;
      yield* store.request({
        op: "correct",
        entity: "rituals",
        id: "2026-09-27",
        patch: { magnesium: true },
        expected_revision: yield* store.revision("rituals", "2026-09-27"),
        reason: "Test late report",
        request_id: "test-late-magnesium",
        source_text: "Isolated late correction",
      });
      const after = (yield* report("2026-09-27", "2026-09-27")).records[0];
      expect(after.habits.magnesium.status).toBe("done");
      expect((yield* store.get("rituals", "2026-09-27"))!.checkins).toEqual(previous.checkins);
    }),
  );

  it.effect("noon boundary and current day expectations without insert", () =>
    Effect.gen(function* () {
      const { store, seed, report } = yield* setup;
      yield* seed;
      const count = (yield* store.counts).rituals;
      const before = yield* report("2026-09-30", "2026-09-30", "2026-10-01T11:59:59+10:00");
      const after = yield* report("2026-09-30", "2026-09-30", "2026-10-01T12:00:00+10:00");
      expect(before.records[0].period).toBe("open");
      expect(before.completion.applicable).toBe(0);
      expect(after.records[0].period).toBe("closed");
      expect(after.completion.applicable).toBe(5);
      expect(after.active_period.date).toBe("2026-10-01");
      expect(after.active_period.has_ritual).toBe(false);
      expect((yield* store.counts).rituals).toBe(count);
    }),
  );

  it.effect("zero applicable and outside coverage", () =>
    Effect.gen(function* () {
      const { seed, report } = yield* setup;
      yield* seed;
      const result = yield* report("2026-08-23", "2026-09-14");
      expect(result.by_habit.planks).toEqual({ done: 0, applicable: 0, percentage: null });
      const outside = yield* report("2026-10-01", "2026-10-31");
      expect(outside.records).toEqual([]);
      expect(outside.completion.percentage).toBeNull();
    }),
  );

  it.effect("melbourne noon across both DST changes", () =>
    Effect.sync(() => {
      expect(closesAt("2026-10-03")).toBe("2026-10-04T12:00:00+11:00");
      expect(Result.getOrThrow(period("2026-10-04T00:59:59Z")).active_date).toBe("2026-10-03");
      expect(Result.getOrThrow(period("2026-10-04T01:00:00Z")).active_date).toBe("2026-10-04");
      expect(closesAt("2026-04-04")).toBe("2026-04-05T12:00:00+10:00");
      expect(Result.getOrThrow(period("2026-04-05T01:59:59Z")).active_date).toBe("2026-04-04");
      expect(Result.getOrThrow(period("2026-04-05T02:00:00Z")).active_date).toBe("2026-04-05");
    }),
  );

  it.effect("version 2 export roundtrip with exceptions and audits", () =>
    Effect.gen(function* () {
      const { store, seed } = yield* setup;
      yield* seed;
      const snapshot = (yield* store.request({ op: "export" })) as any;
      const other = yield* openStore(yield* tempDirectory);
      const restored = (yield* other.request({ op: "restore", snapshot })) as any;
      expect(restored.data_sha256).toBe(snapshot.data_sha256);
      expect((yield* other.counts).applicability_exceptions).toBe(3);
    }),
  );

  it.effect("version 1 export restores without losing original tables", () =>
    Effect.gen(function* () {
      const { store } = yield* setup;
      const snapshot = (yield* store.request({ op: "export" })) as any;
      snapshot.schema_version = 1;
      for (const table of ["applicability_exceptions", "weekly_reviews"]) delete snapshot.tables[table];
      snapshot.data_sha256 = sha(pack(snapshot.tables));
      const other = yield* openStore(yield* tempDirectory);
      const restored = (yield* other.request({ op: "restore", snapshot })) as any;
      expect(restored.source_data_sha256).toBe(snapshot.data_sha256);
      const current = ((yield* other.request({ op: "export" })) as any).tables;
      expect(Object.fromEntries(Object.keys(snapshot.tables).map((k) => [k, current[k]]))).toEqual(snapshot.tables);
      expect([current.applicability_exceptions, current.weekly_reviews]).toEqual([[], []]);
    }),
  );

  it.effect("migration is backed up once and keeps existing schema columns", () =>
    Effect.gen(function* () {
      const folder = yield* tempDirectory;
      withDatabase(path.join(folder, "ritual.sqlite3"), (db) => {
        db.exec(SCHEMA);
        db.exec("INSERT INTO schema_migrations VALUES(1,'old')");
        db.exec("INSERT INTO rituals(date,protein) VALUES('2026-09-27',NULL)");
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const store = yield* openStore(folder);
          expect(store.schemaVersion()).toBe(2);
          expect((yield* store.get("rituals", "2026-09-27"))!.protein).toBeNull();
          const workouts = yield* store.sql.unsafe<{ name: string }>("PRAGMA table_info(workouts)");
          expect(workouts.map((c) => c.name)).toEqual(["id", "date", "type", "details"]);
          const exceptions = yield* store.sql.unsafe<{ name: string }>("PRAGMA table_info(applicability_exceptions)");
          expect(exceptions.map((c) => c.name)).toEqual(["id", "habit", "start_date", "end_date", "reason"]);
        }),
      );
      const backups = listFiles(path.join(folder, "backups"), ".sqlite3");
      expect(backups).toHaveLength(1);
      const [versions, table] = inspect(path.join(folder, "backups", backups[0]!), (db) => [
        db
          .prepare("SELECT version FROM schema_migrations")
          .all()
          .map((r: any) => r.version),
        db.prepare("SELECT name FROM sqlite_master WHERE name='applicability_exceptions'").get(),
      ]);
      expect(versions).toEqual([1]);
      expect(table).toBeUndefined();
      yield* Effect.scoped(openStore(folder));
      expect(listFiles(path.join(folder, "backups"), ".sqlite3")).toHaveLength(1);
    }),
  );

  it.effect("dashboard cells use derived status and preserve durations", () =>
    Effect.gen(function* () {
      const { root, seed } = yield* setup;
      yield* seed;
      const result = yield* generate(root);
      const page = fs.readFileSync(result.path, "utf8");
      const row = (day: string) =>
        /<tr data-date="DAY".*?<\/tr>/s.source &&
        (new RegExp('<tr data-date="' + day + '".*?</tr>', "s").exec(page) as RegExpExecArray)[0];
      expect(row("2026-09-27")).toContain('data-field="magnesium" data-status="not_done"');
      expect(row("2026-09-17")).toContain('data-field="protein" data-status="not_applicable"');
      for (const day of ["2026-09-15", "2026-09-16"]) expect(row(day)).toContain("1:00");
      expect(row("2026-09-14")).toContain('data-field="plank_seconds" data-status="not_applicable"');
      expect(page).toContain('data-rate-habit="planks"');
    }),
  );

  it.effect("gap inside coverage is view-only and future not added", () =>
    Effect.sync(() => {
      const rows = [
        { date: "2026-09-01", protein: true },
        { date: "2026-09-03", protein: true },
      ];
      const result = Result.getOrThrow(statusReport(rows, [], [], "2026-09-04T12:00:00+10:00"));
      expect(result.records.map((r) => r.date)).toEqual(["2026-09-01", "2026-09-02", "2026-09-03"]);
      expect(result.records[1]!.has_ritual).toBe(false);
      expect(result.records[1]!.habits.protein.basis).toBe("missing_after_close");
      expect(rows).toHaveLength(2);
    }),
  );
});

export const unusedTableSql = TABLE_SQL;
