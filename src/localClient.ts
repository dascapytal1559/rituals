// Local-only ritual entrypoint and durable replay queue. No network access.
import { Cause, Effect, FileSystem, Option } from "effect";
import type { PlatformError } from "effect/PlatformError";
import type { SqlError } from "effect/sql/SqlError";
import { basename, dirname, join } from "node:path";
import { generate } from "./dashboard.ts";
import { dumps, isRecord, pack, sha } from "./encoding.ts";
import { describe, type RequiresReview, reject, StorageUnavailable } from "./errors.ts";
import { atomicWrite, isAlreadyExists, isNotFound } from "./files.ts";
import { compactStamp, isoformatUtc, nowMicros } from "./instants.ts";
import { withFileLock } from "./locks.ts";
import { openStore, type Row, type StoreError, WRITES } from "./store.ts";

import { ROOT } from "./root.ts";

export type ClientError = StoreError | StorageUnavailable;

const MISSING = "Authoritative Mac database is unavailable; no empty replacement was created";
const REFRESHES: ReadonlySet<string> = new Set([
  ...WRITES,
  "import",
  "restore",
  "ritual_status",
  "ritual_checklist",
  "reminders",
]);
const SAVES: ReadonlySet<string> = new Set([...WRITES, "import", "restore"]);
const STORAGE_PROBLEMS = ["locked", "unable to open", "disk i/o", "readonly", "full"];

const databasePath = (root: string): string => join(root, "data", "ritual.sqlite3");

/** The authoritative database must already exist: a missing file is never replaced by an empty one. */
const requireDatabase = (
  root: string,
): Effect.Effect<void, StorageUnavailable | PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const info = yield* fs
      .stat(databasePath(root))
      .pipe(Effect.catchIf(isNotFound, () => Effect.fail(new StorageUnavailable({ message: MISSING }))));
    if (info.type !== "File") return yield* Effect.fail(new StorageUnavailable({ message: MISSING }));
  });

/** SQLite "operational" failures mean the store is unavailable rather than the request wrong. */
const asStorageUnavailable = (error: SqlError): Effect.Effect<never, SqlError | StorageUnavailable> => {
  const tag = error.reason._tag;
  const message = describe(error);
  if (
    tag !== "UniqueViolation" &&
    tag !== "ConstraintError" &&
    STORAGE_PROBLEMS.some((x) => message.toLowerCase().includes(x))
  ) {
    return Effect.fail(new StorageUnavailable({ message }));
  }
  return Effect.fail(error);
};

/** Append the snapshot result; a view failure must never turn a successful save into an apparent failure. */
const withDashboard = (root: string, result: Row, recordSaved: boolean) =>
  generate(root).pipe(
    Effect.map((dashboard) => ({ ...result, dashboard })),
    Effect.catchCause((cause) =>
      Effect.succeed({
        ...result,
        dashboard: { updated: false, error: describe(Cause.squash(cause)), record_saved: recordSaved },
      }),
    ),
  );

export const call = (
  request: unknown,
  root: string = ROOT,
): Effect.Effect<unknown, ClientError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    yield* requireDatabase(root);
    const result = yield* Effect.scoped(
      Effect.gen(function* () {
        const store = yield* openStore(join(root, "data"));
        return yield* store.request(request);
      }),
    ).pipe(Effect.catchTag("SqlError", asStorageUnavailable));
    const op = isRecord(request) ? String(request.op) : "";
    if (!REFRESHES.has(op)) return result;
    // The record is already committed. A view failure must never turn a successful save into an
    // apparent failure or trigger an offline retry.
    return yield* withDashboard(root, result as Row, SAVES.has(op));
  });

/** Create a new empty store, explicitly and once; an existing database is never touched. */
export const init = (root: string = ROOT): Effect.Effect<unknown, ClientError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const database = databasePath(root);
    const present = (yield* fs.exists(database)) || (yield* fs.readLink(database).pipe(Effect.isSuccess));
    if (present) return yield* Effect.fail(reject("A database already exists; --init only creates a new empty store"));
    yield* Effect.scoped(openStore(dirname(database)));
    return yield* call({ op: "status" }, root);
  });

/** Apply the reviewed schema migration once, after its own backup; then refresh the views. */
export const migrate = (root: string = ROOT): Effect.Effect<unknown, ClientError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    yield* requireDatabase(root);
    const result = yield* Effect.scoped(
      Effect.gen(function* () {
        const store = yield* openStore(join(root, "data"));
        return yield* store.migrate;
      }),
    );
    return yield* withDashboard(root, result as unknown as Row, true);
  });

export const atomicJson = (
  path: string,
  value: unknown,
  noReplace = false,
): Effect.Effect<void, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(dirname(path), { recursive: true, mode: 0o700 });
    yield* atomicWrite(path, dumps(value, 2) + "\n", { prefix: ".pending-", noReplace });
  });

const codePointLength = (value: string): number => Array.from(value).length;

export interface Queued {
  readonly status: "queued_on_mac";
  readonly database_confirmed: false;
  readonly request_id: string;
  readonly pending_file: string;
}

