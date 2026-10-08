// Weekly review answers: their own record, the reviewed migration out of notes, and the answer-only views.
import { expect, layer } from "@effect/vitest";
import { Effect, Result } from "effect";
import { NodeServices } from "@effect/platform-node";
import * as fs from "node:fs";
import * as path from "node:path";
import { TABLE_SQL } from "../src/applicability.ts";
import * as dashboard from "../src/dashboard.ts";
import * as dashboardWeb from "../src/dashboardWeb.ts";
import { sha } from "../src/encoding.ts";
import { parseDateTime } from "../src/instants.ts";
import { migrate } from "../src/localClient.ts";
import { openStore, SCHEMA } from "../src/store.ts";
import { inspect, listFiles, mode, tempDirectory, withDatabase } from "./helpers/fixtures.ts";
import { count } from "./helpers/html.ts";

const weekly = (week: unknown, answer: unknown, key: string) => ({
  op: "weekly_put",
  week_start: week,
  answer,
  request_id: key,
  source_text: "Fictional weekly answer, isolated test only",
});
const at = (text: string) => Result.getOrThrow(parseDateTime(text)).micros;

/** A store as it was before weekly_reviews existed, with fictional notes per ritual date. */
const version2Store = (folder: string, notes: Record<string, string>): string => {
  const file = path.join(folder, "ritual.sqlite3");
  withDatabase(file, (db) => {
    db.exec(SCHEMA + TABLE_SQL);
    db.exec("INSERT INTO schema_migrations VALUES(1,'old'),(2,'old')");
    const insert = db.prepare("INSERT INTO rituals(date,protein,notes) VALUES(?,1,?)");
    for (const [day, text] of Object.entries(notes)) insert.run(day, text);
  });
  return file;
};

const NOTES: Record<string, string> = {
  "2026-09-20": "Weekly: Fictional quiet week",
  "2026-09-27": "Fictional topic line\nWeekly: Fictional shipped a prototype\nFictional closing line",
  "2026-09-28": "Weekly:",
  "2026-09-29": "Not a weekly line: Weekly: stays",
};

