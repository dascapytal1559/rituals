// Made-up fixtures by default; RITUAL_FIXTURE_DIR can point at a local evidence folder instead.
import { Effect } from "effect";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sha } from "../../src/encoding.ts";

export const REPO = path.resolve(import.meta.dirname, "..", "..");
export const FIXTURES = process.env.RITUAL_FIXTURE_DIR ?? path.join(REPO, "tests", "fixtures");

const readJson = (name: string): any => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf8"));
export const BUNDLE: any = readJson("import-bundle.json");
export const PENDING: any = readJson("pending-journalling-2026-09-30.json");

export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** A fresh temporary directory, removed when the test's scope closes. */
export const tempDirectory = Effect.acquireRelease(
  Effect.sync(() => fs.mkdtempSync(path.join(os.tmpdir(), "ritual-test-"))),
  (dir) => Effect.sync(() => fs.rmSync(dir, { recursive: true, force: true })),
);

export const fileSha = (file: string): string => sha(fs.readFileSync(file));

export const listFiles = (folder: string, suffix: string): Array<string> =>
  fs.existsSync(folder) ? fs.readdirSync(folder).filter((name) => name.endsWith(suffix)) : [];

export const mode = (file: string): number => fs.statSync(file).mode & 0o777;

/** Inspect a SQLite file directly (read-only), the way the Python tests opened backups. */
export const inspect = <A>(file: string, use: (db: DatabaseSync) => A): A => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return use(db);
  } finally {
    db.close();
  }
};

/** Run SQL scripts against a new SQLite file, for building old-schema stores. */
export const withDatabase = (file: string, use: (db: DatabaseSync) => void): void => {
  const db = new DatabaseSync(file);
  try {
    use(db);
  } finally {
    db.close();
  }
};

/** The one-line error text, whatever kind of failure it is. */
export const messageOf = (error: unknown): string =>
  typeof error === "object" && error !== null && "message" in error
    ? String((error as { message: unknown }).message)
    : String(error);
