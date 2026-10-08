import { expect, layer } from "@effect/vitest";
import { Effect, Result } from "effect";
import { NodeServices } from "@effect/platform-node";
import * as path from "node:path";
import { statusReport } from "../src/applicability.ts";
import * as dashboard from "../src/dashboard.ts";
import * as dashboardWeb from "../src/dashboardWeb.ts";
import { pack } from "../src/encoding.ts";
import { parseDateTime } from "../src/instants.ts";
import { openStore } from "../src/store.ts";
import { BUNDLE, fileSha, tempDirectory } from "./helpers/fixtures.ts";
import { columnHeaders, dataRows } from "./helpers/html.ts";

type Row = dashboard.RitualRow & { checkins: Array<string>; _checkin_origins?: Map<number, dashboard.Basis> };
const row = (day = "2026-09-30", times?: Array<string>): Row => ({
  date: day,
  checkins: times ?? [],
  magnesium: null,
  protein: null,
  stretching: null,
  journalling: null,
  plank_seconds: null,
});
const times = (r: dashboard.RitualRow) => Result.getOrThrow(dashboard.checkinTimes(r));
const cell = (r: dashboard.RitualRow) => Result.getOrThrow(dashboard.checkinCell(r));
const instant = (text: string) => Result.getOrThrow(dashboard.checkinInstant(text));
const at = (text: string) => Result.getOrThrow(parseDateTime(text)).micros;
const withoutPrivate = (rows: ReadonlyArray<Row>) =>
  pack(rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith("_")))));

