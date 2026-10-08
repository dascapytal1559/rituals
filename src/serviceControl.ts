// Control the existing approved named app, without modifying its configuration.
//
// Everything that touches the machine (launchctl, the readiness probe, the port probe, process
// liveness, waiting) sits behind the Launchd service so tests can replace it; the live layer is
// the only place that runs commands or opens sockets.
import { Context, Effect, FileSystem, Layer } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { spawnSync } from "node:child_process";
import * as http from "node:http";
import * as net from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./dashboardServer.ts";
import { sameJson } from "./encoding.ts";
import { type InvalidConfig, reject, type RequiresReview, ServiceError } from "./errors.ts";
import { ROOT } from "./root.ts";

export const LABEL = "local.ritual-dashboard";
const PORT = 8765;

export interface CommandResult {
  readonly returncode: number;
  readonly stdout: string;
}

export interface Probe {
  readonly ready: boolean;
  readonly rows?: number;
}

export type ProbeError = ServiceError | InvalidConfig | PlatformError;

export interface LaunchdShape {
  readonly command: (args: ReadonlyArray<string>) => Effect.Effect<CommandResult>;
  readonly probe: Effect.Effect<Probe, ProbeError>;
  readonly portOpen: Effect.Effect<boolean, ServiceError>;
  readonly processAlive: (pid: number) => Effect.Effect<boolean, ServiceError>;
  readonly sleep: (millis: number) => Effect.Effect<void>;
}

const fail = (message: string) => Effect.fail(new ServiceError({ message }));
const AMBIGUOUS = "Readiness probe failed ambiguously; inspect service before restarting";

/** GET /api/dashboard as the owner; connection refused means "not ready", anything else is a judgement call. */
export const probeWith = (ownerLogin: string): Effect.Effect<Probe, ServiceError> =>
  Effect.callback<Probe, ServiceError>((resume) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port: PORT,
        path: "/api/dashboard",
        method: "GET",
        headers: { "Tailscale-User-Login": ownerLogin },
        timeout: 2000,
        agent: false,
      },
      (response) => {
        const chunks: Array<Buffer> = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          if (response.statusCode !== 200) {
            resume(fail("Existing backend rejected readiness request; review config/service identity"));
            return;
          }
          try {
            const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { count?: number };
            if (typeof value.count !== "number") throw new Error("count missing");
            resume(Effect.succeed({ ready: true, rows: value.count }));
          } catch {
            resume(fail(AMBIGUOUS));
          }
        });
      },
    );
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EPERM" || error.code === "EACCES") {
        resume(
          fail(
            "Network readiness probe blocked by execution permissions; use authorized Mac execution, not a service/config change",
          ),
        );
      } else if (error.code === "ECONNREFUSED") resume(Effect.succeed({ ready: false }));
      else resume(fail(AMBIGUOUS));
    });
    request.end();
  });

/** Port occupancy, not an HTTP response, determines whether shutdown completed. */
export const portOpenWith = (connect: typeof net.connect): Effect.Effect<boolean, ServiceError> =>
  Effect.callback<boolean, ServiceError>((resume) => {
    const socket = connect({ host: "127.0.0.1", port: PORT, timeout: 2000 });
    const ambiguous = () => resume(fail("Port occupancy probe blocked or ambiguous; do not start a second service"));
    socket.on("connect", () => {
      socket.destroy();
      resume(Effect.succeed(true));
    });
    socket.on("timeout", () => {
      socket.destroy();
      ambiguous();
    });
    socket.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED") resume(Effect.succeed(false));
      else ambiguous();
    });
  });

export class Launchd extends Context.Service<Launchd, LaunchdShape>()("rituals/Launchd") {
  static readonly live: Layer.Layer<Launchd, never, FileSystem.FileSystem> = Layer.effect(
    Launchd,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const probe: Effect.Effect<Probe, ProbeError> = loadConfig(join(ROOT, "config", "dashboard-server.json")).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.flatMap((config) => probeWith(config.owner_login)),
      );
      return {
        command: (args) =>
          Effect.sync(() => {
            const result = spawnSync("/bin/launchctl", [...args], { encoding: "utf8" });
            return { returncode: result.status ?? 1, stdout: result.stdout ?? "" };
          }),
        probe,
        portOpen: portOpenWith(net.connect),
        processAlive: (pid) =>
          Effect.try({
            try: () => {
              process.kill(pid, 0);
              return true;
            },
            catch: (error) => error as NodeJS.ErrnoException,
          }).pipe(
            Effect.catchIf(
              (error) => error.code === "ESRCH",
              () => Effect.succeed(false),
            ),
            Effect.mapError((error) => new ServiceError({ message: error.message })),
          ),
        sleep: (millis) => Effect.sleep(millis),
      };
    }),
  );
}

