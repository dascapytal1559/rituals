// One agent in the two-agent race: open its own store, wait at the barrier, write.
import { Effect } from "effect";
import { NodeServices } from "@effect/platform-node";
import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { openStore } from "../../src/store.ts";

const { root, request, barrier } = workerData as { root: string; request: unknown; barrier: SharedArrayBuffer };
const arrivals = new Int32Array(barrier);
Atomics.add(arrivals, 0, 1);
Atomics.notify(arrivals, 0);
for (;;) {
  const seen = Atomics.load(arrivals, 0);
  if (seen >= 2) break;
  Atomics.wait(arrivals, 0, seen, 5000);
}
const result = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const store = yield* openStore(join(root, "data"));
      return yield* store.request(request);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
parentPort?.postMessage(result);
