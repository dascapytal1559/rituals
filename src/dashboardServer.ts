// Private Serve backend: one owner, read-only ritual pages, loopback only.
import { Effect, FileSystem, Layer, Option, type Scope } from "effect";
import { HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import type { ServeError } from "effect/http/HttpServerError";
import type { PlatformError } from "effect/PlatformError";
import { NodeHttpServer, NodeHttpServerRequest } from "@effect/platform-node";
import { isAscii } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { Ritual } from "./dashboard.ts";
import { CSP, frontend, jsonResponse, weeklyResponse } from "./dashboardWeb.ts";
import { isRecord } from "./encoding.ts";
import { InvalidConfig } from "./errors.ts";
import { ROOT } from "./root.ts";

export interface ServerConfig {
  readonly listen_host: string;
  readonly listen_port: number;
  readonly tailscale_hostname: string;
  readonly owner_login: string;
}

const CONFIG_FIELDS = ["listen_host", "listen_port", "tailscale_hostname", "owner_login"];

/** The private config must have exactly the four approved fields, the loopback address and port. */
export const loadConfig = (
  path: string,
): Effect.Effect<ServerConfig, InvalidConfig | PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(path);
    const config = yield* Effect.try({
      try: () => JSON.parse(text) as unknown,
      catch: (error) => new InvalidConfig({ message: (error as Error).message }),
    });
    const keys = isRecord(config) ? Object.keys(config) : [];
    if (!isRecord(config) || keys.length !== CONFIG_FIELDS.length || !CONFIG_FIELDS.every((k) => keys.includes(k))) {
      return yield* Effect.fail(new InvalidConfig({ message: "Unexpected dashboard configuration fields" }));
    }
    if (config.listen_host !== "127.0.0.1" || config.listen_port !== 8765) {
      return yield* Effect.fail(
        new InvalidConfig({ message: "Dashboard must use the approved loopback address and port" }),
      );
    }
    const hostname = config.tailscale_hostname;
    if (typeof hostname !== "string" || !/^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/.test(hostname)) {
      return yield* Effect.fail(new InvalidConfig({ message: "Expected a verified Tailscale hostname" }));
    }
    const owner = config.owner_login;
    if (
      typeof owner !== "string" ||
      owner === "" ||
      owner.length > 320 ||
      owner !== owner.trim() ||
      !/^[\x21-\x7e]*$/.test(owner)
    ) {
      return yield* Effect.fail(new InvalidConfig({ message: "Expected the exact existing Tailscale login" }));
    }
    return { listen_host: "127.0.0.1", listen_port: 8765, tailscale_hostname: hostname, owner_login: owner };
  });

export type Renderer = (root: string) => Effect.Effect<string, unknown>;

export interface ServerOptions {
  readonly root: string;
  readonly ownerLogin: string;
  readonly hostname: string;
  readonly port: number;
  readonly renderer?: Renderer;
  readonly weeklyRenderer?: Renderer;
}

const PAGES: Record<string, Ritual> = { "/": "daily", "/weekly": "weekly" };
const REJECTED_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE", "CONNECT"]);

const reply = (status: number, body: string, contentType = "text/plain; charset=utf-8", allow?: string) =>
  HttpServerResponse.text(body, {
    status,
    contentType,
    headers: {
      "cache-control": "no-store",
      pragma: "no-cache",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "content-security-policy": CSP,
      "x-frame-options": "DENY",
      ...(allow === undefined ? {} : { allow }),
      connection: "close",
      server: "RitualDashboard",
    },
  });

const log = (event: string) => Effect.sync(() => process.stderr.write(event + "\n"));

const sameLogin = (presented: string, owner: string): boolean =>
  presented.length === owner.length && timingSafeEqual(Buffer.from(presented), Buffer.from(owner));

