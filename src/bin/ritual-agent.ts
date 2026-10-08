// bin/ritual-agent: cooperative edit claims between agents.
import { Effect } from "effect";
import { NodeServices } from "@effect/platform-node";
import { act } from "../agentWork.ts";
import { runCli } from "../cli.ts";
import { describe } from "../errors.ts";
import { ROOT } from "../root.ts";

runCli(act(process.argv.slice(2), ROOT).pipe(Effect.provide(NodeServices.layer)), {
  indent: 2,
  onError: (error) => ({ ok: false, error: describe(error) }),
});
