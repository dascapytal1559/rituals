// bin/ritual-dashboard: regenerate the static snapshots under data/views.
import { Effect } from "effect";
import { NodeServices } from "@effect/platform-node";
import { runCli } from "../cli.ts";
import { generate } from "../dashboard.ts";
import { describe } from "../errors.ts";
import { ROOT } from "../root.ts";

if (process.argv.length !== 2) {
  console.error("Usage: ritual-dashboard");
  process.exit(1);
}

runCli(generate(ROOT).pipe(Effect.provide(NodeServices.layer)), {
  onError: (error) => ({ updated: false, error: describe(error) }),
});
