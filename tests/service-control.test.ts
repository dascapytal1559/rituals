// Lifecycle safety without mutating launchd or opening real network connections.
import { expect, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { NodeServices } from "@effect/platform-node";
import { EventEmitter } from "node:events";
import type * as net from "node:net";
import { ServiceError } from "../src/errors.ts";
import { Launchd, type LaunchdShape, portOpenWith, start, stop } from "../src/serviceControl.ts";

const blocked = Effect.fail(new ServiceError({ message: "probe blocked" }));

const fake = (overrides: Partial<LaunchdShape>): LaunchdShape => ({
  command: () => Effect.succeed({ returncode: 0, stdout: "" }),
  probe: Effect.succeed({ ready: true }),
  portOpen: Effect.succeed(false),
  processAlive: () => Effect.succeed(false),
  sleep: () => Effect.void,
  ...overrides,
});

layer(NodeServices.layer, { excludeTestServices: true })("service control", (it) => {
  it.effect("blocked probe prevents stop mutation", () =>
    Effect.gen(function* () {
      const calls: Array<ReadonlyArray<string>> = [];
      const launchd = fake({
        probe: blocked,
        command: (args) => Effect.sync(() => (calls.push(args), { returncode: 0, stdout: "" })),
      });
      const error = yield* stop("gui/fictional").pipe(Effect.provide(Layer.succeed(Launchd, launchd)), Effect.flip);
      expect(error._tag).toBe("ServiceError");
      expect(calls).toEqual([]);
    }),
  );

  it.effect("blocked probe prevents start mutation", () =>
    Effect.gen(function* () {
      const calls: Array<ReadonlyArray<string>> = [];
      const launchd = fake({
        probe: blocked,
        command: (args) => Effect.sync(() => (calls.push(args), { returncode: 0, stdout: "" })),
      });
      const error = yield* start("/fictional", "gui/fictional").pipe(
        Effect.provide(Layer.succeed(Launchd, launchd)),
        Effect.flip,
      );
      expect(error._tag).toBe("ServiceError");
      expect(calls).toEqual([]);
    }),
  );

  it.effect("stop waits for the old job, process and port", () =>
    Effect.gen(function* () {
      const responses = [
        { returncode: 0, stdout: "\tpid = 123\n" },
        { returncode: 0, stdout: "" },
        { returncode: 0, stdout: "" },
        { returncode: 1, stdout: "" },
      ];
      const alive = [true, false];
      let waits = 0;
      const launchd = fake({
        command: () => Effect.sync(() => responses.shift()!),
        processAlive: () => Effect.sync(() => alive.shift()!),
        portOpen: Effect.succeed(false),
        sleep: () => Effect.sync(() => void waits++),
      });
      yield* stop("gui/fictional").pipe(Effect.provide(Layer.succeed(Launchd, launchd)));
      expect(waits).toBe(1);
    }),
  );

  it.effect("port permission failure is not reported as free", () =>
    Effect.gen(function* () {
      const connect = (() => {
        const socket = new EventEmitter() as EventEmitter & { destroy: () => void };
        socket.destroy = () => undefined;
        queueMicrotask(() => socket.emit("error", Object.assign(new Error("permission"), { code: "EPERM" })));
        return socket;
      }) as unknown as typeof net.connect;
      const error = yield* portOpenWith(connect).pipe(Effect.flip);
      expect(error._tag).toBe("ServiceError");
    }),
  );
});
