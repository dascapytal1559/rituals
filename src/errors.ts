// Every failure the store, client, dashboard and service code can report, as tagged errors.
// Python raised ValueError/RuntimeError/OSError and the CLIs mapped those to JSON; here each
// kind is a class so callers match on `_tag` and nothing is caught by accident.
import { Data } from "effect";

/** A request or record was rejected and needs a person or agent to review it (Python: ValueError). */
export class RequiresReview extends Data.TaggedError("RequiresReview")<{ readonly message: string }> {}

/** A positive report meets an applicability exception for the same habit and day. */
export class ApplicabilityConflict extends Data.TaggedError("ApplicabilityConflict")<{ readonly message: string }> {}

/** The authoritative database cannot be used right now; the request may be queued and replayed. */
export class StorageUnavailable extends Data.TaggedError("StorageUnavailable")<{ readonly message: string }> {}

/** The private dashboard configuration is missing a required shape or value. */
export class InvalidConfig extends Data.TaggedError("InvalidConfig")<{ readonly message: string }> {}

/** The launchd service could not be inspected or changed safely (Python: RuntimeError). */
export class ServiceError extends Data.TaggedError("ServiceError")<{ readonly message: string }> {}

/** Shorthand for the Python `fail(message)` helper. */
export const reject = (message: string): RequiresReview => new RequiresReview({ message });

const tagOf = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "_tag" in error
    ? String((error as { _tag: unknown })._tag)
    : undefined;

/**
 * The one-line text a CLI prints for an error: SQLite's own message for SQL errors, the system
 * call's message for file errors, otherwise the error's message.
 */
export const describe = (error: unknown): string => {
  if (tagOf(error) === "SqlError" || tagOf(error) === "PlatformError") {
    const reason = (error as { reason?: { cause?: unknown; message?: string } }).reason;
    if (reason?.cause instanceof Error) return reason.cause.message;
    if (typeof reason?.message === "string") return reason.message;
  }
  if (error instanceof Error) return error.message;
  return String(error);
};