layer(NodeServices.layer, { excludeTestServices: true })("weekly record", (it) => {
  it.effect("new store starts at the current schema", () =>
    Effect.gen(function* () {
      const tmp = yield* tempDirectory;
      const store = yield* openStore(tmp);
      const status = (yield* store.request({ op: "status" })) as any;
      expect([status.schema_version, status.migration_required, status.counts.weekly_reviews]).toEqual([3, false, 0]);
      expect(fs.existsSync(path.join(tmp, "backups"))).toBe(false);
    }),
  );

  it.effect("put appends, replays and corrects with revision", () =>
    Effect.gen(function* () {
      const store = yield* openStore(yield* tempDirectory);
      const first = (yield* store.request(
        weekly("2026-09-28", "Fictional: shipped the thing", "fictional-msg-1:weekly"),
      )) as any;
      expect(first.record).toEqual({ week_start: "2026-09-28", answer: "Fictional: shipped the thing" });
      expect(
        ((yield* store.request(weekly("2026-09-28", "Fictional: shipped the thing", "fictional-msg-1:weekly"))) as any)
          .replayed,
      ).toBe(true);
      expect(
        (yield* store.request(weekly("2026-09-28", "Changed", "fictional-msg-1:weekly")).pipe(Effect.flip)).message,
      ).toMatch(/different content/);
      const added = (yield* store.request(
        weekly("2026-09-28", "Fictional: and one more", "fictional-msg-2:weekly"),
      )) as any;
      expect(added.record.answer).toBe("Fictional: shipped the thing\nFictional: and one more");
      const stale = yield* store
        .request({
          op: "correct",
          entity: "weekly_reviews",
          id: "2026-09-28",
          patch: { answer: "Fixed" },
          expected_revision: first.revision,
          reason: "Fictional fix",
          request_id: "fictional-fix",
          source_text: "Fictional",
        })
        .pipe(Effect.flip);
      expect(stale.message).toMatch(/Revision conflict/);
      const fixed = (yield* store.request({
        op: "correct",
        entity: "weekly_reviews",
        id: "2026-09-28",
        patch: { answer: "Fixed" },
        expected_revision: added.revision,
        reason: "Fictional fix",
        request_id: "fictional-fix",
        source_text: "Fictional",
      })) as any;
      expect(fixed.record.answer).toBe("Fixed");
      const move = yield* store
        .request({
          op: "correct",
          entity: "weekly_reviews",
          id: "2026-09-28",
          patch: { week_start: "2026-09-21" },
          expected_revision: fixed.revision,
          reason: "x",
          request_id: "fictional-move",
          source_text: "Fictional",
        })
        .pipe(Effect.flip);
      expect(move.message).toMatch(/identity/);
      expect(
        (yield* store.request({ op: "history", entity: "weekly_reviews", id: "2026-09-28" })) as Array<unknown>,
      ).toHaveLength(3);
      const read = (yield* store.request({ op: "weekly_reviews", from: "2026-09-01", to: "2026-09-30" })) as any;
      expect(read.records.map((r: any) => [r.week_start, r.revision])).toEqual([["2026-09-28", fixed.revision]]);
    }),
  );

  it.effect("week must be a Monday with an answer", () =>
    Effect.gen(function* () {
      const store = yield* openStore(yield* tempDirectory);
      for (const week of ["2026-10-04", "2026-09-29", "2026-9-28", null]) {
        const error = yield* store
          .request(weekly(week, "Fictional", "fictional-bad-week-" + String(week)))
          .pipe(Effect.flip);
        expect(error.message).toMatch(/Monday|calendar date/);
      }
      for (const answer of ["", "   ", null]) {
        const error = yield* store
          .request(weekly("2026-09-28", answer, "fictional-bad-answer-" + JSON.stringify(answer)))
          .pipe(Effect.flip);
        expect(error.message).toMatch(/answer/);
      }
      const direct = yield* store.sql
        .unsafe("INSERT INTO weekly_reviews VALUES('2026-10-04','Sunday is not a week start')")
        .pipe(Effect.flip);
      expect(direct._tag).toBe("SqlError");
      expect((yield* store.counts).weekly_reviews).toBe(0);
    }),
  );

  it.effect("frozen copy refuses weekly writes", () =>
    Effect.gen(function* () {
      const tmp = yield* tempDirectory;
      const store = yield* openStore(tmp);
      fs.writeFileSync(path.join(tmp, "FROZEN_BACKUP.json"), "{}");
      const error = yield* store.request(weekly("2026-09-28", "Fictional", "fictional-frozen")).pipe(Effect.flip);
      expect(error.message).toMatch(/Frozen/);
    }),
  );
});

