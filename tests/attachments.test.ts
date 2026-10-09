// Made-up temporary checks only; no real configuration, health reports or schedule delivery.
import { expect, layer } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import * as fs from "node:fs";
import * as path from "node:path";
import { TABLE_SQL } from "../src/applicability.ts";
import { checkId } from "../src/attachments.ts";
import { call, enqueue, replay } from "../src/localClient.ts";
import { addDays } from "../src/instants.ts";
import { openStore, SCHEMA, WEEKLY_SQL } from "../src/store.ts";
import { inspect, tempDirectory, withDatabase } from "./helpers/fixtures.ts";

const item = (id = "fictional-check", role = "required_check", ritual = "evening") => ({
  op: "attachment_add",
  record: { id, ritual, text: "Fictional temporary check", start_date: "2026-10-03", end_date: "2026-10-09", role },
  request_id: `${id}:setup`,
  source_text: "Fictional configured scope, not a completion report",
});
const check = (
  done: unknown = true,
  day = "2026-10-09",
  id = "fictional-check",
  requestId = `${id}:${day}:report`,
) => ({
  op: "attachment_check",
  attachment_id: id,
  date: day,
  done,
  request_id: requestId,
  source_text: "Fictional explicit answer; receipt distinct from logical date and actual occurrence",
});
const core = (
  day = "2026-10-09",
  patch = { magnesium: true, protein: true, stretching: true, journalling: true, plank_seconds: 62 },
) => ({
  op: "ritual_put",
  date: day,
  patch,
  request_id: `fictional-core:${day}`,
  source_text: "Fictional core only; no check-in",
});
const checklist = (day = "2026-10-09", ritual = "evening", asOf = "2026-10-09T16:00:00Z") => ({
  op: "ritual_checklist",
  date: day,
  ritual,
  as_of: asOf,
});