/** One request: the same checks, in the same order, as the Python handler. `boundPort` is the port actually listened on. */
export const handle = (options: ServerOptions, boundPort: () => number, request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function* () {
    const raw = NodeHttpServerRequest.toIncomingMessage(request);
    const headerValues = (name: string): Array<string> => {
      const values: Array<string> = [];
      for (let i = 0; i < raw.rawHeaders.length; i += 2) {
        if ((raw.rawHeaders[i] as string).toLowerCase() === name) values.push(raw.rawHeaders[i + 1] as string);
      }
      return values;
    };
    const identities = headerValues("tailscale-user-login");
    const presented = identities[0] ?? "";
    const authorized =
      Option.getOrElse(request.remoteAddress, () => "") === "127.0.0.1" &&
      identities.length === 1 &&
      isAscii(Buffer.from(presented)) &&
      sameLogin(presented, options.ownerLogin);
    if (!authorized) return reply(403, "Access denied.\n");
    const hosts = headerValues("host");
    const allowed = new Set([options.hostname, options.hostname + ":443", "127.0.0.1:" + boundPort()]);
    if (hosts.length !== 1 || !allowed.has(hosts[0] as string)) return reply(400, "Invalid request.\n");
    const path = request.url;
    const page = PAGES[path];
    const api =
      path === "/api/dashboard"
        ? (options.renderer ?? jsonResponse)
        : path === "/api/weekly"
          ? (options.weeklyRenderer ?? weeklyResponse)
          : undefined;
    if (page === undefined && api === undefined) return reply(404, "Not found.\n");
    const lengths = headerValues("content-length");
    if (
      headerValues("transfer-encoding").length > 0 ||
      !(lengths.length === 0 || (lengths.length === 1 && lengths[0] === "0"))
    ) {
      return reply(400, "Invalid request.\n");
    }
    const content: Effect.Effect<string, unknown> =
      page !== undefined ? Effect.sync(() => frontend(page)) : api!(options.root);
    return yield* content.pipe(
      Effect.map((body) =>
        reply(200, body, page !== undefined ? "text/html; charset=utf-8" : "application/json; charset=utf-8"),
      ),
      Effect.catchCause(() =>
        log("dashboard_render_failed").pipe(Effect.as(reply(503, "Dashboard temporarily unavailable.\n"))),
      ),
    );
  });

export const app = (options: ServerOptions, boundPort: () => number) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (request.method === "GET" || request.method === "HEAD") return yield* handle(options, boundPort, request);
    if (REJECTED_METHODS.has(request.method)) return reply(405, "Method not allowed.\n", undefined, "GET, HEAD");
    return reply(501, "Request rejected.\n");
  }).pipe(
    // No paths, headers, identities, or health content in logs.
    Effect.catchCause(() => log("dashboard_request_failed").pipe(Effect.as(HttpServerResponse.empty({ status: 500 })))),
  );

/** Listen on loopback for the lifetime of the scope; port 0 picks a free port (tests). */
export const serve = (options: ServerOptions): Effect.Effect<{ readonly port: number }, ServeError, Scope.Scope> =>
  Effect.gen(function* () {
    const server = http.createServer();
    server.timeout = 10_000;
    // Node routes CONNECT to its own event instead of the request handler; answer it like every other write method.
    server.on("connect", (_request, socket) => {
      const body = "Method not allowed.\n";
      socket.end(
        "HTTP/1.1 405 Method Not Allowed\r\n" +
          "Content-Type: text/plain; charset=utf-8\r\n" +
          `Content-Length: ${Buffer.byteLength(body)}\r\n` +
          "Cache-Control: no-store\r\nPragma: no-cache\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\n" +
          `Content-Security-Policy: ${CSP}\r\n` +
          "X-Frame-Options: DENY\r\nAllow: GET, HEAD\r\nConnection: close\r\nServer: RitualDashboard\r\n\r\n" +
          body,
      );
    });
    const boundPort = () => (server.address() as AddressInfo).port;
    const layer = HttpServer.serve(app(options, boundPort)).pipe(
      Layer.provide(NodeHttpServer.layer(() => server, { host: "127.0.0.1", port: options.port, backlog: 16 })),
    );
    yield* Layer.build(layer);
    return { port: boundPort() };
  });

export const main = (
  argv: ReadonlyArray<string>,
): Effect.Effect<never, InvalidConfig | PlatformError | ServeError, FileSystem.FileSystem> =>
  Effect.scoped(
    Effect.gen(function* () {
      if (argv.length > 0)
        return yield* Effect.fail(new InvalidConfig({ message: "No command-line options accepted" }));
      const config = yield* loadConfig(join(ROOT, "config", "dashboard-server.json"));
      yield* serve({
        root: ROOT,
        ownerLogin: config.owner_login,
        hostname: config.tailscale_hostname,
        port: config.listen_port,
      });
      yield* Effect.sync(() => process.stdout.write("dashboard_listening_on_approved_loopback\n"));
      return yield* Effect.never;
    }),
  );
