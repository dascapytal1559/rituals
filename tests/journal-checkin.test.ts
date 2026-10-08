// Journal defaults through the real transactional store and local queue API.
// All reports here are fictional and use temporary stores.
import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { NodeServices } from "@effect/platform-node";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import { readDashboardData } from "../src/dashboardWeb.ts";
import { call, enqueue, replay } from "../src/localClient.ts";
import { openStore } from "../src/store.ts";
import { REPO, tempDirectory } from "./helpers/fixtures.ts";

const journal = (
  ident = "fictional-first-journal",
  stamp = "2026-10-08T22:15:00+11:00",
  patch?: Record<string, unknown>,
) => ({
  op: "ritual_put",
  date: "2026-10-08",
  patch: patch ?? { journalling: true },
  journal_entry_at: stamp,
  request_id: ident,
  source_text:
    "Fictional journal. Received at " +
    stamp +
    ". Original receipt supplies authorized journal default; actual physical arrival/completion unknown.",
});

const setup = Effect.gen(function* () {
  const root = yield* tempDirectory;
  yield* Effect.scoped(openStore(path.join(root, "data")));
  const rowOf = Effect.map(
    call({ op: "rituals", from: "2026-10-08", to: "2026-10-08" }, root),
    (r: any) => r.records[0],
  );
  const history = Effect.map(
    call({ op: "history", entity: "rituals", id: "2026-10-08" }, root),
    (h) => h as Array<any>,
  );
  return { root, rowOf, history };
});

const runWorker = (root: string, request: unknown, barrier: SharedArrayBuffer) =>
  new Promise<any>((resolve, reject) => {
    const worker = new Worker(path.join(REPO, "tests", "helpers", "journal-worker.ts"), {
      workerData: { root, request, barrier },
    });
    worker.on("message", resolve);
    worker.on("error", reject);
    worker.on("exit", (code) => code !== 0 && reject(new Error("worker exited " + code)));
  });

