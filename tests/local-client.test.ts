import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { NodeServices } from "@effect/platform-node";
import * as fs from "node:fs";
import * as path from "node:path";
import { call, enqueue, init, replay, submit } from "../src/localClient.ts";
import { openStore } from "../src/store.ts";
import { listFiles, mode, tempDirectory } from "./helpers/fixtures.ts";

const REQ = {
  op: "ritual_put",
  date: "2026-10-02",
  patch: { journalling: true },
  request_id: "test-cloud-held-1",
  source_text: "Fictional validation only. Received at 2026-10-02T13:00:00Z; occurrence unknown.",
};

const setup = Effect.gen(function* () {
  const root = yield* tempDirectory;
  yield* Effect.scoped(openStore(path.join(root, "data")));
  return root;
});

const pending = (root: string) => listFiles(path.join(root, "queue", "pending"), ".json");

layer(NodeServices.layer, { excludeTestServices: true })("local client", (it) => {
  it.effect("direct write and idempotent replay", () =>
    Effect.gen(function* () {
      const root = yield* setup;
      const first = (yield* call(REQ, root)) as any;
      const second = (yield* call(REQ, root)) as any;
      expect(first.record.journalling).toBe(true);
      expect(first.record.checkins).toEqual([]);
      expect(second.replayed).toBe(true);
      expect(first.revision).toBe(second.revision);
    }),
  );

  it.effect("handoff enqueues then replays", () =>
    Effect.gen(function* () {
      const root = yield* setup;
      const queued = yield* enqueue(REQ, root);
      expect(queued.status).toBe("queued_on_mac");
      expect(queued.database_confirmed).toBe(false);
      expect(((yield* call({ op: "status" }, root)) as any).counts.rituals).toBe(0);
      const replayed = yield* replay(root);
      expect((replayed as any).remaining).toBe(0);
      expect(listFiles(path.join(root, "queue", "sent"), ".json")).toHaveLength(2);
      expect(((yield* call({ op: "status" }, root)) as any).counts.rituals).toBe(1);
    }),
  );

  it.effect("duplicate delivery after a lost ack is safe", () =>
    Effect.gen(function* () {
      const root = yield* setup;
      const first = (yield* call(REQ, root)) as any;
      yield* enqueue(REQ, root);
      const result = (yield* replay(root)) as any;
      expect(result.synced[0].replayed).toBe(true);
      expect(result.synced[0].revision).toBe(first.revision);
    }),
  );

  it.effect("queue conflicting id is rejected", () =>
    Effect.gen(function* () {
      const root = yield* setup;
      yield* enqueue(REQ, root);
      yield* enqueue(REQ, root);
      const error = yield* enqueue({ ...REQ, patch: { journalling: false } }, root).pipe(Effect.flip);
      expect(error.message).toMatch(/different content/);
    }),
  );

  it.effect("correction requires the current revision and preserves source", () =>
    Effect.gen(function* () {
      const root = yield* setup;
      const first = (yield* call(REQ, root)) as any;
      const correction = {
        op: "correct",
        entity: "rituals",
        id: REQ.date,
        patch: { journalling: false },
        expected_revision: first.revision,
        reason: "Fictional correction",
        source_text: "Fictional user corrects original report",
        request_id: "test-correction",
      };
      yield* enqueue(correction, root);
      expect(((yield* replay(root)) as any).remaining).toBe(0);
      const history = (yield* call({ op: "history", entity: "rituals", id: REQ.date }, root)) as Array<any>;
      expect(history).toHaveLength(2);
      expect(history[0].source_text).toBe(REQ.source_text);
    }),
  );

  it.effect("conflict stops replay without forcing later writes", () =>
    Effect.gen(function* () {
      const root = yield* setup;
      yield* call(REQ, root);
      const bad = {
        op: "correct",
        entity: "rituals",
        id: REQ.date,
        patch: { journalling: false },
        expected_revision: 0,
        reason: "Fictional stale correction",
        source_text: "Fictional stale report",
        request_id: "test-stale",
      };
      yield* enqueue(bad, root);
      yield* enqueue({ ...REQ, date: "2026-10-03", request_id: "test-later" }, root);
      const result = (yield* replay(root)) as any;
      expect(result.requires_review).toBe(true);
      expect(result.remaining).toBe(2);
      expect(((yield* call({ op: "status" }, root)) as any).counts.rituals).toBe(1);
    }),
  );

  it.effect("storage failure queues but validation failure does not", () =>
    Effect.gen(function* () {
      const root = yield* setup;
      const unavailable = path.join(root, "unavailable");
      const queued = (yield* submit(REQ, unavailable, true)) as any;
      expect(queued.status).toBe("queued_on_mac");
      const error = yield* submit({ ...REQ, request_id: "bad", date: "not-a-date" }, root, true).pipe(Effect.flip);
      expect(error._tag).toBe("RequiresReview");
      expect(pending(unavailable)).toHaveLength(1);
      expect(pending(root)).toHaveLength(0);
    }),
  );

  it.effect("no automatic empty store when the database is missing", () =>
    Effect.gen(function* () {
      const root = yield* setup;
      const missing = path.join(root, "other");
      const error = yield* call({ op: "status" }, missing).pipe(Effect.flip);
      expect(error._tag).toBe("StorageUnavailable");
      expect(fs.existsSync(path.join(missing, "data", "ritual.sqlite3"))).toBe(false);
    }),
  );

  it.effect("reads do not queue and the pending payload stays exact", () =>
    Effect.gen(function* () {
      const root = yield* setup;
      const error = yield* enqueue({ op: "status" }, root).pipe(Effect.flip);
      expect(error._tag).toBe("RequiresReview");
      yield* enqueue(REQ, root);
      const file = path.join(root, "queue", "pending", pending(root)[0]!);
      expect(JSON.parse(fs.readFileSync(file, "utf8")).request).toEqual(REQ);
      expect(mode(file)).toBe(0o600);
    }),
  );

  it.effect("frozen backup refuses writes and keeps reads", () =>
    Effect.gen(function* () {
      const root = yield* setup;
      yield* call(REQ, root);
      fs.writeFileSync(path.join(root, "data", "FROZEN_BACKUP.json"), "{}");
      expect(((yield* call({ op: "status" }, root)) as any).storage_role).toBe("frozen_backup");
      const error = yield* call({ ...REQ, request_id: "test-blocked" }, root).pipe(Effect.flip);
      expect(error.message).toMatch(/Frozen backup copy/);
    }),
  );

  it.effect("init creates an empty store once", () =>
    Effect.gen(function* () {
      const root = yield* tempDirectory;
      const missing = yield* call({ op: "status" }, root).pipe(Effect.flip);
      expect(missing._tag).toBe("StorageUnavailable");
      const status = (yield* init(root)) as any;
      expect(status.storage_role).toBe("authoritative");
      expect(Object.values(status.counts as Record<string, number>).reduce((a, b) => a + b, 0)).toBe(0);
      yield* call(REQ, root);
      const again = yield* init(root).pipe(Effect.flip);
      expect(again.message).toMatch(/already exists/);
      expect(((yield* call({ op: "status" }, root)) as any).counts.rituals).toBe(1);
    }),
  );

  it.effect("export roundtrip after queue and correction", () =>
    Effect.gen(function* () {
      const root = yield* setup;
      yield* enqueue(REQ, root);
      yield* replay(root);
      const snapshot = (yield* call({ op: "export" }, root)) as any;
      const other = yield* openStore(yield* tempDirectory);
      expect(((yield* other.request({ op: "restore", snapshot })) as any).data_sha256).toBe(snapshot.data_sha256);
    }),
  );
});
