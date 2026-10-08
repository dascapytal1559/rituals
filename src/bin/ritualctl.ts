// bin/ritualctl: one JSON request on stdin, one JSON acknowledgement on stdout.
import { Effect } from "effect";
import { NodeServices } from "@effect/platform-node";
import { runCli, stdinRequest } from "../cli.ts";
import { describe, reject } from "../errors.ts";
import { enqueue, init, migrate, queueStatus, replay, submit } from "../localClient.ts";
import { ROOT } from "../root.ts";

const USAGE = "Usage: ritualctl [--init | --migrate | --enqueue | --replay | --queue-status | --queue-on-failure]";
const args = process.argv.slice(2);
const only = (flag: string): boolean => args.length === 1 && args[0] === flag;

const program = Effect.gen(function* () {
  if (only("--init")) return yield* init(ROOT);
  if (only("--migrate")) return yield* migrate(ROOT);
  if (only("--replay")) return yield* replay(ROOT);
  if (only("--queue-status")) return yield* queueStatus(ROOT);
  if (!(args.length === 0 || only("--enqueue") || only("--queue-on-failure"))) return yield* Effect.fail(reject(USAGE));
  const request = yield* stdinRequest;
  return only("--enqueue") ? yield* enqueue(request, ROOT) : yield* submit(request, ROOT, args.length > 0);
}).pipe(Effect.provide(NodeServices.layer));

runCli(program, {
  indent: 2,
  onError: (error) => ({
    ok: false,
    error: describe(error),
    kind: (error as { _tag?: string })._tag === "StorageUnavailable" ? "storage_unavailable" : "requires_review",
  }),
});
