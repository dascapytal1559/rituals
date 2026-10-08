import { expect, layer } from "@effect/vitest";
import { Effect, Result } from "effect";
import { NodeServices } from "@effect/platform-node";
import * as fs from "node:fs";
import * as path from "node:path";
import { statusReport } from "../src/applicability.ts";
import * as dashboard from "../src/dashboard.ts";
import { parseDateTime } from "../src/instants.ts";
import { call, submit } from "../src/localClient.ts";
import { openStore } from "../src/store.ts";
import { fileSha, listFiles, mode, tempDirectory } from "./helpers/fixtures.ts";
import { count, workoutTitle } from "./helpers/html.ts";

const at = (text: string) => Result.getOrThrow(parseDateTime(text)).micros;
const now = () => Date.now() * 1000;
const render = (rows: ReadonlyArray<dashboard.MatrixRow>, stamp: number, report?: any) =>
  Result.getOrThrow(dashboard.render(rows, stamp, report));
const blank = (date: string) => ({
  date,
  magnesium: null,
  protein: null,
  stretching: null,
  journalling: null,
  plank_seconds: null,
});

layer(NodeServices.layer, { excludeTestServices: true })("dashboard", (it) => {
  it.effect("isolated database matches matrix without writing", () =>
    Effect.gen(function* () {
      const root = yield* tempDirectory;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const store = yield* openStore(path.join(root, "data"));
          yield* store.request({
            op: "ritual_put",
            date: "2026-10-01",
            patch: { protein: false, plank_seconds: 60, magnesium: true, stretching: true, journalling: true },
            request_id: "fictional-matrix",
            source_text: "Isolated test only",
          });
          yield* store.request({
            op: "workout_add",
            record: { date: "2026-10-02", type: "Future type", details: "" },
            request_id: "fictional-workout",
            source_text: "Isolated test only",
          });
        }),
      );
      const dbfile = path.join(root, "data", "ritual.sqlite3");
      const before = fileSha(dbfile);
      const { rituals, workouts } = yield* dashboard.readRecords(root);
      const rows = dashboard.matrix(rituals, workouts);
      expect(new Set(rows.map((r) => r.date))).toEqual(
        new Set([...rituals.map((r) => r.date), ...workouts.map((w) => w.date)]),
      );
      const byDate = Object.fromEntries(rows.map((r) => [r.date, r]));
      for (const ritual of rituals) {
        for (const field of [...dashboard.BOOLS, "plank_seconds"])
          expect(byDate[ritual.date]![field]).toEqual(ritual[field]);
      }
      expect(rows.reduce((sum, r) => sum + r.workout_count, 0)).toBe(workouts.length);
      expect(dashboard.plank(byDate["2026-10-01"]!.plank_seconds)).toBe("1:00");
      expect(byDate["2026-10-02"]!.protein).toBeNull();
      expect(fileSha(dbfile)).toBe(before);
    }),
  );

  it.effect("union retains workout-only dates and exact open categories", () =>
    Effect.sync(() => {
      const rituals = [blank("2026-10-01")];
      const workouts = ["run", "gym-pull", "run", "Future Type / custom"].map((type, i) => ({
        id: String(i),
        date: "2026-10-02",
        type,
      }));
      const rows = dashboard.matrix(rituals, workouts);
      expect(rows.map((r) => r.date)).toEqual(["2026-10-02", "2026-10-01"]);
      expect(rows[0]!.has_ritual).toBe(false);
      expect(dashboard.BOOLS.every((k) => rows[0]![k] === null)).toBe(true);
      expect(rows[0]!.activities).toEqual(["run", "gym-pull", "Future Type / custom"]);
      expect(rows[0]!.workout_count).toBe(4);
      expect(rows[1]!.activities).toEqual([]);
    }),
  );

  it.effect("multiple activities join an existing ritual without changing flags", () =>
    Effect.sync(() => {
      const rituals = [
        { date: "2026-10-01", magnesium: 1, protein: 0, stretching: null, journalling: 1, plank_seconds: 66 },
      ];
      const workouts = ["gym pull", "run"].map((type, i) => ({ id: String(i), date: "2026-10-01", type }));
      const row = dashboard.matrix(rituals, workouts)[0]!;
      expect(row.activities).toEqual(["gym pull", "run"]);
      expect(row.protein).toBe(0);
      expect(row.stretching).toBeNull();
    }),
  );

  it.effect("boolean and plank unknown, zero and seconds are distinct", () =>
    Effect.sync(() => {
      expect(dashboard.mark(true)).toContain("Done");
      expect(dashboard.mark(false)).toContain("Not done");
      expect(dashboard.mark(null)).toContain("Unreported");
      expect(dashboard.mark(false)).not.toBe(dashboard.mark(null));
      expect([null, 0, 1, 60, 66, 600].map(dashboard.plank)).toEqual([null, "0:00", "0:01", "1:00", "1:06", "10:00"]);
    }),
  );

  it.effect("activity text and filter values cannot inject markup", () =>
    Effect.sync(() => {
      const value = "</script><img src=https://example.invalid onerror=alert(1)>";
      const rows = dashboard.matrix([], [{ date: "2026-10-01", id: "example", type: value }]);
      const page = render(rows, now());
      expect(page).not.toContain(value);
      expect(page).toContain("&lt;img");
      expect(count(page, "<script>")).toBe(1);
      expect(page).toContain("default-src &#x27;none&#x27;");
    }),
  );

  it.effect("empty database renders without invented dates", () =>
    Effect.sync(() => {
      const page = render([], now());
      expect(page).toContain(">0 days</span>");
      expect(page).toContain("No dates recorded yet.");
      expect(page).not.toContain("<tr data-date=");
      expect(page).toContain('data-rate-habit="workout" title="0 of 0 closed days with a recorded workout">—</span>');
    }),
  );

  it.effect("workout percentage counts closed dates once, including workout-only days", () =>
    Effect.sync(() => {
      const rituals = [blank("2026-10-01")];
      const workouts = [
        ["2026-09-29", "gym pull"],
        ["2026-09-29", "run"],
        ["2026-09-29", "run"],
        ["2026-09-30", "Future open type"],
        ["2026-10-02", "bike"],
        ["2026-10-03", "walk"],
      ].map(([day, kind], i) => ({ id: String(i), date: day as string, type: kind as string }));
      const rows = dashboard.matrix(rituals, workouts);
      const stamp = at("2026-10-02T12:00:00+10:00");
      const report = Result.getOrThrow(statusReport(rituals, workouts, [], stamp));
      const originalCompletion = JSON.stringify(report.completion);
      const page = render(rows, stamp, report);
      expect(workoutTitle(page)).toBe("2 of 3 closed days with a recorded workout");
      expect(page).toContain(">66.7%</span>");
      expect(page).toContain('Date <span class="header-metric">');
      expect(page).toContain(">5 days</span>");
      for (const removed of ['id="month"', 'id="activity"', "Ritual date"]) expect(page).not.toContain(removed);
      expect(count(page, "<select")).toBe(1);
      expect(page).toContain('<select id="ritual-picker"');
      expect(JSON.stringify(report.completion)).toBe(originalCompletion);
      expect("workout" in report.by_habit).toBe(false);
    }),
  );

  it.effect("workout rate obeys the noon cutoff across DST and missing dates", () =>
    Effect.sync(() => {
      const workouts = [
        { id: "dst", date: "2026-10-03", type: "run" },
        { id: "later", date: "2026-10-05", type: "walk" },
      ];
      const rows = dashboard.matrix([], workouts);
      const before = at("2026-10-04T11:59:59+11:00");
      const page = render(rows, before);
      expect(workoutTitle(page)).toBe("0 of 0 closed days with a recorded workout");
      expect(page).toContain('data-rate-habit="workout" title="0 of 0 closed days with a recorded workout">—</span>');
      expect(workoutTitle(render(rows, before + 1_000_000))).toBe("1 of 1 closed days with a recorded workout");
      expect(workoutTitle(render(rows, at("2026-10-06T12:00:00+11:00")))).toBe(
        "2 of 3 closed days with a recorded workout",
      );
    }),
  );

  it.effect("save and replay refresh the snapshot without extra revisions", () =>
    Effect.gen(function* () {
      const root = yield* tempDirectory;
      yield* Effect.scoped(openStore(path.join(root, "data")));
      const req = {
        op: "ritual_put",
        date: "2026-10-02",
        patch: { protein: false, plank_seconds: 60 },
        request_id: "fictional-dashboard-check",
        source_text: "Isolated test only",
      };
      const first = (yield* call(req, root)) as any;
      expect(first.dashboard.updated).toBe(true);
      expect(fs.readFileSync(first.dashboard.path, "utf8")).toContain("1:00");
      expect(mode(first.dashboard.path)).toBe(0o600);
      const second = (yield* call(req, root)) as any;
      expect(second.replayed).toBe(true);
      expect(first.revision).toBe(second.revision);
      expect(((yield* call({ op: "status" }, root)) as any).counts.changes).toBe(1);
    }),
  );

  it.effect("snapshot failure does not fail or queue a successful save", () =>
    Effect.gen(function* () {
      const root = yield* tempDirectory;
      yield* Effect.scoped(openStore(path.join(root, "data")));
      fs.writeFileSync(path.join(root, "data", "views"), "not a folder");
      const req = {
        op: "ritual_put",
        date: "2026-10-02",
        patch: { journalling: true },
        request_id: "fictional-view-failure",
        source_text: "Isolated test only",
      };
      const result = (yield* submit(req, root, true)) as any;
      expect(result.record.journalling).toBe(true);
      expect(result.dashboard.updated).toBe(false);
      expect(result.dashboard.record_saved).toBe(true);
      expect(((yield* call({ op: "status" }, root)) as any).counts.changes).toBe(1);
      expect(listFiles(path.join(root, "queue", "pending"), ".json")).toEqual([]);
    }),
  );

  it.effect("missing database does not create an empty replacement", () =>
    Effect.gen(function* () {
      const folder = yield* tempDirectory;
      const error = yield* dashboard.generate(folder).pipe(Effect.flip);
      expect(error._tag).toBe("SqlError");
      expect(fs.existsSync(path.join(folder, "data", "ritual.sqlite3"))).toBe(false);
    }),
  );
});
