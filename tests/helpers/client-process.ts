// A fresh process per client action: no hidden in-memory handover state (used by the smoke test).
// argv: action root [request-json]
import { Effect, Exit } from "effect";
import { NodeServices } from "@effect/platform-node";
import { describe } from "../../src/errors.ts";
import { call, enqueue, replay } from "../../src/localClient.ts";

const [action, root, request] = process.argv.slice(2) as [string, string, string | undefined];
const parsed = request === undefined ? undefined : (JSON.parse(request) as unknown);
const program = action === "replay" ? replay(root) : action === "enqueue" ? enqueue(parsed, root) : call(parsed, root);

const exit = await Effect.runPromiseExit(program.pipe(Effect.provide(NodeServices.layer)));
if (Exit.isSuccess(exit)) {
  process.stdout.write(JSON.stringify(exit.value));
} else {
  process.stderr.write(describe(Exit.isFailure(exit) ? ((exit.cause as any).reasons?.[0]?.error ?? exit.cause) : exit));
  process.exitCode = 1;
}
