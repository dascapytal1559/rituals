// Minimal HTML picking for the rendered pages (the Python tests used html.parser).
export interface ParsedRow {
  readonly date: string;
  readonly times: Array<Record<string, string>>;
  readonly text: Array<string>;
}

export const attributes = (tag: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const match of tag.matchAll(/([a-zA-Z-]+)="([^"]*)"/g)) out[match[1] as string] = match[2] as string;
  return out;
};

const unescape = (text: string): string =>
  text
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

/** Every data-date row with its check-in cell's <time> attributes and visible text pieces. */
export const dataRows = (page: string): Array<ParsedRow> => {
  const rows: Array<ParsedRow> = [];
  for (const row of page.matchAll(/<tr data-date="([^"]+)"[^>]*>(.*?)<\/tr>/gs)) {
    const cell = /<td class="checkin">(.*?)<\/td>/s.exec(row[2] as string)?.[1] ?? "";
    const times = [...cell.matchAll(/<time([^>]*)>/g)].map((m) => attributes(m[1] as string));
    const text = [...cell.matchAll(/>([^<]+)</g)].map((m) => unescape(m[1] as string));
    rows.push({ date: row[1] as string, times, text });
  }
  return rows;
};

export const columnHeaders = (page: string): Array<Record<string, string>> =>
  [...page.matchAll(/<th([^>]*scope="col"[^>]*)>/g)].map((m) => attributes(m[1] as string));

/** The title of the workout rate metric, as the WorkoutMetrics parser found it. */
export const workoutTitle = (page: string): string | null => {
  const match = /<span data-rate-habit="workout" title="([^"]*)"/.exec(page);
  return match ? unescape(match[1] as string) : null;
};

export const count = (page: string, needle: string): number => page.split(needle).length - 1;