layer(NodeServices.layer, { excludeTestServices: true })("journal check-in", (it) => {
  it.effect("first journal defaults without inventing other habits", () =>
    Effect.gen(function* () {
      const { root, history } = yield* setup;
      const first = (yield* call(journal(), root)) as any;
      expect(first.record.checkins).toEqual(["2026-10-08T11:15:00Z"]);
      expect(first.record.journalling).toBe(true);
      expect(first.record.protein).toBeNull();
      expect(first.record.plank_seconds).toBeNull();
      const event = (yield* history)[0];
      expect(event.source_text).toBe(journal().source_text);
      expect(JSON.parse(event.after_json).checkins).toEqual(first.record.checkins);
    }),
  );

  it.effect("empty patch records only the authorized default", () =>
    Effect.gen(function* () {
      const { root } = yield* setup;
      const first = (yield* call(journal(undefined, undefined, {}), root)) as any;
      expect(first.record.checkins).toEqual(["2026-10-08T11:15:00Z"]);
      expect(first.record.journalling).toBeNull();
    }),
  );

  it.effect("explicit first is preserved even when the journal instant is earlier", () =>
    Effect.gen(function* () {
      const { root } = yield* setup;
      const explicit = (yield* call(
        {
          op: "ritual_put",
          date: "2026-10-08",
          patch: { checkins: ["2026-10-08T22:00:00+11:00"], protein: true },
          request_id: "fictional-explicit",
          source_text:
            "Fictional explicit check-in. Received at 2026-10-08T22:00:00+11:00; exact physical instant unknown.",
        },
        root,
      )) as any;
      const after = (yield* call(journal(undefined, "2026-10-08T21:00:00+11:00"), root)) as any;
      expect(after.record.checkins).toEqual(explicit.record.checkins);
      expect(after.record.protein).toBe(true);
    }),
  );

  it.effect("explicit patch wins over the default in the same request", () =>
    Effect.gen(function* () {
      const { root } = yield* setup;
      const after = (yield* call(
        journal(undefined, undefined, { checkins: ["2026-10-08T22:00:00+11:00"] }),
        root,
      )) as any;
      expect(after.record.checkins).toEqual(["2026-10-08T11:00:00Z"]);
    }),
  );

  it.effect("continuation and exact retry leave the default stable", () =>
    Effect.gen(function* () {
      const { root, history } = yield* setup;
      const req = journal();
      const first = (yield* call(req, root)) as any;
      const retry = (yield* call(req, root)) as any;
      expect(retry.replayed).toBe(true);
      expect(retry.revision).toBe(first.revision);
      const later = (yield* call(journal("fictional-continuation", "2026-10-09T02:10:00+11:00", {}), root)) as any;
      expect(later.record.checkins).toEqual(first.record.checkins);
      expect(yield* history).toHaveLength(2);
      const error = yield* call({ ...req, journal_entry_at: "2026-10-09T02:10:00+11:00" }, root).pipe(Effect.flip);
      expect(error.message).toMatch(/different content/);
    }),
  );

  it.effect("offline replay uses the original instant and deduplicates a lost ack", () =>
    Effect.gen(function* () {
      const { root, rowOf, history } = yield* setup;
      const req = journal();
      yield* enqueue(req, root);
      expect(((yield* replay(root)) as any).remaining).toBe(0);
      const firstRevision = (yield* rowOf).revision;
      yield* enqueue(req, root);
      const second = (yield* replay(root)) as any;
      expect(second.synced[0].replayed).toBe(true);
      expect((yield* rowOf).revision).toBe(firstRevision);
      expect((yield* rowOf).checkins).toEqual(["2026-10-08T11:15:00Z"]);
      expect(yield* history).toHaveLength(1);
    }),
  );

  it.effect("after midnight keeps the logical date and receipt qualification", () =>
    Effect.gen(function* () {
      const { root } = yield* setup;
      const req = journal(undefined, "2026-10-09T01:15:00+11:00");
      req.source_text += " Logical ritual date is prior evening October 8, not date of receipt.";
      const first = (yield* call(req, root)) as any;
      expect(first.record.date).toBe("2026-10-08");
      expect(first.record.checkins).toEqual(["2026-10-08T14:15:00Z"]);
      const item = (yield* readDashboardData(root)).rows[0]!.checkin_times[0]!;
      expect([item.text, item.day_offset, item.basis]).toEqual(["01:15", 1, "message_received"]);
      expect(item.datetime.endsWith("+11:00")).toBe(true);
      expect(item.label).toContain("receipt time");
    }),
  );

  it.effect("invalid naive timestamp does not create a record", () =>
    Effect.gen(function* () {
      const { root, history } = yield* setup;
      const error = yield* call(journal(undefined, "2026-10-08T22:15:00"), root).pipe(Effect.flip);
      expect(error.message).toMatch(/UTC offset/);
      expect(((yield* call({ op: "rituals", from: "2026-10-08", to: "2026-10-08" }, root)) as any).records).toEqual([]);
      expect(yield* history).toEqual([]);
    }),
  );

  it.effect("correction history survives the original retry and continuation", () =>
    Effect.gen(function* () {
      const { root, rowOf, history } = yield* setup;
      const req = journal();
      const first = (yield* call(req, root)) as any;
      const corrected = (yield* call(
        {
          op: "correct",
          entity: "rituals",
          id: "2026-10-08",
          patch: { checkins: ["2026-10-08T22:05:00+11:00"] },
          expected_revision: first.revision,
          reason: "Fictional user supplies corrected check-in",
          request_id: "fictional-correction",
          source_text: "Fictional corrected check-in; original default retained in history.",
        },
        root,
      )) as any;
      yield* call(req, root);
      expect((yield* rowOf).checkins).toEqual(corrected.record.checkins);
      const continuation = (yield* call(
        journal("fictional-after-correction", "2026-10-09T02:10:00+11:00", {}),
        root,
      )) as any;
      expect(continuation.record.checkins).toEqual(corrected.record.checkins);
      const events = yield* history;
      expect(events).toHaveLength(3);
      expect(JSON.parse(events[1].before_json).checkins).toEqual(first.record.checkins);
    }),
  );

  it.effect("two agents cannot add two competing defaults", () =>
    Effect.gen(function* () {
      const { root, rowOf, history } = yield* setup;
      const barrier = new SharedArrayBuffer(4);
      const requests = [journal("fictional-agent-a"), journal("fictional-agent-b", "2026-10-08T22:20:00+11:00")];
      const results = yield* Effect.promise(() =>
        Promise.all(requests.map((request) => runWorker(root, request, barrier))),
      );
      const first = results.reduce((a, b) => (a.revision < b.revision ? a : b));
      expect((yield* rowOf).checkins).toEqual(first.record.checkins);
      expect((yield* rowOf).checkins).toHaveLength(1);
      expect(yield* history).toHaveLength(2);
    }),
  );
});
