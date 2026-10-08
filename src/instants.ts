// Dates and instants the way the Python store handled them, without a datetime library.
//
// An `Micros` is an integer count of microseconds since the Unix epoch, always UTC.
// Calendar days are ISO strings ("2026-10-08"). Melbourne local time comes from Intl, which uses
// Node's bundled ICU time zone data, so no tzif file is shipped. Parsing follows Python 3.9's
// datetime.fromisoformat grammar exactly, because that is what accepted every stored timestamp.
import { Clock, Effect, Result } from "effect";

export const TIMEZONE = "Australia/Melbourne";

export type Micros = number;

export const MICROS_PER_SECOND = 1_000_000;
export const MICROS_PER_DAY = 86_400 * MICROS_PER_SECOND;

export const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const MONTHS_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
export const DAYS_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export const DAYS_LONG = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

// Proleptic Gregorian calendar arithmetic (Howard Hinnant's algorithms), days since 1970-01-01.
export const daysFromCivil = (year: number, month: number, day: number): number => {
  const y = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
};

export const civilFromDays = (days: number): { year: number; month: number; day: number } => {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp + (mp < 10 ? 3 : -9);
  return { year: yoe + era * 400 + (month <= 2 ? 1 : 0), month, day };
};

const daysInMonth = (year: number, month: number): number => {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
};

const pad = (value: number, width: number): string => String(value).padStart(width, "0");

export const isoDate = (days: number): string => {
  const { year, month, day } = civilFromDays(days);
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
};

const checkCalendar = (year: number, month: number, day: number): string | null => {
  if (year < 1 || year > 9999) return `year ${year} is out of range`;
  if (month < 1 || month > 12) return "month must be in 1..12";
  if (day < 1 || day > daysInMonth(year, month)) return "day is out of range for month";
  return null;
};

/** Python 3.9 date.fromisoformat: exactly YYYY-MM-DD, then range checks. */
export const parseDate = (text: string): Result.Result<string, string> => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return Result.fail(`Invalid isoformat string: '${text}'`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const problem = checkCalendar(year, month, day);
  return problem === null ? Result.succeed(text) : Result.fail(problem);
};

/** Days since the epoch for a valid ISO date string. */
export const dateToDays = (date: string): number => {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return daysFromCivil(year, month, day);
};

export const addDays = (date: string, days: number): string => isoDate(dateToDays(date) + days);

/** Python date.weekday(): Monday is 0. 1970-01-01 was a Thursday. */
export const weekday = (date: string): number => (((dateToDays(date) + 3) % 7) + 7) % 7;

export const weekStart = (date: string): string => addDays(date, -weekday(date));

export const dayDifference = (later: string, earlier: string): number => dateToDays(later) - dateToDays(earlier);

export interface ParsedDateTime {
  readonly micros: Micros;
  /** Seconds east of UTC, or null when the text had no offset (Python: naive). */
  readonly offsetSeconds: number | null;
}

const timedeltaRepr = (seconds: number): string => {
  const days = Math.floor(seconds / 86_400);
  const rest = seconds - days * 86_400;
  const parts: Array<string> = [];
  if (days !== 0) parts.push(`days=${days}`);
  if (rest !== 0) parts.push(`seconds=${rest}`);
  return parts.length > 0 ? `datetime.timedelta(${parts.join(", ")})` : "datetime.timedelta(0)";
};

const TIME_PATTERN =
  /^(\d{2})(?::(\d{2})(?::(\d{2})(?:\.(\d{3}|\d{6}))?)?)?(?:([+-])(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{6}))?)?)?$/;

/**
 * Python 3.9 datetime.fromisoformat: a date, optionally one separator character and a time with
 * 3- or 6-digit fractions, optionally an offset of the form +HH:MM[:SS[.ffffff]].
 */
