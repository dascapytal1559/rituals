// The one way every command-line entry point runs: print the result as JSON on stdout, or print
// an error object and exit 1. Defects (bugs) go to stderr with their cause, like a traceback.
import { Cause, Effect, Exit, Option } from "effect";
import { readFileSync } from "node:fs";
import { dumps } from "./encoding.ts";
import { reject, type RequiresReview } from "./errors.ts";

const NODE_MAJOR = Number(process.versions.node.split(".")[0]);

export interface RunOptions {
  readonly indent?: number;
  /** Turns a typed failure into the JSON object printed on stdout. */
  readonly onError: (error: unknown) => unknown;
}

export const runCli = <A, E>(program: Effect.Effect<A, E>, options: RunOptions): void => {
  process.umask(0o077);
  if (NODE_MAJOR < 24) {
    console.log(
      dumps({
        ok: false,
        error: `Rituals needs Node.js 24 or later; found v${process.versions.node}. Set RITUAL_NODE to a Node 24 binary.`,
      }),
    );
    process.exitCode = 1;
    return;
  }
  void Effect.runPromiseExit(program).then((exit) => {
    if (Exit.isSuccess(exit)) {
      console.log(dumps(exit.value, options.indent));
      return;
    }
    const failure = Cause.findErrorOption(exit.cause);
    if (Option.isSome(failure)) console.log(dumps(options.onError(failure.value)));
    else console.error(Cause.pretty(exit.cause));
    process.exitCode = 1;
  });
};

/** The whole of stdin as a JSON request, with the Python client's 2 MB ceiling. */
export const stdinRequest: Effect.Effect<unknown, RequiresReview> = Effect.gen(function* () {
  const raw = yield* Effect.try({ try: () => readFileSync(0), catch: (error) => reject((error as Error).message) });
  if (raw.length > 2_000_000) return yield* Effect.fail(reject("Request exceeds 2MB"));
  return yield* Effect.try({
    try: () => JSON.parse(raw.toString("utf8")) as unknown,
    catch: (error) => reject((error as Error).message),
  });
});
