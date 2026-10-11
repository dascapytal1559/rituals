// Temporary ritual items: separate observations and completion, never core habit percentages.
import { Schema } from "effect";
import type { StatusRow } from "./applicability.ts";
import { pack, sha } from "./encoding.ts";
import { weekday } from "./instants.ts";

export const AttachmentRole = Schema.Literals(["required_check", "reminder_only"]);
export type AttachmentRole = typeof AttachmentRole.Type;
export const AttachmentWeekday = Schema.NullOr(Schema.Literals([1, 2, 3, 4, 5, 6, 7]));

export interface Attachment {
  readonly id: string;
  readonly ritual: string;
  readonly text: string;
  readonly start_date: string;
  readonly end_date: string | null;
  readonly role: AttachmentRole;
  /** ISO weekday: Monday 1 through Sunday 7. Missing/null retains the legacy daily scope. */
  readonly weekday?: typeof AttachmentWeekday.Type;
}

export interface AttachmentCheck {
  readonly id: string;
  readonly attachment_id: string;
  readonly date: string;
  readonly done: boolean | null;
  readonly revision?: number;
}

export const ATTACHMENT_SQL = `CREATE TABLE ritual_attachments(
 id TEXT PRIMARY KEY,
 ritual TEXT NOT NULL,
 text TEXT NOT NULL,
 start_date TEXT NOT NULL,
 end_date TEXT,
 role TEXT NOT NULL CHECK(role IN ('required_check','reminder_only')),
 CHECK(end_date IS NULL OR start_date<=end_date)
);
CREATE INDEX idx_ritual_attachments_dates ON ritual_attachments(ritual,start_date,end_date);
CREATE TABLE ritual_attachment_checks(
 id TEXT PRIMARY KEY,
 attachment_id TEXT NOT NULL REFERENCES ritual_attachments(id),
 date TEXT NOT NULL,
 done INTEGER CHECK(done IN (0,1)),
 UNIQUE(attachment_id,date)
);`;

export const ATTACHMENT_WEEKDAY_SQL =
  "ALTER TABLE ritual_attachments ADD COLUMN weekday INTEGER CHECK(weekday BETWEEN 1 AND 7);";

export const checkId = (attachmentId: string, day: string): string =>
  "ac_" + sha(pack([attachmentId, day])).slice(0, 24);

export const attachmentApplies = (item: Attachment, ritual: string, day: string): boolean =>
  item.ritual === ritual &&
  item.start_date <= day &&
  (item.end_date === null || day <= item.end_date) &&
  (item.weekday === undefined || item.weekday === null || weekday(day) + 1 === item.weekday);

export const attachmentViews = (
  items: ReadonlyArray<Attachment>,
  checks: ReadonlyArray<AttachmentCheck>,
  ritual: string,
  day: string,
) =>
  items
    .filter((item) => attachmentApplies(item, ritual, day))
    .map((item) => {
      const check = checks.find((row) => row.attachment_id === item.id && row.date === day);
      return {
        ...item,
        weekday: item.weekday ?? null,
        date: day,
        check_id: item.role === "required_check" ? checkId(item.id, day) : null,
        done: check?.done ?? null,
        status:
          item.role === "reminder_only"
            ? "reminder_only"
            : check?.done === true
              ? "done"
              : check?.done === false
                ? "not_done"
                : "unreported",
        revision: check?.revision ?? 0,
        requires_response: item.role === "required_check",
      };
    });

export const fullCompletion = (core: StatusRow | null, attached: ReturnType<typeof attachmentViews>) => {
  const remainingCore =
    core === null
      ? []
      : Object.entries(core.habits)
          .filter(([, cell]) => cell.applicable && cell.status !== "done")
          .map(([habit]) => habit);
  const required = attached.filter((item) => item.requires_response);
  const remainingAttached = required.filter((item) => item.done !== true).map((item) => item.id);
  return {
    core_complete: remainingCore.length === 0,
    required_checks_complete: remainingAttached.length === 0,
    complete: remainingCore.length === 0 && remainingAttached.length === 0,
    remaining_core: remainingCore,
    remaining_attached: remainingAttached,
  };
};