export const parseDateTime = (text: string): Result.Result<ParsedDateTime, string> => {
  const invalid = Result.fail(`Invalid isoformat string: '${text}'`);
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (!dateMatch) return invalid;
  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  let hour = 0;
  let minute = 0;
  let second = 0;
  let micro = 0;
  let offsetSeconds: number | null = null;
  if (text.length > 10) {
    if (text.length < 13) return invalid;
    const timeMatch = TIME_PATTERN.exec(text.slice(11));
    if (!timeMatch) return invalid;
    hour = Number(timeMatch[1]);
    minute = Number(timeMatch[2] ?? 0);
    second = Number(timeMatch[3] ?? 0);
    micro = timeMatch[4] === undefined ? 0 : Number(timeMatch[4].padEnd(6, "0"));
    if (timeMatch[5] !== undefined) {
      const magnitude = Number(timeMatch[6]) * 3600 + Number(timeMatch[7]) * 60 + Number(timeMatch[8] ?? 0);
      if (timeMatch[9] !== undefined && Number(timeMatch[9]) !== 0) return invalid;
      if (magnitude >= 86_400) {
        return Result.fail(
          "offset must be a timedelta strictly between -timedelta(hours=24) and timedelta(hours=24), not " +
            timedeltaRepr(timeMatch[5] === "-" ? -magnitude : magnitude) +
            ".",
        );
      }
      offsetSeconds = timeMatch[5] === "-" ? -magnitude : magnitude;
    }
  }
  const calendarProblem = checkCalendar(year, month, day);
  if (calendarProblem !== null) return Result.fail(calendarProblem);
  if (hour > 23) return Result.fail("hour must be in 0..23");
  if (minute > 59) return Result.fail("minute must be in 0..59");
  if (second > 59) return Result.fail("second must be in 0..59");
  const localMicros =
    (daysFromCivil(year, month, day) * 86_400 + hour * 3600 + minute * 60 + second) * MICROS_PER_SECOND + micro;
  return Result.succeed({
    micros: localMicros - (offsetSeconds ?? 0) * MICROS_PER_SECOND,
    offsetSeconds,
  });
};

export interface Parts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly micro: number;
  readonly offsetSeconds: number;
  readonly date: string;
  readonly days: number;
}

/** Calendar fields of an instant shifted by an offset (0 for UTC). */
export const partsAt = (micros: Micros, offsetSeconds: number): Parts => {
  const shifted = micros + offsetSeconds * MICROS_PER_SECOND;
  const days = Math.floor(shifted / MICROS_PER_DAY);
  const ofDay = shifted - days * MICROS_PER_DAY;
  const seconds = Math.floor(ofDay / MICROS_PER_SECOND);
  const { year, month, day } = civilFromDays(days);
  return {
    year,
    month,
    day,
    hour: Math.floor(seconds / 3600),
    minute: Math.floor((seconds % 3600) / 60),
    second: seconds % 60,
    micro: ofDay - seconds * MICROS_PER_SECOND,
    offsetSeconds,
    date: isoDate(days),
    days,
  };
};

const localFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: TIMEZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});
const abbreviationFormatter = new Intl.DateTimeFormat("en-AU", { timeZone: TIMEZONE, timeZoneName: "short" });

/** Melbourne's offset from UTC at an instant, in seconds (36000 in winter, 39600 in summer). */
export const melbourneOffset = (micros: Micros): number => {
  const ms = Math.floor(micros / 1000);
  const fields: Record<string, number> = {};
  for (const part of localFormatter.formatToParts(new Date(ms))) {
    if (part.type !== "literal") fields[part.type] = Number(part.value);
  }
  const localSeconds =
    daysFromCivil(fields.year as number, fields.month as number, fields.day as number) * 86_400 +
    (fields.hour as number) * 3600 +
    (fields.minute as number) * 60 +
    (fields.second as number);
  return localSeconds - Math.floor(ms / 1000);
};

/** "AEST" or "AEDT" at an instant, what Python's strftime('%Z') printed. */
export const melbourneAbbreviation = (micros: Micros): string =>
  abbreviationFormatter.formatToParts(new Date(Math.floor(micros / 1000))).find((p) => p.type === "timeZoneName")
    ?.value ?? "";