layer(NodeServices.layer, { excludeTestServices: true })("check-in display", (it) => {
  it.effect("september 30 shows the initial time and preserves both records", () =>
    Effect.sync(() => {
      const r = row("2026-09-30", ["2026-09-30T15:26:00Z", "2026-09-30T12:55:00Z"]);
      const original = [...r.checkins];
      const items = times(r);
      expect(items.map((x) => x.text)).toEqual(["22:55"]);
      expect(items[0]!.datetime).toBe("2026-09-30T22:55:00+10:00");
      expect(r.checkins).toEqual(original);
    }),
  );

  it.effect("later updates do not replace the initial after-midnight time", () =>
    Effect.sync(() => {
      const r = {
        ...row("2026-10-02", ["2026-10-02T15:30:00Z", "2026-10-02T14:44:00Z"]),
        magnesium: true,
        protein: true,
      };
      const items = times(r);
      expect(items).toHaveLength(1);
      expect([items[0]!.text, items[0]!.day_label]).toEqual(["00:44", "+1 day"]);
      expect(r.checkins).toHaveLength(2);
    }),
  );

  it.effect("missing does not infer from completion or workout", () =>
    Effect.sync(() => {
      const r = { ...row("2026-10-03"), protein: true, stretching: true };
      expect(times(r)).toEqual([]);
      expect(cell(r)).toContain("No evening check-in recorded");
      const activity = dashboard.matrix([], [{ id: "x", date: "2026-10-03", type: "run" }])[0]!;
      expect(times(activity)).toEqual([]);
    }),
  );

  it.effect("offsets and actual DST conversion", () =>
    Effect.sync(() => {
      const items = times(row("2026-10-03", ["2026-10-03T15:59:00Z", "2026-10-03T16:01:00Z"]));
      expect(items.map((x) => x.text)).toEqual(["01:59"]);
      expect(items[0]!.datetime.endsWith("+10:00")).toBe(true);
      const after = times(row("2026-10-03", ["2026-10-03T16:01:00Z"]));
      expect(after[0]!.text).toBe("03:01");
      expect(after[0]!.datetime.endsWith("+11:00")).toBe(true);
      expect(items.every((x) => x.day_label === "+1 day")).toBe(true);
      const later = times(row("2026-10-01", ["2026-10-03T16:01:00Z"]));
      expect(later[0]!.day_label).toBe("+3 days");
    }),
  );

  it.effect("timezone is required and equivalent instants are not duplicated", () =>
    Effect.sync(() => {
      expect(Result.isFailure(dashboard.checkinTimes(row("2026-09-30", ["2026-09-30T22:55:00"])))).toBe(true);
      expect(times(row("2026-09-30", ["2026-09-30T12:55:00Z", "2026-09-30T22:55:00+10:00"]))).toHaveLength(1);
    }),
  );

  it.effect("receipt basis requires a matching added timestamp and stays private", () =>
    Effect.sync(() => {
      const stamp = "2026-10-02T13:21:59Z";
      const event = {
        entity_id: "2026-10-02",
        action: "ritual_put",
        before_json: JSON.stringify({ checkins: [] }),
        after_json: JSON.stringify({ checkins: [stamp] }),
        source_text: "Private words. Received 2026-10-02T13:21:59Z. Private ID.",
      };
      const origins = Result.getOrThrow(dashboard.checkinOrigins([event]));
      const r = { ...row("2026-10-02", [stamp]), _checkin_origins: origins.get("2026-10-02")! };
      const item = times(r)[0]!;
      expect(item.basis).toBe("message_received");
      expect(item.label).toContain("receipt time");
      expect(cell(r)).not.toContain("message received");
      expect(cell(r)).toContain("receipt time");
      expect(JSON.stringify(item)).not.toContain("Private");
      // An unrelated later report cannot reinterpret an existing check-in.
      const later = { ...event, before_json: event.after_json, source_text: "Received 2026-10-02T14:00:00Z" };
      expect(Result.getOrThrow(dashboard.checkinOrigins([later])).get("2026-10-02")!.size).toBe(0);
    }),
  );

  it.effect("corrected timestamp does not keep the old receipt qualification", () =>
    Effect.sync(() => {
      const old = "2026-10-02T13:21:59Z";
      const fresh = "2026-10-02T13:15:00Z";
      const events = [
        {
          entity_id: "2026-10-02",
          action: "ritual_put",
          before_json: null,
          after_json: JSON.stringify({ checkins: [old] }),
          source_text: "Received at: " + old,
        },
        {
          entity_id: "2026-10-02",
          action: "correct",
          before_json: JSON.stringify({ checkins: [old] }),
          after_json: JSON.stringify({ checkins: [fresh] }),
          source_text: "Reported actual check-in time; received 2026-10-02T14:00:00Z",
        },
      ];
      const result = Result.getOrThrow(dashboard.checkinOrigins(events)).get("2026-10-02")!;
      expect(result.has(instant(old))).toBe(false);
      expect(result.get(instant(fresh))).toBe("recorded");
    }),
  );

  it.effect("isolated import read does not mix in midday or write", () =>
    Effect.gen(function* () {
      const root = yield* tempDirectory;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const store = yield* openStore(path.join(root, "data"));
          yield* store.request({ op: "import", bundle: BUNDLE });
          yield* store.request({
            op: "ritual_put",
            date: "2026-10-01",
            patch: { checkins: ["2026-10-01T14:44:39Z"] },
            request_id: "fictional-receipt",
            source_text: "Fictional Checking in. Received at2026-10-01T14:44:39Z; actual physical instant unknown.",
          });
          yield* store.request({
            op: "ritual_put",
            date: "2026-10-03",
            patch: { protein: true },
            request_id: "fictional-habit-only",
            source_text: "Fictional habit report only",
          });
        }),
      );
      const db = path.join(root, "data", "ritual.sqlite3");
      const before = fileSha(db);
      const { rituals } = yield* dashboard.readRecords(root);
      const rows = Object.fromEntries(rituals.map((r) => [r.date, r]));
      const old = times(rows["2026-08-24"]!);
      expect(old.map((x) => [x.text, x.day_label])).toEqual([["01:01", "+1 day"]]);
      expect(old[0]!.basis).toBe("source_recorded");
      const item = times(rows["2026-10-01"]!)[0]!;
      expect([item.text, item.day_label, item.basis]).toEqual(["00:44", "+1 day", "message_received"]);
      expect(times(rows["2026-10-03"]!)).toEqual([]);
      expect(fileSha(db)).toBe(before);
    }),
  );

  it.effect("static and API match and percentage inputs are unchanged", () =>
    Effect.sync(() => {
      const stamp = at("2026-10-03T20:00:00+10:00");
      const rituals: Array<Row> = [
        row(),
        row("2026-10-01", ["2026-10-01T14:44:39Z"]),
        row("2026-10-02", ["2026-10-02T13:21:59Z"]),
        row("2026-10-03"),
      ];
      rituals[0]!.checkins = ["2026-09-30T12:55:00Z", "2026-09-30T15:26:00Z"];
      rituals[2]!._checkin_origins = new Map([[instant("2026-10-02T13:21:59Z"), "message_received"]]);
      const original = withoutPrivate(rituals);
      const workouts = [{ id: "one", date: "2026-10-01", type: "gym push" }];
      const report = Result.getOrThrow(statusReport(rituals, workouts, [], stamp));
      const page = Result.getOrThrow(dashboard.render(dashboard.matrix(rituals, workouts), stamp, report));
      const parsed = dataRows(page);
      const headers = columnHeaders(page);
      expect(headers).toHaveLength(8);
      expect(headers[1]!.class).toBe("checkin-col");
      expect(dashboard.CHECKIN_HEADER).not.toContain("data-rate");
      const data = Result.getOrThrow(dashboardWeb.dashboardData({ rituals, workouts, exceptions: [] }, stamp));
      expect(parsed.length).toBe(data.rows.length);
      for (const [index, actual] of parsed.entries()) {
        const api = data.rows[index]!;
        expect(actual.date).toBe(api.date);
        expect(actual.times.map((t) => t.datetime)).toEqual(api.checkin_times.map((t) => t.datetime));
        expect(actual.text).toEqual(api.checkin_times.length > 0 ? api.checkin_times.map((t) => t.text) : ["—"]);
      }
      expect(data.rates.workout!.percentage).toBe(100 / 3);
      expect("checkin_times" in data.rates).toBe(false);
      expect(withoutPrivate(rituals)).toBe(original);
    }),
  );
});
