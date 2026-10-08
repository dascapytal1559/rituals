// Byte-exact replacements for the Python json/hashlib/html helpers the store depends on.
// `pack` must produce the same bytes as Python's json.dumps(sort_keys=True, separators=(",",":"),
// ensure_ascii=False): request hashes and export checksums stored by the Python version are
// compared against it on every retry and restore.
import { createHash } from "node:crypto";

export const sha = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

export const sha256Base64 = (value: string): string => createHash("sha256").update(value).digest("base64");

/** Python compares str keys by code point; JavaScript's default sort compares UTF-16 code units. */
export const compareCodePoints = (a: string, b: string): number => {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const x = a.codePointAt(i) as number;
    const y = b.codePointAt(j) as number;
    if (x !== y) return x < y ? -1 : 1;
    i += x > 0xffff ? 2 : 1;
    j += y > 0xffff ? 2 : 1;
  }
  return a.length - i - (b.length - j);
};

/** Python's repr() of a float: fixed notation for exponents -4..15, otherwise 1e+16 / 1e-05 style. */
const pythonFloat = (value: number): string => {
  if (!Number.isFinite(value)) return value > 0 ? "Infinity" : value < 0 ? "-Infinity" : "NaN";
  const exponential = value.toExponential();
  const match = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(exponential) as RegExpExecArray;
  const sign = match[1] as string;
  const digits = (match[2] as string) + (match[3] ?? "");
  const exponent = Number(match[4]);
  if (exponent >= -4 && exponent < 16) {
    let text: string;
    if (exponent >= 0) {
      const whole = digits.slice(0, exponent + 1).padEnd(exponent + 1, "0");
      const fraction = digits.slice(exponent + 1);
      text = whole + "." + (fraction.length > 0 ? fraction : "0");
    } else {
      text = "0." + "0".repeat(-exponent - 1) + digits;
    }
    return sign + text;
  }
  const mantissa = digits.length > 1 ? digits[0] + "." + digits.slice(1) : digits;
  const exponentText = (exponent < 0 ? "-" : "+") + String(Math.abs(exponent)).padStart(2, "0");
  return sign + mantissa + "e" + exponentText;
};

const packNumber = (value: number): string => (Number.isInteger(value) ? String(value) : pythonFloat(value));

/** Canonical JSON used for hashes and audit rows: sorted keys, no spaces, raw UTF-8. */
export const pack = (value: unknown): string => {
  if (value === null || value === undefined) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return packNumber(value);
    case "bigint":
      return value.toString();
    case "string":
      return JSON.stringify(value);
    default:
      break;
  }
  if (Array.isArray(value)) return "[" + value.map(pack).join(",") + "]";
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).toSorted(compareCodePoints);
  return "{" + keys.map((key) => JSON.stringify(key) + ":" + pack(record[key])).join(",") + "}";
};

/** Python's json.dumps(value, ensure_ascii=False[, indent=2]) for CLI output and saved files. */
export const dumps = (value: unknown, indent?: number): string => JSON.stringify(value, null, indent) ?? "null";

/** Python's html.escape(value, quote=True). */
export const escapeHtml = (value: unknown): string =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");

/** Python's '%.1f': correctly rounded, with exact ties (x.25, x.75) going to the even digit. */
export const fixed1 = (value: number): string => {
  const quarters = value * 4;
  if (Number.isInteger(quarters) && Math.abs(quarters % 2) === 1) {
    const scaled = value * 10;
    const low = Math.floor(scaled);
    const chosen = low % 2 === 0 ? low : low + 1;
    return (chosen / 10).toFixed(1);
  }
  return value.toFixed(1);
};

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Python's `a == b` for JSON-shaped values (dicts compare by content, regardless of key order). */
export const sameJson = (a: unknown, b: unknown): boolean => pack(a) === pack(b);
