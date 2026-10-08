// bin/ritual-server: the private read-only dashboard backend on 127.0.0.1:8765.
import { Cause, Effect } from "effect";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { main } from "../dashboardServer.ts";

process.umask(0o077);

NodeRuntime.runMain(
  main(process.argv.slice(2)).pipe(
    Effect.provide(NodeServices.layer),
    Effect.tapCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.void
        : Effect.sync(() => process.stderr.write("dashboard_start_failed\n")),
    ),
  ),
  { disableErrorReporting: true },
);
