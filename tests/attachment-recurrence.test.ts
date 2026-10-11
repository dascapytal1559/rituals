// Fictional weekly checks: no real records or reminder delivery.
import { expect, layer } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import * as fs from "node:fs";
import * as path from "node:path";
import { ATTACHMENT_SQL, checkId } from "../src/attachments.ts";
import { TABLE_SQL } from "../src/applicability.ts";
import { pack, sha } from "../src/encoding.ts";
import { enqueue, replay, call } from "../src/localClient.ts";
import { SCHEMA, WEEKLY_SQL, openStore } from "../src/store.ts";
import { inspect, tempDirectory, withDatabase } from "./helpers/fixtures.ts";

const setup = {
  op: "attachment_add",
  record: {
    id: "fictional-weekly",
    ritual: "evening",
    text: "Fictional weekly check",
    start_date: "2026-10-11",
    end_date: null,
    role: "required_check",
    weekday: 7,
  },
  request_id: "fictional-weekly:setup",
  source_text: "Fictional weekly scope, not a completion report",
};
const checklist = (date: string) => ({
  op: "ritual_checklist",
  ritual: "evening",
  date,
  as_of: "2026-10-12T01:00:00Z",
});
const answer = (date = "2026-10-11") => ({
  op: "attachment_check",
  attachment_id: "fictional-weekly",
  date,
  done: true,
  request_id: "fictional-weekly:" + date,
  source_text: "Explicit fictional answer, no check-in",
});
const core = (date: string) => ({
  op: "ritual_put",
  date,
  patch: { magnesium: true, protein: true, stretching: true, journalling: true, plank_seconds: 60 },
  request_id: "fictional-core:" + date,
  source_text: "Explicit fictional core only",
});

// The exact version-4 row/response shapes are deliberately retained in this old fixture.
const legacySetup = {
  op: "attachment_add",
  record: {
    id: "fictional-daily",
    ritual: "evening",
    text: "Fictional legacy daily check",
    start_date: "2026-10-03",
    end_date: "2026-10-09",
    role: "required_check",
  },
  request_id: "fictional-legacy-setup",
  source_text: "Original fictional version-4 setup",
};
const legacyAnswer = {
  id: checkId("fictional-daily", "2026-10-09"),
  attachment_id: "fictional-daily",
  date: "2026-10-09",
  done: true,
};
const legacyResponse = {
  record: legacySetup.record,
  revision: 1,
  recorded_at: "2026-10-09T15:00:00Z",
  replayed: false,
};
const version4 = Effect.gen(function* () {
  const dir = yield* tempDirectory;
  withDatabase(path.join(dir, "ritual.sqlite3"), (db) => {
    db.exec(SCHEMA + TABLE_SQL + WEEKLY_SQL + ATTACHMENT_SQL);
    db.exec("INSERT INTO schema_migrations VALUES(1,'old'),(2,'old'),(3,'old'),(4,'old')");
    db.prepare("INSERT INTO ritual_attachments VALUES(?,?,?,?,?,?)").run(...Object.values(legacySetup.record));
    db.prepare("INSERT INTO ritual_attachment_checks VALUES(?,?,?,?)").run(
      legacyAnswer.id,
      legacyAnswer.attachment_id,
      legacyAnswer.date,
      1,
    );
    db.prepare(
      "INSERT INTO changes(id,request_id,request_hash,recorded_at,action,entity,entity_id,before_json,after_json,source_text,reason,response_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      1,
      legacySetup.request_id,
      sha(pack(legacySetup)),
      "2026-10-09T15:00:00Z",
      "attachment_add",
      "ritual_attachments",
      legacySetup.record.id,
      null,
      pack(legacySetup.record),
      legacySetup.source_text,
      null,
      pack(legacyResponse),
    );
    db.prepare(
      "INSERT INTO changes(id,request_id,request_hash,recorded_at,action,entity,entity_id,before_json,after_json,source_text,reason,response_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      2,
      "fictional-legacy-answer",
      "fixture-hash",
      "2026-10-09T15:01:00Z",
      "attachment_check",
      "ritual_attachment_checks",
      legacyAnswer.id,
      null,
      pack(legacyAnswer),
      "Original fictional answer",
      null,
      pack({ record: legacyAnswer, revision: 2 }),
    );
    db.exec("INSERT INTO weekly_reviews VALUES('2026-10-05','Original fictional weekly reflection')");
  });
  return { dir, store: yield* openStore(dir) };
});

