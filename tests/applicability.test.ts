import { describe, expect, it } from "vitest";
import { Result } from "effect";
import { DatabaseSync } from "node:sqlite";
import {
  completion,
  derive,
  TABLE_SQL,
  validateException,
  type Cell,
  type ExceptionRow,
} from "../src/applicability.ts";

const TRAVEL: ExceptionRow = {
  id: "example-travel",
  habit: "protein",
  start_date: "2026-09-17",
  end_date: "2026-09-24",
  reason: "Travel",
};
const PLANK: ExceptionRow = {
  id: "example-prestart",
  habit: "planks",
  start_date: null,
  end_date: "2026-09-16",
  reason: "Not started",
};

const cell = (...args: Parameters<typeof derive>): Cell => Result.getOrThrow(derive(...args));
const failure = (result: Result.Result<unknown, { _tag: string }>): string => {
  if (Result.isSuccess(result)) throw new Error("expected a failure");
  return result.failure._tag;
};

describe("applicability", () => {
  it("inclusive travel boundaries", () => {
    expect(
      ["2026-09-16", "2026-09-17", "2026-09-24", "2026-09-25"].map(
        (d) => cell("protein", d, null, [TRAVEL], "2026-09-30").status,
      ),
    ).toEqual(["not_done", "not_applicable", "not_applicable", "not_done"]);
  });
  it("prestart null bound and first day", () => {
    expect(cell("planks", "2026-08-23", null, [PLANK], "2026-10-01").status).toBe("not_applicable");
    expect(cell("planks", "2026-09-17", 67, [PLANK], "2026-10-01").status).toBe("done");
  });
  it("positive unknown-duration source conflict stops", () => {
    for (const day of ["2026-09-15", "2026-09-16"]) {
      expect(failure(derive("planks", day, null, [PLANK], "2026-10-01", true))).toBe("ApplicabilityConflict");
    }
  });
  it("explicit positive exception conflict stops", () => {
    expect(failure(derive("protein", "2026-09-17", true, [TRAVEL], "2026-10-01"))).toBe("ApplicabilityConflict");
  });
  it("missing closed is derived without mutating raw", () => {
    const c = cell("protein", "2026-09-16", null, [], "2026-09-30");
    expect(c.raw).toBeNull();
    expect(c.basis).toBe("missing_after_close");
  });
  it("open day and future are not counted as failures", () => {
    const cells = ["2026-10-01", "2026-10-02"].map((d) => cell("protein", d, null, [], "2026-09-30"));
    expect(cells.every((x) => x.status === "unreported")).toBe(true);
    expect(completion(cells)).toEqual({ done: 0, applicable: 0, percentage: null });
  });
  it("late report recomputes status", () => {
    const before = cell("journalling", "2026-09-17", null, [], "2026-10-01");
    const after = cell("journalling", "2026-09-17", true, [], "2026-10-01");
    expect([before.status, after.status]).toEqual(["not_done", "done"]);
  });
  it("N/A is excluded from both numerator and denominator", () => {
    const cells = [
      cell("protein", "2026-09-17", null, [TRAVEL], "2026-09-30"),
      cell("protein", "2026-09-25", false, [TRAVEL], "2026-09-30"),
      cell("protein", "2026-09-26", true, [TRAVEL], "2026-09-30"),
    ];
    expect(completion(cells)).toEqual({ done: 1, applicable: 2, percentage: 50 });
  });
  it("no applicable days returns no percentage", () => {
    expect(completion([cell("protein", "2026-09-17", null, [TRAVEL], "2026-09-30")]).percentage).toBeNull();
  });
  it("duplicate id and overlap guards", () => {
    const travel = TRAVEL as unknown as Record<string, unknown>;
    expect(Result.getOrThrow(validateException(travel, [travel]))).toBe("replayed");
    expect(Result.isFailure(validateException({ ...travel, reason: "Different" }, [travel]))).toBe(true);
    expect(Result.isFailure(validateException({ ...travel, id: "second", start_date: "2026-09-24" }, [travel]))).toBe(
      true,
    );
    expect(
      Result.getOrThrow(
        validateException({ ...travel, id: "later", start_date: "2026-09-25", end_date: "2026-09-26" }, [travel]),
      ),
    ).toBe("new");
    expect(Result.getOrThrow(validateException({ ...travel, id: "magnesium", habit: "magnesium" }, [travel]))).toBe(
      "new",
    );
  });
  it("minimal table in isolated memory", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(TABLE_SQL);
    expect(
      (db.prepare("PRAGMA table_info(applicability_exceptions)").all() as Array<{ name: string }>).map((r) => r.name),
    ).toEqual(["id", "habit", "start_date", "end_date", "reason"]);
    db.close();
  });
});