layer(NodeServices.layer, { excludeTestServices: true })("weekly migration", (it) => {
  it.effect("migration is explicit, backed up, moves lines and audits both sides", () =>
    Effect.gen(function* () {
      const folder = yield* tempDirectory;
      version2Store(folder, NOTES);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const store = yield* openStore(folder);
          expect(((yield* store.request({ op: "status" })) as any).migration_required).toBe(true);
          for (const request of [
            { op: "rituals", from: "2026-09-01", to: "2026-09-30" },
            weekly("2026-09-28", "x", "fictional-early"),
          ]) {
            expect((yield* store.request(request).pipe(Effect.flip)).message).toMatch(/--migrate/);
          }
          expect(((yield* store.request({ op: "export" })) as any).schema_version).toBe(2);
          const result = yield* store.migrate;
          expect([result.migrated, result.from_version, result.schema_version]).toEqual([true, 2, 3]);
          expect(result.moved_weekly_answers).toEqual([
            { date: "2026-09-20", week_start: "2026-09-14", lines: 1 },
            { date: "2026-09-27", week_start: "2026-09-21", lines: 1 },
          ]);
          expect(sha(fs.readFileSync(result.backup!))).toBe(result.backup_sha256);
          const [maxVersion, oldNotes] = inspect(result.backup!, (db) => [
            (db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as any).v,
            (db.prepare("SELECT notes FROM rituals WHERE date='2026-09-20'").get() as any).notes,
          ]);
          expect(maxVersion).toBe(2);
          expect(oldNotes).toBe(NOTES["2026-09-20"]);
          const weeks = yield* store.sql<{
            week_start: string;
            answer: string;
          }>`SELECT * FROM weekly_reviews ORDER BY week_start`;
          expect(weeks.map((w) => ({ ...w }))).toEqual([
            { week_start: "2026-09-14", answer: "Fictional quiet week" },
            { week_start: "2026-09-21", answer: "Fictional shipped a prototype" },
          ]);
          const notes = Object.fromEntries(
            (yield* store.sql<{ date: string; notes: string | null }>`SELECT date,notes FROM rituals`).map((r) => [
              r.date,
              r.notes,
            ]),
          );
          expect(notes).toEqual({
            "2026-09-20": null,
            "2026-09-27": "Fictional topic line\nFictional closing line",
            "2026-09-28": "Weekly:",
            "2026-09-29": NOTES["2026-09-29"],
          });
          expect((yield* store.get("rituals", "2026-09-27"))!.protein).toBe(true);
          const history = (yield* store.request({ op: "history", entity: "rituals", id: "2026-09-27" })) as Array<any>;
          expect(JSON.parse(history[history.length - 1].before_json).notes).toBe(NOTES["2026-09-27"]);
          expect(history[history.length - 1].action).toBe("migrate");
          const moved = (yield* store.request({
            op: "history",
            entity: "weekly_reviews",
            id: "2026-09-21",
          })) as Array<any>;
          expect([moved.length, moved[0].action]).toEqual([1, "migrate"]);
          expect(moved[0].source_text).toContain("2026-09-27");
          expect(yield* store.migrate).toEqual({ migrated: false, schema_version: 3 });
          expect(listFiles(path.join(folder, "backups"), ".sqlite3")).toHaveLength(1);
          // Normal writes resume and keep the revision guard working after the move.
          expect(
            ((yield* store.request(weekly("2026-09-21", "Fictional addition", "fictional-after"))) as any).record
              .answer,
          ).toBe("Fictional shipped a prototype\nFictional addition");
        }),
      );
      const again = yield* openStore(folder);
      expect([again.schemaVersion(), again.migrationRequired()]).toEqual([3, false]);
    }),
  );

  it.effect("frozen old copy reads but never migrates", () =>
    Effect.gen(function* () {
      const folder = yield* tempDirectory;
      version2Store(folder, NOTES);
      fs.writeFileSync(path.join(folder, "FROZEN_BACKUP.json"), "{}");
      const store = yield* openStore(folder);
      expect(((yield* store.request({ op: "rituals", from: "2026-09-01", to: "2026-09-30" })) as any).count).toBe(4);
      expect((yield* store.migrate.pipe(Effect.flip)).message).toMatch(/Frozen/);
    }),
  );

  it.effect("CLI migrate refreshes views and never creates a store", () =>
    Effect.gen(function* () {
      const root = yield* tempDirectory;
      expect((yield* migrate(root).pipe(Effect.flip))._tag).toBe("StorageUnavailable");
      expect(fs.existsSync(path.join(root, "data", "ritual.sqlite3"))).toBe(false);
      fs.mkdirSync(path.join(root, "data"));
      version2Store(path.join(root, "data"), NOTES);
      const result = (yield* migrate(root)) as any;
      expect(result.migrated && result.dashboard.updated).toBe(true);
      expect(result.dashboard.weeks).toBe(2);
      expect(fs.readFileSync(result.dashboard.weekly_path, "utf8")).toContain("Fictional shipped a prototype");
      expect(((yield* migrate(root)) as any).migrated).toBe(false);
    }),
  );

  it.effect("restoring a version 2 snapshot applies the same move", () =>
    Effect.gen(function* () {
      const old = yield* tempDirectory;
      version2Store(old, NOTES);
      const snapshot = yield* Effect.scoped(
        Effect.flatMap(openStore(old), (source) => source.request({ op: "export" })),
      );
      const target = yield* openStore(yield* tempDirectory);
      const restored = (yield* target.request({ op: "restore", snapshot })) as any;
      expect(restored.source_data_sha256).toBe((snapshot as any).data_sha256);
      expect((yield* target.counts).weekly_reviews).toBe(2);
      expect((yield* target.get("rituals", "2026-09-20"))!.notes).toBeNull();
    }),
  );
});