layer(NodeServices.layer, { excludeTestServices: true })("weekly attachment recurrence", (it) => {
  it.effect("Sunday-only scope includes first/next Sunday and excludes every weekday and earlier Sunday", () =>
    Effect.gen(function* () {
      const store = yield* openStore(yield* tempDirectory);
      yield* store.request(setup);
      for (const [day, count] of [
        ["2026-10-04", 0],
        ["2026-10-10", 0],
        ["2026-10-11", 1],
        ["2026-10-12", 0],
        ["2026-10-13", 0],
        ["2026-10-14", 0],
        ["2026-10-15", 0],
        ["2026-10-16", 0],
        ["2026-10-17", 0],
        ["2026-10-18", 1],
      ] as const) {
        const view = (yield* store.request(checklist(day))) as any;
        expect(view.attachments).toHaveLength(count);
        if (count)
          expect(view.attachments[0]).toMatchObject({
            weekday: 7,
            done: null,
            status: "unreported",
            requires_response: true,
          });
      }
      // An after-midnight Monday read still resolves the explicitly requested Sunday.
      const afterMidnight = (yield* store.request({
        ...checklist("2026-10-11"),
        as_of: "2026-10-11T17:00:00Z",
      })) as any;
      expect(afterMidnight.active_date).toBe("2026-10-11");
      expect(afterMidnight.attachments).toHaveLength(1);
      expect(((yield* store.request({ op: "rituals", from: "2026-10-01", to: "2026-10-20" })) as any).records).toEqual(
        [],
      );
      yield* store.request(core("2026-10-11"));
      yield* store.request(core("2026-10-12"));
      const status = (yield* store.request({
        op: "ritual_status",
        from: "2026-10-11",
        to: "2026-10-12",
        as_of: "2026-10-12T01:00:00Z",
      })) as any;
      expect(status.records[0].attachments).toHaveLength(1);
      expect(status.records[0].full_completion.complete).toBe(false);
      expect(status.records[1].attachments).toEqual([]);
      expect(status.records[1].full_completion.complete).toBe(true);
      expect(status.active_period.attachments).toEqual([]);
    }),
  );

  it.effect("weekly reflection/mentions do not answer the check; each Sunday has its own guarded answer", () =>
    Effect.gen(function* () {
      const store = yield* openStore(yield* tempDirectory);
      yield* store.request(setup);
      yield* store.request(core("2026-10-11"));
      yield* store.request({
        op: "weekly_put",
        week_start: "2026-10-05",
        answer: "Fictional weekly activity mention",
        request_id: "fictional-reflection",
        source_text: "Fictional reflection is separate",
      });
      expect(((yield* store.request(checklist("2026-10-11"))) as any).full_completion.complete).toBe(false);
      const first = (yield* store.request(answer())) as any;
      expect(((yield* store.request(answer())) as any).replayed).toBe(true);
      expect(((yield* store.request(checklist("2026-10-11"))) as any).full_completion.complete).toBe(true);
      expect((yield* store.request(answer("2026-10-12")).pipe(Effect.flip)).message).toMatch(/does not apply/);
      const next = (yield* store.request(checklist("2026-10-18"))) as any;
      expect(next.attachments[0].done).toBeNull();
      expect(next.attachments[0].check_id).not.toBe(first.record.id);
      yield* store.request({
        op: "correct",
        entity: "ritual_attachment_checks",
        id: first.record.id,
        patch: { done: false },
        expected_revision: first.revision,
        reason: "Fictional correction",
        request_id: "fictional-weekly-fix",
        source_text: "Explicit fictional corrected answer",
      });
      expect(((yield* store.request(checklist("2026-10-11"))) as any).full_completion.complete).toBe(false);
      expect(((yield* store.request(checklist("2026-10-11"))) as any).checkins).toEqual([]);
      expect(
        ((yield* store.request({ op: "weekly_reviews", from: "2026-10-05", to: "2026-10-11" })) as any).records[0]
          .answer,
      ).toBe("Fictional weekly activity mention");
    }),
  );

  it.effect("weekday validates ISO values, daily omission defaults null and recurrence scope cannot be rewritten", () =>
    Effect.gen(function* () {
      const store = yield* openStore(yield* tempDirectory);
      for (const value of [0, 8, -1, 1.5, "7", false])
        expect(
          (yield* store
            .request({ ...setup, record: { ...setup.record, weekday: value }, request_id: "invalid:" + String(value) })
            .pipe(Effect.flip)).message,
        ).toMatch(/weekday/);
      const first = (yield* store.request(setup)) as any;
      expect(
        (yield* store
          .request({
            op: "correct",
            entity: "ritual_attachments",
            id: setup.record.id,
            patch: { weekday: null },
            expected_revision: first.revision,
            reason: "Fictional scope rewrite",
            request_id: "fictional-rewrite",
            source_text: "Fictional change",
          })
          .pipe(Effect.flip)).message,
      ).toMatch(/preserve historical scope/);
      const { weekday: _weekday, ...daily } = setup.record;
      yield* store.request({
        ...setup,
        record: { ...daily, id: "fictional-daily-default" },
        request_id: "fictional-daily-default",
      });
      const monday = (yield* store.request(checklist("2026-10-12"))) as any;
      expect(monday.attachments).toHaveLength(1);
      expect(monday.attachments[0].weekday).toBeNull();
    }),
  );

  it.effect(
    "version-4 migration backs up and preserves original config fields, answers, audit and retry receipts",
    () =>
      Effect.gen(function* () {
        const { dir, store } = yield* version4;
        const before = (yield* store.request({ op: "export" })) as any;
        expect((yield* store.request(checklist("2026-10-09")).pipe(Effect.flip)).message).toMatch(/--migrate/);
        const result = yield* store.migrate;
        expect([result.from_version, result.schema_version]).toEqual([4, 5]);
        expect(
          inspect(
            result.backup!,
            (db) => (db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as any).v,
          ),
        ).toBe(4);
        const after = (yield* store.request({ op: "export" })) as any;
        for (const [table, rows] of Object.entries(before.tables)) {
          if (table === "ritual_attachments")
            expect(after.tables[table].map(({ weekday: _day, ...r }: any) => r)).toEqual(rows);
          else expect(after.tables[table]).toEqual(rows);
        }
        expect(after.tables.ritual_attachments[0].weekday).toBeNull();
        expect((yield* store.request(legacySetup)) as any).toEqual({ ...legacyResponse, replayed: true });
        expect(((yield* store.request(checklist("2026-10-08"))) as any).attachments[0].done).toBeNull();
        expect(((yield* store.request(checklist("2026-10-09"))) as any).attachments[0].done).toBe(true);
        expect(yield* store.migrate).toEqual({ migrated: false, schema_version: 5 });
        expect(fs.readdirSync(path.join(dir, "backups"))).toHaveLength(1);
      }),
  );

  it.effect("version-4 exports restore daily scope without rewriting audit or fabricating weekly answers", () =>
    Effect.gen(function* () {
      const { store: old } = yield* version4;
      const snapshot = (yield* old.request({ op: "export" })) as any;
      const current = yield* openStore(yield* tempDirectory);
      const restored = (yield* current.request({ op: "restore", snapshot })) as any;
      expect(restored.source_data_sha256).toBe(snapshot.data_sha256);
      const exported = (yield* current.request({ op: "export" })) as any;
      expect(exported.tables.ritual_attachments[0]).toEqual({ ...legacySetup.record, weekday: null });
      expect(exported.tables.changes).toEqual(snapshot.tables.changes);
      expect(exported.tables.ritual_attachment_checks).toEqual(snapshot.tables.ritual_attachment_checks);
      expect(((yield* current.request(checklist("2026-10-08"))) as any).attachments[0].done).toBeNull();
      expect(((yield* current.request(checklist("2026-10-09"))) as any).attachments[0].done).toBe(true);
      expect(((yield* current.request(legacySetup)) as any).replayed).toBe(true);
    }),
  );

  it.effect("current export roundtrip retains recurrence and independent Sunday states", () =>
    Effect.gen(function* () {
      const store = yield* openStore(yield* tempDirectory);
      yield* store.request(setup);
      yield* store.request(answer());
      const snapshot = (yield* store.request({ op: "export" })) as any;
      const other = yield* openStore(yield* tempDirectory);
      yield* other.request({ op: "restore", snapshot });
      expect(((yield* other.request({ op: "export" })) as any).data_sha256).toBe(snapshot.data_sha256);
      expect(((yield* other.request(checklist("2026-10-11"))) as any).attachments[0].done).toBe(true);
      expect(((yield* other.request(checklist("2026-10-18"))) as any).attachments[0].done).toBeNull();
      expect(((yield* other.request(checklist("2026-10-12"))) as any).attachments).toEqual([]);
    }),
  );

  it.effect("offline replay retains logical Sunday rather than replay wall-clock day and blocks invalid weekday", () =>
    Effect.gen(function* () {
      const root = yield* tempDirectory;
      fs.mkdirSync(path.join(root, "data"));
      yield* openStore(path.join(root, "data"));
      yield* enqueue(setup, root);
      yield* enqueue(answer(), root);
      expect((yield* replay(root)).synced.length).toBe(2);
      expect(((yield* call(checklist("2026-10-11"), root)) as any).attachments[0].done).toBe(true);
      yield* enqueue(answer("2026-10-12"), root);
      yield* enqueue(core("2026-10-12"), root);
      const conflict = yield* replay(root);
      expect(conflict).toMatchObject({ status: "blocked", remaining: 2 });
    }),
  );

  it.effect("frozen version-4 backup is readable and remains untouched", () =>
    Effect.gen(function* () {
      const { dir } = yield* version4;
      fs.writeFileSync(path.join(dir, "FROZEN_BACKUP.json"), "{}");
      const file = path.join(dir, "ritual.sqlite3");
      const before = sha(fs.readFileSync(file));
      const frozen = yield* openStore(dir);
      expect(((yield* frozen.request(checklist("2026-10-09"))) as any).attachments[0].done).toBe(true);
      expect((yield* frozen.migrate.pipe(Effect.flip)).message).toMatch(/Frozen/);
      expect((yield* frozen.request(setup).pipe(Effect.flip)).message).toMatch(/Frozen/);
      expect(sha(fs.readFileSync(file))).toBe(before);
    }),
  );
});
