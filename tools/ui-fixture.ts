// Fictional pages and API payloads for tests/check_ui.cjs: no database, no network.
import { Result } from "effect";
import { statusReport } from "../src/applicability.ts";
import * as dashboard from "../src/dashboard.ts";
import * as web from "../src/dashboardWeb.ts";
import { parseDateTime } from "../src/instants.ts";

const rituals = [
  {
    date: "2026-10-03",
    checkins: ["2026-10-03T12:12:00Z"],
    magnesium: null,
    protein: true,
    stretching: true,
    journalling: null,
    plank_seconds: 80,
  },
];
const workouts = [{ id: "fictional", date: "2026-10-03", type: "gym push" }];
const stamp = Result.getOrThrow(parseDateTime("2026-10-04T13:00:00+11:00")).micros;
const weeks = [
  {
    week_start: "2026-09-28",
    answer:
      "Fictional: wrote the plan\nFictional: a second line that is long enough to wrap on a phone screen without any sideways scrolling",
  },
  { week_start: "2026-09-21", answer: "Fictional quiet week" },
];
const records = { rituals, workouts, exceptions: [] };
const report = Result.getOrThrow(statusReport(rituals, workouts, [], stamp));

process.stdout.write(
  JSON.stringify({
    api: { dashboard: Result.getOrThrow(web.dashboardData(records, stamp)), weekly: web.weeklyData(weeks, stamp) },
    live: { daily: web.frontend("daily"), weekly: web.frontend("weekly") },
    static: {
      daily: Result.getOrThrow(dashboard.render(dashboard.matrix(rituals, workouts), stamp, report)),
      weekly: dashboard.renderWeekly(weeks, stamp),
    },
  }),
);