export interface Validated {
  readonly plist: string;
  readonly domain: string;
  readonly executable: string;
}

/** Read the installed LaunchAgent (via plutil, the macOS plist tool) and confirm it is the named app. */
export const validate: Effect.Effect<Validated, RequiresReview | ServiceError | PlatformError, FileSystem.FileSystem> =
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const plist = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
    const converted = spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", plist], { encoding: "utf8" });
    if (converted.status !== 0) return yield* fail((converted.stderr ?? "").trim() || "LaunchAgent plist unreadable");
    const cfg = JSON.parse(converted.stdout) as Record<string, unknown>;
    const executable = join(homedir(), "Applications", "Ritual Dashboard.app", "Contents", "MacOS", "RitualDashboard");
    if (cfg.Label !== LABEL || !sameJson(cfg.ProgramArguments, [executable])) {
      return yield* Effect.fail(reject("Existing LaunchAgent identity/program differs; review instead of changing it"));
    }
    const info = yield* fs.stat(executable).pipe(Effect.option);
    if (info._tag === "None" || info.value.type !== "File") {
      return yield* Effect.fail(reject("Named app missing; no alternate service will be started"));
    }
    return { plist, domain: `gui/${process.getuid?.() ?? 0}`, executable };
  });

export const status = (domain: string) =>
  Effect.gen(function* () {
    const launchd = yield* Launchd;
    const result = yield* launchd.command(["print", `${domain}/${LABEL}`]);
    return { loaded: result.returncode === 0, ...(yield* launchd.probe) };
  });

export const stop = (domain: string) =>
  Effect.gen(function* () {
    const launchd = yield* Launchd;
    yield* launchd.probe; // Verify probe permission before any mutation.
    const job = yield* launchd.command(["print", `${domain}/${LABEL}`]);
    const loaded = job.returncode === 0;
    const match = /^\s*pid = (\d+)\s*$/m.exec(job.stdout);
    const oldPid = match ? Number(match[1]) : null;
    if (loaded) {
      const result = yield* launchd.command(["bootout", `${domain}/${LABEL}`]);
      if (result.returncode !== 0) return yield* fail("Existing LaunchAgent could not be stopped");
    }
    // bootout sends SIGTERM; named app joins its own child on shutdown.
    for (let attempt = 0; attempt < 60; attempt++) {
      const jobGone = (yield* launchd.command(["print", `${domain}/${LABEL}`])).returncode !== 0;
      const alive = oldPid === null ? false : yield* launchd.processAlive(oldPid);
      if (jobGone && !alive && !(yield* launchd.portOpen)) return;
      yield* launchd.sleep(200);
    }
    return yield* fail("Named app/job or backend is still shutting down; do not start a second service");
  });

export const start = (plist: string, domain: string) =>
  Effect.gen(function* () {
    const launchd = yield* Launchd;
    yield* launchd.probe; // Verify probe permission before any mutation.
    const loaded = (yield* launchd.command(["print", `${domain}/${LABEL}`])).returncode === 0;
    const result = yield* launchd.command(loaded ? ["kickstart", `${domain}/${LABEL}`] : ["bootstrap", domain, plist]);
    if (result.returncode !== 0) return yield* fail("Existing LaunchAgent could not be started");
    for (let attempt = 0; attempt < 60; attempt++) {
      if ((yield* launchd.probe).ready) return;
      yield* launchd.sleep(200);
    }
    return yield* fail("Named app did not become ready; inspect generic app logs, do not broaden permissions");
  });

export const main = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const action = args[0];
    if (args.length !== 1 || !["status", "start", "stop", "restart"].includes(action as string)) {
      return yield* Effect.fail(reject("Usage: ritual-service status|start|stop|restart"));
    }
    const { plist, domain } = yield* validate;
    if (action === "status") return yield* status(domain);
    if (action === "stop" || action === "restart") yield* stop(domain);
    if (action === "start" || action === "restart") yield* start(plist, domain);
    return { action, ...(yield* status(domain)) };
  });