export const enqueue = (
  request: unknown,
  root: string = ROOT,
): Effect.Effect<Queued, RequiresReview | PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (!isRecord(request) || !WRITES.has(String(request.op))) {
      return yield* Effect.fail(reject("Only a prepared write can be queued; offline reads must remain unavailable"));
    }
    const rid = request.request_id;
    if (typeof rid !== "string" || rid === "" || codePointLength(rid) > 180) {
      return yield* Effect.fail(reject("A stable request_id up to 180 characters is required"));
    }
    if (typeof request.source_text !== "string" || request.source_text.trim() === "") {
      return yield* Effect.fail(
        reject("Original source words, receipt time and interpretation are required in source_text"),
      );
    }
    const path = join(root, "queue", "pending", sha(rid) + ".json");
    const payload = { request, queued_at: isoformatUtc(yield* nowMicros) };
    yield* atomicJson(path, payload, true).pipe(
      Effect.catchIf(isAlreadyExists, () =>
        Effect.gen(function* () {
          const existing = JSON.parse(yield* fs.readFileString(path)) as { request: unknown };
          if (pack(existing.request) !== pack(request)) {
            return yield* Effect.fail(reject("Queued request_id already has different content"));
          }
        }),
      ),
    );
    return { status: "queued_on_mac", database_confirmed: false, request_id: rid, pending_file: path };
  });

export const submit = (
  request: unknown,
  root: string = ROOT,
  queueOnFailure = false,
): Effect.Effect<unknown, ClientError, FileSystem.FileSystem> =>
  call(request, root).pipe(
    Effect.catchTag("StorageUnavailable", (error): Effect.Effect<unknown, ClientError, FileSystem.FileSystem> =>
      queueOnFailure ? enqueue(request, root) : Effect.fail(error),
    ),
  );

interface Pending {
  readonly path: string;
  readonly payload: { readonly request: Row; readonly queued_at: string };
}

const pendingEntries = (root: string): Effect.Effect<Array<Pending>, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const folder = join(root, "queue", "pending");
    const names = yield* fs.readDirectory(folder).pipe(Effect.catchIf(isNotFound, () => Effect.succeed([])));
    const entries: Array<Pending> = [];
    for (const name of names.filter((n) => n.endsWith(".json")).toSorted()) {
      const path = join(folder, name);
      entries.push({ path, payload: JSON.parse(yield* fs.readFileString(path)) as Pending["payload"] });
    }
    return entries;
  });

export interface ReplaySynced {
  readonly request_id: unknown;
  readonly replayed: unknown;
  readonly revision: unknown;
}

export type ReplayResult =
  | { readonly status: "replay_already_running"; readonly synced: ReadonlyArray<never> }
  | { readonly status: "complete"; readonly synced: ReadonlyArray<ReplaySynced>; readonly remaining: 0 }
  | {
      readonly status: "blocked";
      readonly synced: ReadonlyArray<ReplaySynced>;
      readonly remaining: number;
      readonly blocked_request_id: unknown;
      readonly error: string;
      readonly requires_review: boolean;
    };

/** Apply queued writes in queue order, stopping at the first one that needs review. */
export const replay = (
  root: string = ROOT,
): Effect.Effect<ReplayResult, PlatformError | SqlError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const queue = join(root, "queue");
    yield* fs.makeDirectory(queue, { recursive: true, mode: 0o700 });
    const lock = join(queue, ".replay.lock");
    const outcome = yield* withFileLock(
      lock,
      false,
      Effect.gen(function* () {
        const entries = (yield* pendingEntries(root)).toSorted((a, b) => {
          const byTime =
            a.payload.queued_at < b.payload.queued_at ? -1 : a.payload.queued_at > b.payload.queued_at ? 1 : 0;
          if (byTime !== 0) return byTime;
          const an = basename(a.path);
          const bn = basename(b.path);
          return an < bn ? -1 : an > bn ? 1 : 0;
        });
        const synced: Array<ReplaySynced> = [];
        for (const { path, payload } of entries) {
          const req = payload.request;
          const attempt = yield* call(req, root).pipe(Effect.result);
          if (attempt._tag === "Failure") {
            const error = attempt.failure;
            if (error._tag === "PlatformError") return yield* Effect.fail(error);
            const remaining = (yield* pendingEntries(root)).length;
            return {
              status: "blocked" as const,
              synced,
              remaining,
              blocked_request_id: req.request_id,
              error: describe(error),
              requires_review: error._tag !== "StorageUnavailable",
            };
          }
          const result = attempt.success as Row;
          const stamp = compactStamp(yield* nowMicros, true);
          const sent = join(queue, "sent");
          yield* fs.makeDirectory(sent, { recursive: true, mode: 0o700 });
          const stem = basename(path, ".json");
          yield* atomicJson(join(sent, `${stem}-${stamp}-receipt.json`), {
            request_id: req.request_id,
            applied_at: stamp,
            result,
          });
          yield* fs.rename(path, join(sent, `${stem}-${stamp}-request.json`));
          synced.push({
            request_id: req.request_id,
            replayed: result.replayed ?? false,
            revision: result.revision ?? null,
          });
        }
        return { status: "complete" as const, synced, remaining: 0 as const };
      }),
    );
    return Option.getOrElse(outcome, () => ({ status: "replay_already_running" as const, synced: [] }));
  });

export const queueStatus = (root: string = ROOT) =>
  Effect.map(pendingEntries(root), (entries) => ({
    pending_count: entries.length,
    request_ids: entries.map((e) => e.payload.request.request_id),
  }));
