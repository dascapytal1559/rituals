import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { NodeServices } from "@effect/platform-node";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as path from "node:path";
import { readOnlyClient } from "../src/dashboard.ts";
import { loadConfig, serve, type ServerOptions } from "../src/dashboardServer.ts";
import { openStore } from "../src/store.ts";
import { fileSha, tempDirectory } from "./helpers/fixtures.ts";

const OWNER = "owner@example.invalid";
const HOSTNAME = "test.tail123.ts.net";

interface Reply {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: Buffer;
}

const request = (
  port: number,
  options: { method?: string; path?: string; identity?: string | null; headers?: Record<string, string> } = {},
): Effect.Effect<Reply> =>
  Effect.promise(
    () =>
      new Promise<Reply>((resolve, reject) => {
        const headers: Record<string, string> = {};
        if (options.identity !== null) headers["Tailscale-User-Login"] = options.identity ?? OWNER;
        Object.assign(headers, options.headers ?? {});
        const req = http.request(
          {
            host: "127.0.0.1",
            port,
            method: options.method ?? "GET",
            path: options.path ?? "/",
            headers,
            agent: false,
          },
          (res) => {
            const chunks: Array<Buffer> = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () =>
              resolve({ status: res.statusCode as number, headers: res.headers, body: Buffer.concat(chunks) }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      }),
  );

const raw = (port: number, text: string): Effect.Effect<string> =>
  Effect.promise(
    () =>
      new Promise<string>((resolve, reject) => {
        const socket = net.connect(port, "127.0.0.1", () => socket.write(text));
        let data = "";
        socket.on("data", (chunk) => (data += chunk.toString()));
        socket.on("end", () => resolve(data));
        socket.on("close", () => resolve(data));
        socket.on("error", reject);
      }),
  );

const setup = (overrides: Partial<ServerOptions> = {}) =>
  Effect.gen(function* () {
    const root = yield* tempDirectory;
    const store = yield* openStore(path.join(root, "data"));
    const { port } = yield* serve({ root, ownerLogin: OWNER, hostname: HOSTNAME, port: 0, ...overrides });
    return { root, store, port };
  });

layer(NodeServices.layer, { excludeTestServices: true })("dashboard server", (it) => {
  it.effect("only the exact owner is accepted", () =>
    Effect.gen(function* () {
      const { port } = yield* setup();
      for (const identity of [
        null,
        "other@example.invalid",
        "OWNER@example.invalid",
        "",
        "owner@example.invalid,other@example.invalid",
      ]) {
        const reply = yield* request(port, { identity });
        expect(reply.status).toBe(403);
        expect(reply.body.toString()).not.toContain("Daily ritual");
        for (const p of ["/api/dashboard", "/weekly", "/api/weekly"])
          expect((yield* request(port, { path: p, identity })).status).toBe(403);
      }
      const reply = yield* request(port);
      expect(reply.status).toBe(200);
      expect(reply.body.toString()).toContain("Daily ritual");
      expect(reply.headers["cache-control"]).toBe("no-store");
      expect(reply.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    }),
  );

  it.effect("duplicate identity is rejected", () =>
    Effect.gen(function* () {
      const { port } = yield* setup();
      const response = yield* raw(
        port,
        `GET / HTTP/1.0\r\nHost: 127.0.0.1:${port}\r\nTailscale-User-Login: ${OWNER}\r\nTailscale-User-Login: ${OWNER}\r\n\r\n`,
      );
      expect(response.split("\r\n")[0]).toContain("403");
    }),
  );

  it.effect("no file paths, queries or write methods", () =>
    Effect.gen(function* () {
      const { port } = yield* setup();
      for (const p of [
        "/weekly/",
        "/weekly?x=1",
        "/api/weekly/",
        "/daily",
        "/data/ritual.sqlite3",
        "/../AGENTS.md",
        "/%2e%2e/config/dashboard-server.json",
        "/?download=1",
        "/evidence/",
        "//data/ritual.sqlite3",
        "/api/rituals",
      ]) {
        expect((yield* request(port, { path: p })).status, p).toBe(404);
      }
      for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE"]) {
        const reply = yield* request(port, { method });
        expect(reply.status, method).toBe(405);
        expect(reply.headers.allow).toBe("GET, HEAD");
      }
      // Node's HTTP client turns any answer to CONNECT into a tunnel event, so read that one off the wire.
      const connect = yield* raw(
        port,
        `CONNECT / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nTailscale-User-Login: ${OWNER}\r\n\r\n`,
      );
      expect(connect.split("\r\n")[0]).toContain("405");
      expect(connect).toContain("Allow: GET, HEAD");
    }),
  );

  it.effect("HEAD, Host and body handling", () =>
    Effect.gen(function* () {
      const { port } = yield* setup();
      const head = yield* request(port, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(head.body.length).toBe(0);
      expect(Number(head.headers["content-length"])).toBeGreaterThan(0);
      expect((yield* request(port, { headers: { Host: "attacker.invalid" } })).status).toBe(400);
      const withBody = yield* raw(
        port,
        `GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nTailscale-User-Login: ${OWNER}\r\nContent-Length: 8\r\n\r\n`,
      );
      expect(withBody.split("\r\n")[0]).toContain("400");
    }),
  );

  it.effect("a Tailscale Serve path mount changes nothing the server checks", () =>
    Effect.gen(function* () {
      const { port } = yield* setup();
      // What Serve sent for https://host/rituals/... on Tailscale 1.104: the mount stripped from the path (/rituals and
      // /rituals/ both arrive as /), the original Host, and these extra headers, from loopback.
      const forwarded = {
        Host: HOSTNAME,
        "Tailscale-Headers-Info": "https://tailscale.com/s/serve-headers",
        "Tailscale-User-Name": "Fictional Owner",
        "Tailscale-User-Profile-Pic": "https://example.invalid/pic.png",
        "X-Forwarded-For": "100.64.0.1",
        "X-Forwarded-Host": HOSTNAME,
        "X-Forwarded-Proto": "https",
      };
      for (const p of ["/", "/weekly", "/api/dashboard", "/api/weekly"]) {
        expect((yield* request(port, { path: p, headers: forwarded })).status, p).toBe(200);
        expect((yield* request(port, { path: p, headers: forwarded, identity: "other@example.invalid" })).status).toBe(
          403,
        );
        expect((yield* request(port, { path: p, headers: forwarded, identity: null })).status).toBe(403);
        expect((yield* request(port, { path: p, headers: forwarded, method: "POST" })).status).toBe(405);
      }
      // The server never serves the mount itself; only Serve's stripping maps it.
      for (const p of ["/rituals", "/rituals/", "/rituals/weekly", "/rituals/api/dashboard"])
        expect((yield* request(port, { path: p, headers: forwarded })).status, p).toBe(404);
      // A mount on another HTTPS port is not an approved Host.
      expect((yield* request(port, { headers: { ...forwarded, Host: HOSTNAME + ":8444" } })).status).toBe(400);
    }),
  );

  it.effect("fresh data and no database or snapshot writes", () =>
    Effect.gen(function* () {
      const { root, store, port } = yield* setup();
      expect(JSON.parse((yield* request(port, { path: "/api/dashboard" })).body.toString()).count).toBe(0);
      yield* store.request({
        op: "ritual_put",
        date: "2026-09-27",
        patch: { protein: true },
        request_id: "isolated-server-test",
        source_text: "Test fixture only",
      });
      const database = path.join(root, "data", "ritual.sqlite3");
      const before = fileSha(database);
      const reply = yield* request(port, { path: "/api/dashboard" });
      expect(reply.status).toBe(200);
      expect(reply.body.toString()).toContain("Sun · Sep 27");
      expect(fileSha(database)).toBe(before);
      expect(fs.existsSync(path.join(root, "data", "views"))).toBe(false);
      const page = (yield* request(port)).body.toString();
      expect(page).toContain("width=device-width");
      expect(page).toContain("@media(max-width:760px)");
      expect(page).toContain("overflow:auto");
      expect(page).toContain("position:sticky");
    }),
  );

  it.effect("weekly page and answers-only API", () =>
    Effect.gen(function* () {
      const { root, store, port } = yield* setup();
      const page = yield* request(port, { path: "/weekly" });
      expect(page.status).toBe(200);
      expect(page.body.toString()).toContain("<title>Weekly review</title>");
      expect(page.headers["content-type"]).toBe("text/html; charset=utf-8");
      expect(JSON.parse((yield* request(port, { path: "/api/weekly" })).body.toString()).count).toBe(0);
      yield* store.request({
        op: "ritual_put",
        date: "2026-09-27",
        patch: { notes: "Fictional private note" },
        request_id: "isolated-note",
        source_text: "Test fixture only",
      });
      yield* store.request({
        op: "weekly_put",
        week_start: "2026-09-21",
        answer: "Fictional weekly answer",
        request_id: "isolated-weekly",
        source_text: "Test fixture only",
      });
      const api = yield* request(port, { path: "/api/weekly" });
      expect([api.status, api.headers["content-type"]]).toEqual([200, "application/json; charset=utf-8"]);
      const body = api.body.toString();
      expect(JSON.parse(body).weeks.map((w: any) => w.answer)).toEqual(["Fictional weekly answer"]);
      expect(body).not.toContain("Fictional private");
      expect(body).not.toContain("Test fixture");
      expect((yield* request(port, { path: "/api/dashboard" })).body.toString()).not.toContain("Fictional private");
      expect(fs.existsSync(path.join(root, "data", "views"))).toBe(false);
    }),
  );

  it.effect("weekly errors do not leak local data", () =>
    Effect.gen(function* () {
      const { port } = yield* setup({
        weeklyRenderer: () => Effect.die(new Error("private weekly answer and local path")),
      });
      const reply = yield* request(port, { path: "/api/weekly" });
      expect(reply.status).toBe(503);
      expect(reply.body.toString()).not.toContain("private");
    }),
  );

  it.effect("database is opened read-only", () =>
    Effect.gen(function* () {
      const { root, port } = yield* setup();
      const error = yield* Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* readOnlyClient(root);
          return yield* sql.unsafe("CREATE TABLE unauthorized_write(x)").pipe(Effect.flip);
        }),
      );
      expect(error._tag).toBe("SqlError");
      expect((yield* request(port, { path: "/api/dashboard" })).status).toBe(200);
      expect((yield* request(port, { path: "/api/weekly" })).status).toBe(200);
    }),
  );

  it.effect("errors do not leak local data", () =>
    Effect.gen(function* () {
      const { root, port } = yield* setup({
        renderer: () => Effect.die(new Error("private raw health source and local path")),
      });
      const reply = yield* request(port, { path: "/api/dashboard" });
      expect(reply.status).toBe(503);
      expect(reply.body.toString()).not.toContain("private");
      expect(reply.body.toString()).not.toContain(root);
    }),
  );

  it.effect("configuration fails closed", () =>
    Effect.gen(function* () {
      const root = yield* tempDirectory;
      const file = path.join(root, "config.json");
      const good = { listen_host: "127.0.0.1", listen_port: 8765, tailscale_hostname: HOSTNAME, owner_login: OWNER };
      fs.writeFileSync(file, JSON.stringify(good));
      expect(yield* loadConfig(file)).toEqual(good);
      for (const [key, value] of [
        ["listen_host", "0.0.0.0"],
        ["listen_port", 80],
        ["owner_login", ""],
        ["tailscale_hostname", "public.example"],
      ] as const) {
        fs.writeFileSync(file, JSON.stringify({ ...good, [key]: value }));
        expect((yield* loadConfig(file).pipe(Effect.flip))._tag).toBe("InvalidConfig");
      }
    }),
  );
});
