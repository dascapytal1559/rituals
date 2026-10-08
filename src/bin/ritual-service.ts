// bin/ritual-service: status, start, stop and restart of the existing LaunchAgent.
import { Effect } from "effect";
import { NodeServices } from "@effect/platform-node";
import { runCli } from "../cli.ts";
import { describe } from "../errors.ts";
import { Launchd, main } from "../serviceControl.ts";

runCli(main(process.argv.slice(2)).pipe(Effect.provide(Launchd.live), Effect.provide(NodeServices.layer)), {
  indent: 2,
  onError: (error) => ({ ok: false, error: describe(error) }),
});