export const melbourneParts = (micros: Micros): Parts => partsAt(micros, melbourneOffset(micros));

/** The UTC instant of a Melbourne wall-clock time (noon never falls in a DST gap). */
export const fromMelbourne = (date: string, hour: number): { micros: Micros; offsetSeconds: number } => {
  const wall = (dateToDays(date) * 86_400 + hour * 3600) * MICROS_PER_SECOND;
  const guess = wall - 36_000 * MICROS_PER_SECOND;
  let offset = melbourneOffset(guess);
  let micros = wall - offset * MICROS_PER_SECOND;
  const check = melbourneOffset(micros);
  if (check !== offset) {
    offset = check;
    micros = wall - offset * MICROS_PER_SECOND;
  }
  return { micros, offsetSeconds: offset };
};

const offsetText = (offsetSeconds: number): string => {
  const sign = offsetSeconds < 0 ? "-" : "+";
  const magnitude = Math.abs(offsetSeconds);
  const hours = Math.floor(magnitude / 3600);
  const minutes = Math.floor((magnitude % 3600) / 60);
  const seconds = magnitude % 60;
  return `${sign}${pad(hours, 2)}:${pad(minutes, 2)}` + (seconds !== 0 ? `:${pad(seconds, 2)}` : "");
};

/** Python datetime.isoformat(): microseconds only when nonzero, offset as +HH:MM. */
export const isoformat = (micros: Micros, offsetSeconds: number): string => {
  const p = partsAt(micros, offsetSeconds);
  const fraction = p.micro !== 0 ? "." + pad(p.micro, 6) : "";
  return `${p.date}T${pad(p.hour, 2)}:${pad(p.minute, 2)}:${pad(p.second, 2)}${fraction}${offsetText(offsetSeconds)}`;
};

export const isoformatUtc = (micros: Micros): string => isoformat(micros, 0);

export const isoformatMelbourne = (micros: Micros): string => isoformat(micros, melbourneOffset(micros));

/** Whole-second UTC instant with a Z suffix: the stored form of every timestamp. */
export const instantZ = (micros: Micros): string => {
  const p = partsAt(micros, 0);
  return `${p.date}T${pad(p.hour, 2)}:${pad(p.minute, 2)}:${pad(p.second, 2)}Z`;
};

/** Python ritual.now(): microsecond UTC stamp with a Z suffix. */
export const stampZ = (micros: Micros): string => {
  const p = partsAt(micros, 0);
  return `${p.date}T${pad(p.hour, 2)}:${pad(p.minute, 2)}:${pad(p.second, 2)}.${pad(p.micro, 6)}Z`;
};

/** strftime('%Y%m%dT%H%M%S') in UTC, optionally with '%f'. */
export const compactStamp = (micros: Micros, withMicros = false): string => {
  const p = partsAt(micros, 0);
  return (
    `${pad(p.year, 4)}${pad(p.month, 2)}${pad(p.day, 2)}T${pad(p.hour, 2)}${pad(p.minute, 2)}${pad(p.second, 2)}` +
    (withMicros ? pad(p.micro, 6) : "")
  );
};

/** strftime('%d %b %Y · %H:%M:%S %Z') in Melbourne, the dashboard's "Updated" stamp. */
export const updatedDisplay = (micros: Micros): string => {
  const p = melbourneParts(micros);
  return `${pad(p.day, 2)} ${MONTHS_SHORT[p.month - 1]} ${p.year} · ${pad(p.hour, 2)}:${pad(p.minute, 2)}:${pad(p.second, 2)} ${melbourneAbbreviation(micros)}`;
};

export const hhmm = (p: Parts): string => `${pad(p.hour, 2)}:${pad(p.minute, 2)}`;

/** The current instant from the Effect clock. */
export const nowMicros: Effect.Effect<Micros> = Effect.map(Clock.currentTimeMillis, (ms) => ms * 1000);