layer(NodeServices.layer, { excludeTestServices: true })("ritual attachments", (it) => {
  it.effect("required check makes full completion distinct from completed core and unchanged percentages", () =>
    Effect.gen(function* () {
      const store = yield* openStore(yield* tempDirectory);
      yield* store.request(core());
      const request = { op: "ritual_status", from: "2026-10-09", to: "2026-10-09", as_of: "2026-10-10T02:00:00Z" };
      const before = (yield* store.request(request)) as any;
      yield* store.request(item());
      const partial = (yield* store.request(checklist())) as any;
      expect(partial.full_completion).toMatchObject({
        core_complete: true,
        required_checks_complete: false,
        complete: false,
        remaining_attached: ["fictional-check"],
      });
      expect(partial.attachments[0]).toMatchObject({
        done: null,
        status: "unreported",
        requires_response: true,
        revision: 0,
      });
      yield* store.request(check());
      const after = (yield* store.request(request)) as any;
      expect(after.records[0].full_completion.complete).toBe(true);
      expect(after.completion).toEqual(before.completion);
      expect(after.by_habit).toEqual(before.by_habit);
      expect(((yield* store.request(checklist())) as any).checkins).toEqual([]);
    }),
  );

  it.effect("checks cannot complete a ritual while a core item remains unknown", () =>
    Effect.gen(function* () {
      const store = yield* openStore(yield* tempDirectory);
      yield* store.request({ ...core(), patch: { protein: true } });
      yield* store.request(item());
      yield* store.request(check());
      const view = (yield* store.request(checklist())) as any;
      expect(view.full_completion.required_checks_complete).toBe(true);
      expect(view.full_completion.complete).toBe(false);
      expect(view.full_completion.remaining_core).toContain("journalling");
    }),
  );

  it.effect("inclusive logical dates survive wall-clock expiry and never invent past answers", () =>
    Effect.gen(function* () {
      const store = yield* openStore(yield* tempDirectory);
      yield* store.request(item());
      for (const [day, count] of [
        ["2026-10-02", 0],
        ["2026-10-03", 1],
        ["2026-10-09", 1],
        ["2026-10-10", 0],
      ] as const) {
        const view = (yield* store.request(checklist(day, "evening", "2026-10-11T03:00:00Z"))) as any;
        expect(view.attachments).toHaveLength(count);
        if (count) expect(view.attachments[0].status).toBe("unreported");
      }
      yield* store.request(check()); // a late historical answer is allowed for an applicable logical date
      expect(
        ((yield* store.request(checklist("2026-10-09", "evening", "2026-11-01T02:00:00Z"))) as any).attachments[0].done,
      ).toBe(true);
      expect(
        ((yield* store.request(checklist("2026-10-08", "evening", "2026-11-01T02:00:00Z"))) as any).attachments[0].done,
      ).toBeNull();
      expect(((yield* store.request({ op: "rituals", from: "2026-10-01", to: "2026-10-11" })) as any).records).toEqual(
        [],
      );
    }),
  );

  it.effect("reminder-only item is included without a tick or response requirement", () =>
    Effect.gen(function* () {
      const store = yield* openStore(yield* tempDirectory);
      yield* store.request(core());
      yield* store.request(item("fictional-note", "reminder_only"));
      const view = (yield* store.request(checklist())) as any;
      expect(view.full_completion.complete).toBe(true);
      expect(view.attachments[0]).toMatchObject({
        role: "reminder_only",
        requires_response: false,
        check_id: null,
        status: "reminder_only",
      });
      expect((yield* store.request(check(true, "2026-10-09", "fictional-note")).pipe(Effect.flip)).message).toMatch(
        /no tick/,
      );
    }),
  );

  it.effect("ritual identity isolates attachments, with ongoing and DST date boundaries", () =>
    Effect.gen(function* () {
      const store = yield* openStore(yield* tempDirectory);
      yield* store.request(item("fictional-morning", "required_check", "morning"));
      const ongoing = item("fictional-ongoing");
      yield* store.request({ ...ongoing, record: { ...ongoing.record, end_date: null } });
      const evening = (yield* store.request(checklist("2026-10-10"))) as any;
      expect(evening.attachments.map((a: any) => a.id)).toEqual(["fictional-ongoing"]);
      const morning = (yield* store.request(checklist("2026-10-05", "morning", "2026-10-04T16:00:00Z"))) as any;
      expect(morning.attachments.map((a: any) => a.id)).toEqual(["fictional-morning"]);
      expect(morning.habits).toEqual({});
      expect(morning.checkins).toEqual([]);
      expect(morning.full_completion.complete).toBe(false);
      expect(((yield* store.request(checklist("2026-10-03"))) as any).closes_at).toBe("2026-10-04T12:00:00+11:00");
    }),
  );

  it.effect("idempotency, nullable answers and guarded corrections retain exact source history", () =>
    Effect.gen(function* () {
      const store = yield* openStore(yield* tempDirectory);
      yield* store.request(item());
      const first = (yield* store.request(check())) as any;
      expect(((yield* store.request(check())) as any).replayed).toBe(true);
      expect((yield* store.request({ ...check(), done: false }).pipe(Effect.flip)).message).toMatch(
        /different content/,
      );
      expect(
        (yield* store
          .request(check(false, "2026-10-09", "fictional-check", "fresh-but-not-correction"))
          .pipe(Effect.flip)).message,
      ).toMatch(/correct/);
      const correction = {
        op: "correct",
        entity: "ritual_attachment_checks",
        id: first.record.id,
        patch: { done: false },
        expected_revision: first.revision,
        reason: "Fictional corrected answer",
        request_id: "fictional-fix",
        source_text: "Exact fictional correction",
      };
      const fixed = (yield* store.request(correction)) as any;
      expect(fixed.record.done).toBe(false);
      expect((yield* store.request({ ...correction, request_id: "stale-fix" }).pipe(Effect.flip)).message).toMatch(
        /Revision conflict/,
      );
      yield* store.request({
        ...correction,
        patch: { done: null },
        expected_revision: fixed.revision,
        request_id: "fictional-unknown",
      });
      const history = (yield* store.request({
        op: "history",
        entity: "ritual_attachment_checks",
        id: checkId("fictional-check", "2026-10-09"),
      })) as any[];
      expect(history).toHaveLength(3);
      expect(history[0].source_text).toBe(check().source_text);
      expect(((yield* store.request(checklist())) as any).attachments[0].done).toBeNull();
    }),
  );

  it.effect("rejects unknown definitions, out-of-range dates, invalid role/date/value and scope rewrite", () =>
    Effect.gen(function* () {
      const store = yield* openStore(yield* tempDirectory);
      expect((yield* store.request(check()).pipe(Effect.flip)).message).toMatch(/does not apply/);
      const added = (yield* store.request(item())) as any;
      for (const day of ["2026-10-02", "2026-10-10"])
        expect((yield* store.request(check(true, day)).pipe(Effect.flip)).message).toMatch(/does not apply/);
      expect((yield* store.request(check("yes")).pipe(Effect.flip)).message).toMatch(/true, false, or null/);
      const badRole = item("fictional-bad");
      expect(
        (yield* store.request({ ...badRole, record: { ...badRole.record, role: "made-up" } }).pipe(Effect.flip))
          .message,
      ).toMatch(/role/);
      expect(
        (yield* store.request({ ...badRole, record: { ...badRole.record, end_date: "2026-10-01" } }).pipe(Effect.flip))
          .message,
      ).toMatch(/date range/);
      expect(
        (yield* store
          .request({
            op: "correct",
            entity: "ritual_attachments",
            id: "fictional-check",
            patch: { end_date: "2026-10-05" },
            expected_revision: added.revision,
            reason: "Fictional change",
            request_id: "fictional-scope-rewrite",
            source_text: "Fictional",
          })
          .pipe(Effect.flip)).message,
      ).toMatch(/historical scope/);
    }),
  );

  it.effect("offline replay uses the same writes, preserves reports and stops on conflicts", () =>
    Effect.gen(function* () {
      const root = yield* tempDirectory;
      yield* Effect.scoped(openStore(path.join(root, "data")));
      yield* enqueue(item(), root);
      yield* enqueue(check(), root);
      expect(((yield* replay(root)) as any).remaining).toBe(0);
      yield* enqueue(check(), root);
      expect(((yield* replay(root)) as any).synced[0].replayed).toBe(true);
      yield* enqueue({ ...check(), done: false, request_id: "fictional-conflict" }, root);
      yield* enqueue(check(true, "2026-10-08"), root);
      const conflict = (yield* replay(root)) as any;
      expect(conflict.remaining).toBe(2);
      expect(((yield* call(checklist(), root)) as any).attachments[0].done).toBe(true);
      expect(((yield* call(checklist("2026-10-08"), root)) as any).attachments[0].done).toBeNull();
    }),
  );

  it.effect("export roundtrip retains config, exact answers, source history and revision", () =>
    Effect.gen(function* () {
      const first = yield* openStore(yield* tempDirectory);
      yield* first.request(item());
      yield* first.request(check());
      const snapshot = (yield* first.request({ op: "export" })) as any;
      expect(snapshot.schema_version).toBe(4);
      const restored = yield* openStore(yield* tempDirectory);
      yield* restored.request({ op: "restore", snapshot });
      expect(((yield* restored.request({ op: "export" })) as any).data_sha256).toBe(snapshot.data_sha256);
      expect(((yield* restored.request(checklist())) as any).attachments).toEqual(
        ((yield* first.request(checklist())) as any).attachments,
      );
      expect(((yield* restored.request(check())) as any).replayed).toBe(true);
    }),
  );

  it.effect("future-only expiry edits preserve recorded checks and do not erase historical scope", () =>
    Effect.gen(function* () {
      const store = yield* openStore(yield* tempDirectory);
      const configured = item("fictional-ongoing");
      const first = (yield* store.request({ ...configured, record: { ...configured.record, end_date: null } })) as any;
      const today = ((yield* store.request({ op: "ritual_checklist", date: "2026-10-09", ritual: "evening" })) as any)
        .active_date;
      const futureEnd = addDays(today, 10);
      const futureReport = addDays(today, 20);
      yield* store.request(check(true, futureReport, "fictional-ongoing"));
      const correction = {
        op: "correct",
        entity: "ritual_attachments",
        id: "fictional-ongoing",
        patch: { end_date: futureEnd },
        expected_revision: first.revision,
        reason: "Fictional future expiry",
        request_id: "fictional-future-end",
        source_text: "Fictional explicitly chosen future expiry",
      };
      expect((yield* store.request(correction).pipe(Effect.flip)).message).toMatch(/exclude a recorded check/);
      expect(
        (yield* store
          .request({ ...correction, patch: { end_date: addDays(today, -1) }, request_id: "fictional-past-end" })
          .pipe(Effect.flip)).message,
      ).toMatch(/historical scope/);
      const extended = (yield* store.request({
        ...correction,
        patch: { end_date: addDays(today, 30) },
        request_id: "fictional-valid-end",
      })) as any;
      expect(extended.record.end_date).toBe(addDays(today, 30));
      expect(((yield* store.request(checklist(futureReport))) as any).attachments[0].done).toBe(true);
    }),
  );

  it.effect("attachments are exported privately and remain absent from permanent dashboard content", () =>
    Effect.gen(function* () {
      const root = yield* tempDirectory;
      yield* Effect.scoped(openStore(path.join(root, "data")));
      yield* call(core(), root);
      yield* call(item(), root);
      const html = fs.readFileSync(path.join(root, "data/views/ritual-dashboard.html"), "utf8");
      expect(html).not.toContain("Fictional temporary check");
      expect(((yield* call({ op: "export" }, root)) as any).tables.ritual_attachments[0].text).toBe(
        "Fictional temporary check",
      );
    }),
  );

  it.effect("a frozen version 3 backup is read-only and has no invented attachments", () =>
    Effect.gen(function* () {
      const dir = yield* tempDirectory;
      withDatabase(path.join(dir, "ritual.sqlite3"), (db) => {
        db.exec(SCHEMA + TABLE_SQL + WEEKLY_SQL);
        db.exec("INSERT INTO schema_migrations VALUES(1,'old'),(2,'old'),(3,'old')");
      });
      fs.writeFileSync(path.join(dir, "FROZEN_BACKUP.json"), "{}");
      const store = yield* openStore(dir);
      expect(((yield* store.request(checklist())) as any).attachments).toEqual([]);
      expect((yield* store.request(item()).pipe(Effect.flip)).message).toMatch(/Frozen/);
      expect((yield* store.migrate.pipe(Effect.flip)).message).toMatch(/Frozen/);
      expect(store.schemaVersion()).toBe(3);
    }),
  );

  it.effect("version 3 migration is explicit, backed up and preserves all original tables", () =>
    Effect.gen(function* () {
      const dir = yield* tempDirectory;
      withDatabase(path.join(dir, "ritual.sqlite3"), (db) => {
        db.exec(SCHEMA + TABLE_SQL + WEEKLY_SQL);
        db.exec("INSERT INTO schema_migrations VALUES(1,'old'),(2,'old'),(3,'old')");
        db.exec("INSERT INTO rituals(date,protein) VALUES('2026-10-09',1)");
      });
      const store = yield* openStore(dir);
      const before = (yield* store.request({ op: "export" })) as any;
      expect((yield* store.request(checklist()).pipe(Effect.flip)).message).toMatch(/--migrate/);
      const result = yield* store.migrate;
      expect([result.from_version, result.schema_version]).toEqual([3, 4]);
      expect(
        inspect(result.backup!, (db) => (db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as any).v),
      ).toBe(3);
      const after = (yield* store.request({ op: "export" })) as any;
      for (const name of Object.keys(before.tables)) expect(after.tables[name]).toEqual(before.tables[name]);
      expect(after.tables.ritual_attachment_checks).toEqual([]);
      expect(yield* store.migrate).toEqual({ migrated: false, schema_version: 4 });
      expect(fs.readdirSync(path.join(dir, "backups"))).toHaveLength(1);
    }),
  );
});