layer(NodeServices.layer, { excludeTestServices: true })("weekly view", (it) => {
  it.effect("week labels span months and years", () =>
    Effect.sync(() => {
      expect(dashboard.weekView({ week_start: "2026-09-21", answer: "x" }).display).toBe("Sep 21 – 27");
      expect(dashboard.weekView({ week_start: "2026-09-28", answer: "x" }).display).toBe("Sep 28 – Oct 4");
      const view = dashboard.weekView({ week_start: "2026-12-28", answer: "x" });
      expect([view.display, view.week_end]).toEqual(["Dec 28 – Jan 3", "2027-01-03"]);
      expect(view.full).toBe("Week of Monday 28 December 2026 – Sunday 3 January 2027");
    }),
  );

  it.effect("API and snapshot expose only weekly answers", () =>
    Effect.gen(function* () {
      const root = yield* tempDirectory;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const store = yield* openStore(path.join(root, "data"));
          yield* store.request({
            op: "ritual_put",
            date: "2026-09-27",
            patch: { notes: "Fictional private note" },
            request_id: "fictional-note",
            source_text: "Fictional private source words",
          });
          for (const [week, key] of [
            ["2026-09-21", "a"],
            ["2026-09-28", "b"],
          ]) {
            yield* store.request(
              weekly(week, `Fictional answer ${key}\n<script>alert(1)</script>`, "fictional-weekly-" + key),
            );
          }
        }),
      );
      const data = yield* dashboardWeb.readWeeklyData(root, at("2026-10-04T20:00:00+11:00"));
      expect(new Set(Object.keys(data))).toEqual(
        new Set(["generated_at", "updated_display", "timezone", "count", "weeks"]),
      );
      expect(data.weeks.map((w) => new Set(Object.keys(w)))).toEqual([
        new Set(["week_start", "week_end", "display", "full", "answer"]),
        new Set(["week_start", "week_end", "display", "full", "answer"]),
      ]);
      expect(data.weeks.map((w) => w.week_start)).toEqual(["2026-09-28", "2026-09-21"]);
      const rawText = yield* dashboardWeb.weeklyResponse(root);
      for (const priv of ["Fictional private", "source", "revision", "request_id", "notes"])
        expect(rawText).not.toContain(priv);
      const result = yield* dashboard.generate(root);
      const page = fs.readFileSync(result.weekly_path, "utf8");
      expect(mode(result.weekly_path)).toBe(0o600);
      expect(page).not.toContain("Fictional private");
      expect(page).not.toContain("<script>alert");
      expect(page).toContain("&lt;script&gt;alert");
      expect(page).toContain("<title>Weekly review</title>");
      expect(page).toContain(
        '<option value="ritual-dashboard.html">Daily rituals</option><option value="weekly-review.html" selected>Weekly review</option>',
      );
      expect(page).toContain(">2 weeks</span>");
      expect(fs.readFileSync(result.path, "utf8")).not.toContain("Fictional private");
    }),
  );

  it.effect("empty weekly page", () =>
    Effect.sync(() => {
      const page = dashboard.renderWeekly([], Date.now() * 1000);
      expect(page).toContain(">0 weeks</span>");
      expect(page).toContain(dashboard.WEEKLY_EMPTY + "</p>");
      expect(page).not.toContain("<tr data-week=");
      expect(count(page, "<script>")).toBe(1);
    }),
  );
});
