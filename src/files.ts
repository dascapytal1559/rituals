// Durable file writes: write to a sibling temporary file, fsync it, then publish it in one step
// and fsync the directory, so a crash never leaves a half-written snapshot or queue entry.
import { Effect, FileSystem } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

const encoder = new TextEncoder();

export const randomName = (prefix: string): string => prefix + randomBytes(6).toString("hex");

export const isAlreadyExists = (error: PlatformError): boolean => error.reason._tag === "AlreadyExists";

export const isNotFound = (error: PlatformError): boolean => error.reason._tag === "NotFound";

/** Create the file if it is missing (like opening it for append), with the given mode. */
export const ensureFile = (path: string, mode: number): Effect.Effect<void, PlatformError, FileSystem.FileSystem> =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.open(path, { flag: "a", mode });
    }),
  );

export const fsyncDirectory = (directory: string): Effect.Effect<void, PlatformError, FileSystem.FileSystem> =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const handle = yield* fs.open(directory, { flag: "r" });
      yield* handle.sync;
    }),
  );

/**
 * Write `content` to `target` atomically. With `noReplace`, an existing target is left alone and
 * the failure carries an `AlreadyExists` reason (Python's os.link raising FileExistsError).
 */
export const atomicWrite = (
  target: string,
  content: string,
  options: { readonly prefix: string; readonly noReplace?: boolean },
): Effect.Effect<void, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const folder = dirname(target);
    const temporary = join(folder, randomName(options.prefix));
    yield* Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const file = yield* fs.open(temporary, { flag: "wx", mode: 0o600 });
          yield* file.writeAll(encoder.encode(content));
          yield* file.sync;
        }),
      );
      yield* options.noReplace ? fs.link(temporary, target) : fs.rename(temporary, target);
      yield* fsyncDirectory(folder);
    }).pipe(Effect.ensuring(fs.remove(temporary, { force: true }).pipe(Effect.ignore)));
  });
