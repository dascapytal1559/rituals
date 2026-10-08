// Cooperative edit ownership. Does not lock ordinary ritual writes.
import { Effect, FileSystem } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { rmdirSync } from "node:fs";
import { join } from "node:path";
import { dumps } from "./encoding.ts";
import { type RequiresReview, reject } from "./errors.ts";
import { isAlreadyExists } from "./files.ts";
import { isoformatUtc, nowMicros } from "./instants.ts";

export type Claim = Record<string, unknown>;

const encoder = new TextEncoder();

export const act = (
  args: ReadonlyArray<string>,
  root: string,
): Effect.Effect<Claim, RequiresReview | PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const claim = join(root, ".agent-work");
    const ownerFile = join(claim, "owner.json");
    const readOwner = fs
      .readFileString(ownerFile)
      .pipe(Effect.flatMap((text) => Effect.try(() => JSON.parse(text) as Claim)));
    if (args.length === 1 && args[0] === "status") {
      if (!(yield* fs.exists(claim))) return { claimed: false };
      return yield* readOwner.pipe(
        Effect.map((owner) => ({ claimed: true, ...owner })),
        Effect.catchCause(() => Effect.succeed({ claimed: true, requires_review: true })),
      );
    }
    if (args.length === 3 && args[0] === "claim") {
      const [, owner, scope] = args as [string, string, string];
      if (owner.trim() === "" || scope.trim() === "" || owner.length > 180 || scope.length > 500) {
        return yield* Effect.fail(reject("Nonempty owner/scope within 180/500 characters required"));
      }
      // Atomic directory creation selects one cooperating editor.
      yield* fs
        .makeDirectory(claim, { mode: 0o700 })
        .pipe(
          Effect.catchIf(isAlreadyExists, () =>
            Effect.fail(reject("Edit work already claimed; inspect status and coordinate")),
          ),
        );
      const payload = { owner, scope, started_at: isoformatUtc(yield* nowMicros) };
      // Do not remove ownership after an ambiguous partial failure.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const file = yield* fs.open(ownerFile, { flag: "wx", mode: 0o600 });
          yield* file.writeAll(encoder.encode(dumps(payload, 2) + "\n"));
          yield* file.sync;
        }),
      );
      yield* fs.chmod(ownerFile, 0o600);
      return { claimed: true, ...payload };
    }
    if (args.length === 2 && args[0] === "release") {
      const payload = yield* readOwner.pipe(
        Effect.catchTag("UnknownError", (e) => Effect.fail(reject(String(e.cause)))),
      );
      if (payload.owner !== args[1]) {
        return yield* Effect.fail(reject("Only the recorded owner can release; coordinate stale claims"));
      }
      const entries = yield* fs.readDirectory(claim);
      if (entries.length !== 1 || entries[0] !== "owner.json") {
        return yield* Effect.fail(reject("Unexpected claim files; review before release"));
      }
      yield* fs.remove(ownerFile);
      // rmdir, not a recursive remove: anything that appeared meanwhile must stop the release.
      yield* Effect.try({ try: () => rmdirSync(claim), catch: (error) => reject((error as Error).message) });
      return { claimed: false, released: args[1] };
    }
    return yield* Effect.fail(reject("Usage: ritual-agent status | claim OWNER SCOPE | release OWNER"));
  });
