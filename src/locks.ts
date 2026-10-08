// Cross-process exclusive locks without flock, which Node does not expose.
//
// SQLite's own file locking is a POSIX advisory lock that the operating system releases when the
// holder exits, which is exactly what Python's fcntl.flock gave the replay and snapshot writers.
// The lock file is opened as a (tiny) SQLite database and `BEGIN IMMEDIATE` takes its write lock.
import { Effect, Option } from "effect";
import type { SqlError } from "effect/sql/SqlError";
import * as Reactivity from "effect/reactivity/Reactivity";
import { SqliteClient } from "@effect/sql-sqlite-node";

const isLockTimeout = (error: SqlError): boolean => error.reason._tag === "LockTimeoutError";

/**
 * Run `effect` while holding the exclusive lock on `path`. With `wait`, block until it is free
 * (flock LOCK_EX); without, give up immediately and return `None` (LOCK_EX | LOCK_NB).
 */
export const withFileLock = <A, E, R>(
  path: string,
  wait: boolean,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<Option.Option<A>, E | SqlError, R> =>
  Effect.scoped(
    Effect.gen(function* () {
      const lock = yield* SqliteClient.make({
        filename: path,
        disableWAL: true,
        busyTimeout: wait ? "1 hour" : 0,
      }).pipe(Effect.provide(Reactivity.layer));
      const acquired = yield* lock.unsafe("BEGIN IMMEDIATE").pipe(
        Effect.as(true),
        Effect.catchIf(isLockTimeout, () => Effect.succeed(false)),
      );
      if (!acquired) return Option.none();
      return yield* effect.pipe(Effect.map(Option.some), Effect.ensuring(lock.unsafe("ROLLBACK").pipe(Effect.ignore)));
    }),
  );
