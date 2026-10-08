// Fresh sequential clients and cooperative edit ownership, only temporary stores.
import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { NodeServices } from "@effect/platform-node";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { act } from "../src/agentWork.ts";
import { openStore } from "../src/store.ts";
import { REPO, tempDirectory } from "./helpers/fixtures.ts";

const HELPER = path.join(REPO, "tests", "helpers", "client-process.ts");

/** Each action starts a new process: no hidden in-memory handover state. */
const client = (root: string, action: string, request?: unknown): any => {
  const args = [HELPER, action, root, ...(request === undefined ? [] : [JSON.stringify(request)])];
  try {
    return JSON.parse(execFileSync(process.execPath, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  } catch (error) {
    throw new Error(String((error as { stderr?: string }).stderr ?? error), { cause: error });
  }
};

layer(NodeServices.layer, { excludeTestServices: true })("agent handover", (it) => {
  it.effect("two fresh clients replay, correct and restore", () =>
    Effect.gen(function* () {
      const root = yield* tempDirectory;
      yield* Effect.scoped(openStore(path.join(root, "data")));
      const first = {
        op: "ritual_put",
        date: "2026-10-03",
        patch: { journalling: true },
        request_id: "fictional-agent-a:ritual",
        source_text: "Fictional isolated report. Received2026-10-03T12:00:00Z; actual completion unknown.",
      };
      expect(client(root, "enqueue", first).database_confirmed).toBe(false);
      expect(client(root, "replay").remaining).toBe(0);
      const retry = client(root, "call", first);
      expect(retry.replayed).toBe(true);
      const second = { ...first, request_id: "fictional-agent-b:ritual", patch: { protein: true } };
      const saved = client(root, "call", second);
      expect(saved.record.journalling).toBe(true);
      expect(saved.record.checkins).toEqual([]);
      const correction: Record<string, unknown> = {
        op: "correct",
        entity: "rituals",
        id: first.date,
        patch: { protein: false },
        request_id: "fictional-agent-b:correct",
        source_text: "Fictional correction.",
        reason: "Fictional mistaken report",
        expected_revision: retry.revision,
      };
      expect(() => client(root, "call", correction)).toThrow(/Revision conflict/);
      correction.expected_revision = saved.revision;
      const final = client(root, "call", correction);
      expect(() => client(root, "call", { ...first, patch: { journalling: false } })).toThrow();
      const history = client(root, "call", { op: "history", entity: "rituals", id: first.date });
      expect(history).toHaveLength(3);
      expect(history[0].source_text).toBe(first.source_text);
      const stale = { ...correction, request_id: "fictional-stale-queued", expected_revision: saved.revision };
      client(root, "enqueue", stale);
      client(root, "enqueue", { ...first, date: "2026-10-04", request_id: "fictional-later-held" });
      const blocked = client(root, "replay");
      expect([blocked.status, blocked.remaining]).toEqual(["blocked", 2]);
      expect(client(root, "call", { op: "status" }).counts.rituals).toBe(1);
      const snapshot = client(root, "call", { op: "export" });
      const other = yield* openStore(yield* tempDirectory);
      expect(((yield* other.request({ op: "restore", snapshot })) as any).data_sha256).toBe(snapshot.data_sha256);
      expect(((yield* other.request(correction)) as any).revision).toBe(final.revision);
    }),
  );

  it.effect("edit claim rejects another owner then allows the next turn", () =>
    Effect.gen(function* () {
      const root = yield* tempDirectory;
      expect((yield* act(["status"], root)).claimed).toBe(false);
      yield* act(["claim", "fictional-a", "UI"], root);
      expect((yield* act(["claim", "fictional-b", "migration"], root).pipe(Effect.flip))._tag).toBe("RequiresReview");
      expect((yield* act(["release", "fictional-b"], root).pipe(Effect.flip))._tag).toBe("RequiresReview");
      yield* act(["release", "fictional-a"], root);
      yield* act(["claim", "fictional-b", "UI"], root);
      yield* act(["release", "fictional-b"], root);
    }),
  );
});
