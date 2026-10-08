// The live page and API payload rendered from a private read-only copy of a database.
// argv: database path. The source is opened mode=ro and copied with SQLite's backup API; it is never written.
import { Effect } from "effect";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { frontend, readDashboardData } from "../src/dashboardWeb.ts";

const source = process.argv[2];
if (source === undefined) {
  process.stderr.write("Usage: screenshot-page DATABASE\n");
  process.exit(2);
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ritual-shot-"));
try {
  fs.mkdirSync(path.join(tmp, "data"), { mode: 0o700 });
  const db = new DatabaseSync(`file:${source}?mode=ro`, { readOnly: true });
  try {
    await backup(db, path.join(tmp, "data", "ritual.sqlite3"));
  } finally {
    db.close();
  }
  const api = await Effect.runPromise(readDashboardData(tmp));
  process.stdout.write(JSON.stringify({ api, html: frontend() }));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
