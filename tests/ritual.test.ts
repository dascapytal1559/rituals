import { expect, layer } from "@effect/vitest";
import { Effect, Result } from "effect";
import { NodeServices } from "@effect/platform-node";
import * as path from "node:path";
import { melbourneOffset, parseDateTime } from "../src/instants.ts";
import { sha } from "../src/encoding.ts";
import { openStore } from "../src/store.ts";
import { BUNDLE, clone, inspect, PENDING, tempDirectory } from "./helpers/fixtures.ts";

const setup = Effect.gen(function* () {
  const tmp = yield* tempDirectory;
  const store = yield* openStore(tmp);
  const importResult = yield* store.request({ op: "import", bundle: BUNDLE });
  return { tmp, store, importResult };
});

const micros = (text: string) => Result.getOrThrow(parseDateTime(text)).micros;

layer(NodeServices.layer, { excludeTestServices: true })("ritual store", (it) => {
  it.effect("import preserves all original checkpoints and source hashes", () =>
    Effect.gen(function* () {
      const { store } = yield* setup;
      const c = yield* store.counts;
      expect([c.rituals, c.legacy_checkpoints, c.workouts, c.source_documents, c.reminders]).toEqual([
        BUNDLE.rituals.length,
        BUNDLE.checkpoints.length,
        BUNDLE.workouts.length,
        BUNDLE.documents.length,
        0,
      ]);
      const midday = yield* store.sql<{
        c: number;
      }>`SELECT COUNT(*) AS c FROM legacy_checkpoints WHERE checkpoint='midday'`;
      expect(midday[0]!.c).toBe(BUNDLE.checkpoints.filter((r: any) => r.checkpoint === "midday").length);
      for (const row of yield* store.sql<{
        content: string;
        sha256: string;
      }>`SELECT content,sha256 FROM source_documents`) {
        expect(sha(row.content)).toBe(row.sha256);
      }
      const integrity = yield* store.sql.unsafe<{ integrity_check: string }>("PRAGMA integrity_check");
      expect(integrity[0]!.integrity_check).toBe("ok");
    }),
  );

  it.effect("no midday showups in daily evening rows", () =>
    Effect.gen(function* () {
      const { store } = yield* setup;
      expect((yield* store.get("rituals", "2026-08-24"))!.checkins).toEqual(["2026-08-24T15:01:00Z"]);
      expect((yield* store.get("rituals", "2026-09-30"))!.checkins).toEqual([
        "2026-09-30T12:55:00Z",
        "2026-09-30T15:26:00Z",
      ]);
    }),
  );

  it.effect("unknown, pause and no are distinct from true", () =>
    Effect.gen(function* () {
      const { store } = yield* setup;
      expect((yield* store.get("rituals", "2026-09-13"))!.protein).toBeNull();
      expect((yield* store.get("rituals", "2026-09-16"))!.magnesium).toBeNull();
      expect((yield* store.get("rituals", "2026-09-25"))!.protein).toBe(false);
      expect((yield* store.get("rituals", "2026-09-26"))!.protein).toBe(true);
      expect((yield* store.get("rituals", "2026-09-15"))!.plank_seconds).toBeNull();
      expect((yield* store.get("rituals", "2026-09-30"))!.plank_seconds).toBe(66);
    }),
  );

  it.effect("source import is idempotent", () =>
    Effect.gen(function* () {
      const { store } = yield* setup;
      const before = yield* store.counts;
      const result = (yield* store.request({ op: "import", bundle: BUNDLE })) as any;
      expect(result.replayed).toBe(true);
      expect(yield* store.counts).toEqual(before);
    }),
  );

  it.effect("real journalling receipt is not a showup timestamp", () =>
    Effect.gen(function* () {
      const { store } = yield* setup;
      const before = (yield* store.get("rituals", "2026-09-30"))!.checkins;
      const result = (yield* store.request(PENDING)) as any;
      expect(result.record.journalling).toBe(true);
      expect(result.record.checkins).toEqual(before);
      const again = (yield* store.request(PENDING)) as any;
      expect(again.replayed).toBe(true);
      expect(result.revision).toBe(again.revision);
      const rows = yield* store.sql<{
        source_text: string;
        before_json: string;
        after_json: string;
      }>`SELECT source_text,before_json,after_json FROM changes WHERE request_id=${PENDING.request_id}`;
      const row = rows[0]!;
      expect(row.source_text).toContain("2026-09-30T17:06:13Z");
      expect(row.source_text).toContain("Actual journalling occurrence time: unknown");
      expect(JSON.parse(row.before_json).journalling).toBeNull();
      expect(JSON.parse(row.after_json).journalling).toBe(true);
    }),
  );

  it.effect("source id conflict is rejected", () =>
    Effect.gen(function* () {
      const { store } = yield* setup;
      yield* store.request(PENDING);
      const error = yield* store.request({ ...PENDING, patch: { journalling: false } }).pipe(Effect.flip);
      expect(error._tag).toBe("RequiresReview");
      expect(error.message).toMatch(/different content/);
    }),
  );

  it.effect("correct is version guarded and has history", () =>
    Effect.gen(function* () {
      const { store } = yield* setup;
      const first = (yield* store.request(PENDING)) as any;
      const correction = {
        op: "correct",
        entity: "rituals",
        id: "2026-09-30",
        patch: { journalling: null },
        expected_revision: first.revision,
        reason: "Example correction: user says this belonged to a different day",
        source_text: "test correction",
        request_id: "test-correction",
      };
      const result = (yield* store.request(correction)) as any;
      expect(result.record.journalling).toBeNull();
      const stale = yield* store.request({ ...correction, request_id: "test-stale-correction" }).pipe(Effect.flip);
      expect(stale.message).toMatch(/Revision conflict/);
      const history = (yield* store.request({ op: "history", entity: "rituals", id: "2026-09-30" })) as Array<unknown>;
      expect(history).toHaveLength(3);
    }),
  );

  it.effect("reports before check-in do not invent a showup", () =>
    Effect.gen(function* () {
      const { store } = yield* setup;
      const early = (yield* store.request({
        op: "ritual_put",
        date: "2026-10-02",
        patch: { stretching: true },
        source_text: "test stretch report",
        request_id: "test-early",
      })) as any;
      expect(early.record.checkins).toEqual([]);
      const showup = (yield* store.request({
        op: "ritual_put",
        date: "2026-10-02",
        patch: { checkins: ["2026-10-03T00:12:00+10:00"] },
        source_text: "test evening checkin",
        request_id: "test-showup",
      })) as any;
      expect(showup.record.stretching).toBe(true);
      expect(showup.record.checkins).toHaveLength(1);
    }),
  );

  it.effect("workouts are four columns, open types and unlimited rows", () =>
    Effect.gen(function* () {
      const { store } = yield* setup;
      const columns = yield* store.sql.unsafe<{ name: string }>("PRAGMA table_info(workouts)");
      expect(columns.map((c) => c.name)).toEqual(["id", "date", "type", "details"]);
      for (const [i, kind] of ["walk", "gym pull", "swim"].entries()) {
        yield* store.request({
          op: "workout_add",
          record: { date: "2026-10-02", type: kind, details: "test free text" },
          source_text: "test workout",
          request_id: "test-workout-" + i,
        });
      }
      const result = (yield* store.request({
        op: "workouts",
        from: "2026-10-01",
        to: "2026-10-31",
        group_by: "month",
      })) as any;
      expect([result.count, result.active_days]).toEqual([3, 1]);
      expect(result.groups[0].active_days).toBe(1);
      const error = yield* store
        .request({
          op: "workout_add",
          record: { date: "2026-10-02", type: "run", details: "", distance: 5 },
          source_text: "test",
          request_id: "test-no-extra-column",
        })
        .pipe(Effect.flip);
      expect(error.message).toMatch(/Unknown record fields/);
    }),
  );

  it.effect("due reminders are independent of the noon review", () =>
    Effect.gen(function* () {
      const { store } = yield* setup;
      const first = (yield* store.request({
        op: "reminder_add",
        record: { text: "test Monday morning task", due_at: "2026-10-05T08:00:00+11:00" },
        source_text: "test fixture, not a real reminder",
        request_id: "test-reminder",
      })) as any;
      yield* store.request({
        op: "reminder_add",
        record: { text: "test stashed task" },
        source_text: "test fixture",
        request_id: "test-stashed",
      });
      const early = (yield* store.request({ op: "reminders", mode: "due", as_of: "2026-10-05T07:59:00+11:00" })) as any;
      expect(early.records).toHaveLength(0);
      const due = (yield* store.request({ op: "reminders", mode: "due", as_of: "2026-10-05T08:00:00+11:00" })) as any;
      expect(due.records).toHaveLength(1);
      const review = (yield* store.request({ op: "reminders", mode: "review" })) as any;
      expect(review.records).toHaveLength(2);
      yield* store.request({
        op: "reminder_mark",
        id: first.record.id,
        status: "delivered",
        expected_revision: first.revision,
        reason: "test delivery receipt",
        source_text: "test fixture",
        request_id: "test-delivered",
      });
      const later = (yield* store.request({ op: "reminders", as_of: "2026-10-05T12:00:00+11:00" })) as any;
      expect(later.records).toHaveLength(0);
    }),
  );

  it.effect("melbourne DST transition", () =>
    Effect.sync(() => {
      expect(melbourneOffset(micros("2026-10-03T12:00:00+10:00"))).toBe(10 * 3600);
      expect(melbourneOffset(micros("2026-10-04T12:00:00+11:00"))).toBe(11 * 3600);
    }),
  );

  it.effect("backup precedes write", () =>
    Effect.gen(function* () {
      const { store } = yield* setup;
      const result = (yield* store.request(PENDING)) as any;
      const [journalling, integrity] = inspect(result.backup, (db) => [
        (db.prepare("SELECT journalling FROM rituals WHERE date='2026-09-30'").get() as any).journalling,
        (db.prepare("PRAGMA integrity_check").get() as any).integrity_check,
      ]);
      expect(journalling).toBeNull();
      expect(integrity).toBe("ok");
    }),
  );

  it.effect("export and restore roundtrip", () =>
    Effect.gen(function* () {
      const { store } = yield* setup;
      yield* store.request(PENDING);
      const exported = (yield* store.request({ op: "export" })) as any;
      const directory = yield* tempDirectory;
      const other = yield* openStore(directory);
      const result = (yield* other.request({ op: "restore", snapshot: exported })) as any;
      expect(result.data_sha256).toBe(exported.data_sha256);
      expect(((yield* other.request(PENDING)) as any).replayed).toBe(true);
      const again = yield* other.request({ op: "restore", snapshot: exported }).pipe(Effect.flip);
      expect(again.message).toMatch(/empty store/);
    }),
  );

  it.effect("indexes support date and type queries", () =>
    Effect.gen(function* () {
      const { store } = yield* setup;
      const datePlan = JSON.stringify(
        yield* store.sql.unsafe(
          "EXPLAIN QUERY PLAN SELECT * FROM workouts WHERE date BETWEEN '2026-09-01' AND '2026-09-30'",
        ),
      );
      const typePlan = JSON.stringify(
        yield* store.sql.unsafe(
          "EXPLAIN QUERY PLAN SELECT * FROM workouts WHERE type='run' AND date BETWEEN '2026-09-01' AND '2026-09-30'",
        ),
      );
      expect(datePlan).toContain("idx_workouts_date");
      expect(typePlan).toContain("idx_workouts_type_date");
    }),
  );

  it.effect("tampered source is rejected", () =>
    Effect.gen(function* () {
      const { store } = yield* setup;
      const modified = clone(BUNDLE);
      modified.documents[0].content += "tampered";
      const error = yield* store.request({ op: "import", bundle: modified }).pipe(Effect.flip);
      expect(error.message).toMatch(/Source hash mismatch/);
    }),
  );
});

export const fixturePath = path.join;
