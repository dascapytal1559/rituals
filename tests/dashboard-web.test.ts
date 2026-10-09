import { describe, expect, it } from "vitest";
import { Result } from "effect";
import type { ExceptionRow } from "../src/applicability.ts";
import type { Records } from "../src/dashboard.ts";
import * as dashboardWeb from "../src/dashboardWeb.ts";
import { parseDateTime } from "../src/instants.ts";
import { count } from "./helpers/html.ts";

const at = (text: string) => Result.getOrThrow(parseDateTime(text)).micros;
const fixture = (exceptions: ReadonlyArray<ExceptionRow> = []): Records => ({
  rituals: [
    { date: "2026-10-03", magnesium: null, protein: null, stretching: null, journalling: null, plank_seconds: null },
    { date: "2026-10-04", magnesium: 1, protein: 0, stretching: 1, journalling: null, plank_seconds: 60 },
  ],
  workouts: [
    { id: "a", date: "2026-10-03", type: "run" },
    { id: "b", date: "2026-10-03", type: "gym pull" },
  ],
  exceptions,
});
const data = (records: Records, stamp: string) => Result.getOrThrow(dashboardWeb.dashboardData(records, at(stamp)));

describe("dashboard web", () => {
  it("only the dashboard projection is returned", () => {
    const result = data(fixture(), "2026-10-05T12:00:00+11:00");
    expect(new Set(Object.keys(result))).toEqual(
      new Set(["generated_at", "updated_display", "timezone", "count", "rates", "rows"]),
    );
    expect(new Set(Object.keys(result.rows[0]!))).toEqual(
      new Set(["date", "display_date", "full_date", "period", "annotation", "cells", "workouts", "checkin_times"]),
    );
    const forbidden = new Set([
      "notes",
      "checkins",
      "source_text",
      "sources",
      "source_documents",
      "raw",
      "revision",
      "request_id",
      "details",
      "exception_id",
    ]);
    const check = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(check);
      else if (typeof value === "object" && value !== null) {
        for (const key of Object.keys(value)) expect(forbidden.has(key)).toBe(false);
        Object.values(value).forEach(check);
      }
    };
    check(result);
    expect(result.rates.workout).toEqual({ done: 1, denominator: 2, percentage: 50 });
    expect(result.rows[1]!.workouts.count).toBe(2);
  });

  it("noon and DST are computed on each request", () => {
    const before = data(fixture(), "2026-10-04T11:59:59+11:00");
    const after = data(fixture(), "2026-10-04T12:00:00+11:00");
    expect(before.rows[1]!.period).toBe("open");
    expect(before.rows[1]!.cells.magnesium.status).toBe("unreported");
    expect(before.rates.workout!.percentage).toBeNull();
    expect(after.rows[1]!.period).toBe("closed");
    expect(after.rows[1]!.cells.magnesium.status).toBe("not_done");
    expect(after.rates.workout!.percentage).toBe(100);
  });

  it("exceptions and open days stay out of the denominator", () => {
    const exceptions: Array<ExceptionRow> = [
      { id: "example", habit: "magnesium", start_date: "2026-10-03", end_date: "2026-10-03", reason: "Test" },
    ];
    const result = data(fixture(exceptions), "2026-10-04T12:00:00+11:00");
    expect(result.rows[1]!.cells.magnesium.status).toBe("not_applicable");
    expect(result.rates.magnesium!.percentage).toBeNull();
  });

  it("frontend has no record data or unsafe HTML sink", () => {
    for (const [ritual, name, url] of [
      ["daily", "Daily rituals", "api/dashboard"],
      ["weekly", "Weekly review", "api/weekly"],
    ] as const) {
      const page = dashboardWeb.frontend(ritual);
      expect(page).toContain(`load('${url}', render)`);
      expect(page).toContain("connect-src &#x27;self&#x27;");
      expect(page).toContain(dashboardWeb.scriptHash(dashboardWeb.SCRIPTS[ritual]));
      expect(dashboardWeb.SCRIPTS[ritual]).not.toContain("innerHTML");
      expect(page).toContain(`<h1>${name}</h1>`);
      expect(page).toContain(`<title>${name}</title>`);
      expect(count(page, "<select")).toBe(1);
      expect(page).toContain(
        '<option value="./"' +
          (ritual === "daily" ? " selected" : "") +
          '>Daily rituals</option><option value="weekly"' +
          (ritual === "weekly" ? " selected" : "") +
          ">Weekly review</option>",
      );
      expect(page).not.toContain("2026-");
    }
    expect(dashboardWeb.frontend("daily")).toContain("Date<span");
    expect(dashboardWeb.frontend("weekly")).toContain("Done this week");
  });

  it("live pages resolve every address relative to where they are mounted", () => {
    // Tailscale Serve strips a path mount (/rituals) before proxying, so the server sees / either way; a root-anchored
    // link, fetch or redirect in the page would leave the mount.
    for (const ritual of ["daily", "weekly"] as const) {
      const page = dashboardWeb.frontend(ritual);
      expect(page.match(/(?:value|href|src|action)="[^"]*"/g)).toEqual(['value="./"', 'value="weekly"']);
      expect(page).not.toMatch(/['"`]\/(?:api|weekly)/);
      expect(page).not.toContain("location.href");
    }
    // Only the base page adds its missing trailing slash, before its first relative fetch.
    const daily = dashboardWeb.SCRIPTS.daily;
    expect(daily.startsWith("if (!location.pathname.endsWith('/')) history.replaceState(")).toBe(true);
    expect(daily.indexOf("history.replaceState")).toBeLessThan(daily.indexOf("load('api/dashboard'"));
    expect(dashboardWeb.SCRIPTS.weekly).not.toContain("history");
  });
});
