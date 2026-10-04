#!/usr/bin/env python3
"""Private, stdin-only SQLite interface. No listener, credentials, or network calls."""
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import uuid
from zoneinfo import ZoneInfo
from applicability import TABLE_SQL, HABITS, validate_exception, applies, status_report

UTC = dt.timezone.utc
TZ_FILE = Path(__file__).parent / "Melbourne.tzif"
TZ = ZoneInfo.from_file(TZ_FILE.open("rb"), key="Australia/Melbourne") if TZ_FILE.exists() else ZoneInfo("Australia/Melbourne")
SCHEMA = """
CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE rituals(
 date TEXT PRIMARY KEY,
 checkins TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(checkins)),
 magnesium INTEGER CHECK(magnesium IN (0,1)),
 protein INTEGER CHECK(protein IN (0,1)),
 stretching INTEGER CHECK(stretching IN (0,1)),
 journalling INTEGER CHECK(journalling IN (0,1)),
 plank_seconds INTEGER CHECK(plank_seconds >= 0),
 notes TEXT
);
CREATE TABLE workouts(id TEXT PRIMARY KEY, date TEXT NOT NULL, type TEXT NOT NULL, details TEXT NOT NULL);
CREATE INDEX idx_workouts_date ON workouts(date);
CREATE INDEX idx_workouts_type_date ON workouts(type,date);
CREATE TABLE reminders(id TEXT PRIMARY KEY, text TEXT NOT NULL, due_at TEXT, status TEXT NOT NULL CHECK(status IN ('pending','delivered','done','cancelled')));
CREATE INDEX idx_reminders_status_due ON reminders(status,due_at);
CREATE TABLE source_documents(id TEXT PRIMARY KEY, path TEXT NOT NULL, sha256 TEXT NOT NULL, content TEXT NOT NULL);
CREATE TABLE legacy_checkpoints(id TEXT PRIMARY KEY, date TEXT NOT NULL, checkpoint TEXT NOT NULL CHECK(checkpoint IN ('midday','evening')), source_id TEXT NOT NULL REFERENCES source_documents(id), text TEXT NOT NULL);
CREATE INDEX idx_legacy_checkpoints_date ON legacy_checkpoints(date);
CREATE TABLE imports(id TEXT PRIMARY KEY, imported_at TEXT NOT NULL, manifest TEXT NOT NULL);
CREATE TABLE changes(id INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL, recorded_at TEXT NOT NULL, action TEXT NOT NULL, entity TEXT NOT NULL, entity_id TEXT NOT NULL, before_json TEXT, after_json TEXT, source_text TEXT NOT NULL, reason TEXT, response_json TEXT NOT NULL);
CREATE INDEX idx_changes_entity ON changes(entity,entity_id,id);
"""
# Version 3: weekly review answers get their own table (one row per Monday-to-Sunday week).
WEEKLY_SQL = """CREATE TABLE weekly_reviews(
 week_start TEXT PRIMARY KEY CHECK(date(week_start) IS week_start AND strftime('%w',week_start)='1'),
 answer TEXT NOT NULL CHECK(length(trim(answer))>0)
);"""
SCHEMA_VERSION = 3
TABLES_BY_VERSION = {1: ("rituals", "workouts", "reminders", "source_documents", "legacy_checkpoints", "imports", "changes")}
TABLES_BY_VERSION[2] = TABLES_BY_VERSION[1] + ("applicability_exceptions",)
TABLES_BY_VERSION[3] = TABLES_BY_VERSION[2] + ("weekly_reviews",)
TABLES = TABLES_BY_VERSION[SCHEMA_VERSION]
BOOLS = ("magnesium", "protein", "stretching", "journalling")
FIELDS = {"rituals": ("date", "checkins", *BOOLS, "plank_seconds", "notes"), "workouts": ("id", "date", "type", "details"), "reminders": ("id", "text", "due_at", "status")}
FIELDS['applicability_exceptions'] = ('id','habit','start_date','end_date','reason')
FIELDS['weekly_reviews'] = ('week_start','answer')
KEYS = {'rituals': 'date', 'weekly_reviews': 'week_start'}
WRITES = frozenset({'ritual_put', 'workout_add', 'reminder_add', 'correct', 'reminder_mark', 'exception_add', 'weekly_put'})
WEEKLY_NOTE = re.compile(r'Weekly:\s*(\S.*?)\s*')
MIGRATION_REQUIRED = "Schema version {} needs the reviewed migration: back up, then run bin/ritualctl --migrate (HANDOFF.md)"

def key_of(entity):
    return KEYS.get(entity, "id")

def week_start(day):
    day = dt.date.fromisoformat(day)
    return (day - dt.timedelta(days=day.weekday())).isoformat()

def now():
    return dt.datetime.now(UTC).isoformat(timespec="microseconds").replace("+00:00", "Z")

def pack(x):
    return json.dumps(x, ensure_ascii=False, sort_keys=True, separators=(",", ":"))

def sha(x):
    return hashlib.sha256(x.encode("utf-8") if isinstance(x, str) else x).hexdigest()

def fail(message):
    raise ValueError(message)

def text(x, name, limit=20000, empty=False):
    if not isinstance(x, str) or len(x) > limit or (not empty and not x.strip()):
        fail(f"{name} must be a non-empty string of at most {limit} characters")
    return x

def date(x):
    if not isinstance(x, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", x):
        fail("Use a Melbourne calendar date YYYY-MM-DD")
    dt.date.fromisoformat(x)
    return x

def instant(x):
    text(x, "timestamp", 50)
    parsed = dt.datetime.fromisoformat(x.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        fail("Timestamp must include UTC offset; resolve local timing before saving")
    return parsed.astimezone(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")

def validated(entity, row, complete=False):
    if not isinstance(row, dict) or set(row) - set(FIELDS[entity]):
        fail("Unknown record fields; add an explicit migration when a new column is needed")
    out = dict(row)
    for k, v in row.items():
        if k == "date": out[k] = date(v)
        elif k == "id": out[k] = text(v, "id", 180)
        elif k in BOOLS:
            if v is not None and type(v) is not bool: fail(f"{k} must be true, false, or null")
        elif k == "checkins":
            if not isinstance(v, list) or len(v) > 200: fail("checkins must be a timestamp array")
            out[k] = sorted(set(instant(t) for t in v))
        elif k == "plank_seconds":
            if v is not None and (type(v) is not int or v < 0 or v > 86400): fail("plank_seconds must be a nonnegative integer or null")
        elif k in ("notes", "details"):
            if v is not None: text(v, k, 30000, empty=True)
            if k == "details" and v is None: fail("details must be text")
        elif k == "type": out[k] = text(v, k, 120).strip()
        elif k == "text": out[k] = text(v, k, 10000)
        elif k == "due_at": out[k] = None if v is None else instant(v)
        elif k == "status" and v not in ("pending", "delivered", "done", "cancelled"): fail("Unknown reminder status")
        elif k == 'habit' and v not in HABITS: fail('Unknown habit')
        elif k in ('start_date','end_date'): out[k] = None if k=='start_date' and v is None else date(v)
        elif k == 'reason': out[k] = text(v,'reason',2000)
        elif k == 'week_start':
            if date(v) != week_start(v): fail("week_start must be the Monday that starts the Monday-to-Sunday week being reviewed")
        elif k == 'answer': out[k] = text(v, 'answer', 30000)
    if complete:
        required = {"rituals": {"date", "checkins"}, "workouts": {"id", "date", "type", "details"}, "reminders": {"id", "text", "due_at", "status"}, 'applicability_exceptions':set(FIELDS['applicability_exceptions']), 'weekly_reviews':set(FIELDS['weekly_reviews'])}[entity]
        if not required <= set(out): fail("Required record fields are missing")
        if entity=='applicability_exceptions': validate_exception(out,[])
    return out

def db_value(v):
    return pack(v) if isinstance(v, (list, dict)) else v

def decode(entity, row):
    if row is None: return None
    obj = dict(row)
    if entity == "rituals":
        obj["checkins"] = json.loads(obj["checkins"])
        for k in BOOLS: obj[k] = None if obj[k] is None else bool(obj[k])
    return obj

class Store:
    def __init__(self, directory):
        os.umask(0o077)
        self.directory = Path(directory)
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.path = self.directory / "ritual.sqlite3"
        self.frozen = (self.directory / 'FROZEN_BACKUP.json').exists()
        target = self.path.as_uri() + '?mode=ro' if self.frozen else self.path
        self.db = sqlite3.connect(target, timeout=30, isolation_level=None, uri=self.frozen)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.execute("PRAGMA busy_timeout=30000")
        if not self.frozen: os.chmod(self.path, 0o600)
        if not self.db.execute("SELECT 1 FROM sqlite_schema WHERE name='schema_migrations'").fetchone():
            # A new store starts at the current schema; there is nothing to back up or move.
            stamp = now()
            self.db.executescript("BEGIN IMMEDIATE;\n" + SCHEMA + TABLE_SQL + WEEKLY_SQL
                + "".join(f"\nINSERT INTO schema_migrations VALUES({v},'{stamp}');" for v in TABLES_BY_VERSION) + "\nCOMMIT;")
        versions = [r[0] for r in self.db.execute("SELECT version FROM schema_migrations ORDER BY version")]
        if versions==[1] and not self.frozen:
            self.backup()
            self.db.execute('BEGIN IMMEDIATE')
            try:
                if not self.db.execute('SELECT 1 FROM schema_migrations WHERE version=2').fetchone():
                    self.db.execute(TABLE_SQL)
                    self.db.execute('INSERT INTO schema_migrations VALUES(2,?)',(now(),))
                self.db.execute('COMMIT')
            except Exception:
                self.db.execute('ROLLBACK'); raise
            versions = [r[0] for r in self.db.execute('SELECT version FROM schema_migrations ORDER BY version')]
        if versions not in ([1],[1,2],[1,2,3]): fail("Unsupported schema version; explicit migration required")
        self.schema_version = versions[-1]
        self.table_names = TABLES_BY_VERSION[self.schema_version]
        # Version 3 moves data, so it never runs implicitly: until --migrate, only status, backup and export work.
        self.migration_required = self.schema_version < SCHEMA_VERSION and not self.frozen

    def close(self): self.db.close()

    def backup(self):
        folder = self.directory / "backups"
        folder.mkdir(mode=0o700, exist_ok=True)
        name = dt.datetime.now(UTC).strftime("ritual-%Y%m%dT%H%M%S") + "-" + uuid.uuid4().hex[:8] + ".sqlite3"
        target = folder / name
        con = sqlite3.connect(target)
        try: self.db.backup(con)
        finally: con.close()
        os.chmod(target, 0o600)
        return str(target)

    def get(self, entity, key):
        return decode(entity, self.db.execute(f"SELECT * FROM {entity} WHERE {key_of(entity)}=?", (key,)).fetchone())

    def revision(self, entity, key):
        return self.db.execute("SELECT COALESCE(MAX(id),0) FROM changes WHERE entity=? AND entity_id=?", (entity, key)).fetchone()[0]

    def save(self, entity, row, replacing=False):
        fields = list(row)
        verb = "INSERT OR REPLACE" if replacing else "INSERT"
        self.db.execute(f"{verb} INTO {entity} ({','.join(fields)}) VALUES ({','.join('?' for _ in fields)})", [db_value(row[k]) for k in fields])

    def counts(self):
        return {t: self.db.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in self.table_names}

    def record_change(self, request_id, request_hash, action, entity, key, before, after, source, reason, extra=None):
        stamp = now()
        cursor = self.db.execute("INSERT INTO changes(request_id,request_hash,recorded_at,action,entity,entity_id,before_json,after_json,source_text,reason,response_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)", (request_id, request_hash, stamp, action, entity, key, None if before is None else pack(before), pack(after), source, reason, "{}"))
        response = {"record": after, "revision": cursor.lastrowid, "recorded_at": stamp, **(extra or {})}
        self.db.execute("UPDATE changes SET response_json=? WHERE id=?", (pack(response), cursor.lastrowid))
        return response

    def migrate(self):
        """Explicit, reviewed upgrade to the current schema; backs up first, idempotent once applied."""
        if self.frozen: fail('Frozen backup copy: migrate the authoritative store, never this copy.')
        if self.schema_version == SCHEMA_VERSION: return {"migrated": False, "schema_version": self.schema_version}
        backup = self.backup()
        self.db.execute("BEGIN IMMEDIATE")
        try:
            if [r[0] for r in self.db.execute("SELECT version FROM schema_migrations ORDER BY version")] != [1, 2]: fail("Schema changed during migration; reopen and retry")
            self.db.execute(WEEKLY_SQL)
            moved = self.move_weekly_notes("migration:3", "Schema migration 3")
            self.db.execute("INSERT INTO schema_migrations VALUES(3,?)", (now(),))
            self.db.execute("COMMIT")
        except Exception:
            if self.db.in_transaction: self.db.execute("ROLLBACK")
            raise
        previous, self.schema_version = self.schema_version, SCHEMA_VERSION
        self.table_names, self.migration_required = TABLES, False
        return {"migrated": True, "from_version": previous, "schema_version": self.schema_version, "backup": backup, "backup_sha256": sha(Path(backup).read_bytes()), "moved_weekly_answers": moved}

    def move_weekly_notes(self, request_prefix, cause):
        """Move whole "Weekly: ..." note lines into weekly_reviews, keyed by the Monday of the ritual date's week.

        Runs inside the caller's transaction. The original words and their provenance stay in the earlier
        rituals changes; each move is itself audited on both entities.
        """
        found, moved = {}, []
        for row in self.db.execute("SELECT * FROM rituals WHERE notes LIKE '%Weekly:%' ORDER BY date").fetchall():
            before = decode("rituals", row)
            lines = before["notes"].split("\n")
            answers = [m.group(1) for m in map(WEEKLY_NOTE.fullmatch, lines) if m]
            if not answers: continue
            week = week_start(before["date"])
            after = {**before, "notes": "\n".join(line for line in lines if not WEEKLY_NOTE.fullmatch(line)) or None}
            self.save("rituals", after, replacing=True)
            source = f"{cause} moved the weekly answer stored as a 'Weekly:' line in the notes of ritual date {before['date']} into weekly_reviews {week}. Original words and provenance remain in the earlier changes for rituals {before['date']}."
            self.record_change(f"{request_prefix}:rituals:{before['date']}", sha(pack(after)), "migrate", "rituals", before["date"], before, after, source, "Weekly answers have their own record")
            found.setdefault(week, []).append((before["date"], answers))
            moved.append({"date": before["date"], "week_start": week, "lines": len(answers)})
        for week, entries in found.items():
            before = self.get("weekly_reviews", week)
            joined = "\n".join(answer for _, answers in entries for answer in answers)
            after = validated("weekly_reviews", {"week_start": week, "answer": before["answer"] + "\n" + joined if before else joined}, complete=True)
            self.save("weekly_reviews", after, replacing=before is not None)
            dates = ", ".join(day for day, _ in entries)
            source = f"{cause} moved this weekly answer out of the notes of ritual date {dates}. Original words and provenance remain in the earlier changes for rituals {dates}."
            self.record_change(f"{request_prefix}:weekly_reviews:{week}", sha(pack(after)), "migrate", "weekly_reviews", week, before, after, source, "Weekly answers have their own record")
        return moved

    def exceptions(self):
        if self.schema_version<2: return []
        return [dict(r) for r in self.db.execute('SELECT * FROM applicability_exceptions ORDER BY habit,start_date,id')]

    def check_applicability(self, entity, row):
        if entity=='applicability_exceptions':
            existing=[r for r in self.exceptions() if r['id']!=row['id']]
            validate_exception(row,existing)
            field='plank_seconds' if row['habit']=='planks' else row['habit']
            positive=self.db.execute(f'SELECT date FROM rituals WHERE date>=? AND date<=? AND {field}>0 LIMIT 1',(row['start_date'] or '0001-01-01',row['end_date'])).fetchone()
            if positive: fail(f'Positive report on {positive[0]} conflicts with applicability exception; resolve explicitly')
            if row['habit']=='planks':
                for checkpoint in self.db.execute("SELECT date,text FROM legacy_checkpoints WHERE checkpoint='evening' AND date>=? AND date<=?",(row['start_date'] or '0001-01-01',row['end_date'])):
                    if re.search(r'\bplanks\s+(?:yes|✓)',checkpoint['text'],re.I):
                        fail(f'Positive source plank report on {checkpoint[0]} conflicts with applicability exception; resolve explicitly')
        elif entity=='rituals':
            for exception in self.exceptions():
                field='plank_seconds' if exception['habit']=='planks' else exception['habit']
                if row.get(field) is not None and row[field]>0 and applies(exception,exception['habit'],row['date']):
                    fail('Positive report conflicts with applicability exception; correct the exception explicitly first')

    def request(self, req):
        if not isinstance(req, dict): fail("Send one JSON object")
        op = req.get("op")
        self.frozen = self.frozen or (self.directory / 'FROZEN_BACKUP.json').exists()
        if self.frozen and op in ('import', 'restore', *WRITES):
            fail('Frozen backup copy: writes go to the authoritative store. Do not sync back to this copy.')
        if self.migration_required and op not in ("status", "backup", "export"):
            fail(MIGRATION_REQUIRED.format(self.schema_version))
        if op == "status":
            return {"schema_version": self.schema_version, "migration_required": self.migration_required, "timezone": "Australia/Melbourne", "counts": self.counts(), "integrity": self.db.execute("PRAGMA integrity_check").fetchone()[0], "storage_role": 'frozen_backup' if self.frozen else 'authoritative', "scheduler_managed_externally": True}
        if op == "backup":
            path = self.backup()
            return {"backup": path, "sha256": sha(Path(path).read_bytes())}
        if op == "export": return self.export(bool(req.get("save", False)))
        if op == "import": return self.import_bundle(req)
        if op == "restore": return self.restore(req)
        if op in ("rituals", "workouts", "weekly_reviews"): return self.query(req)
        if op=='applicability_exceptions':
            return {'records':[{**r,'revision':self.revision('applicability_exceptions',r['id'])} for r in self.exceptions()]}
        if op=='ritual_status':
            start,end=date(req.get('from')),date(req.get('to'))
            if start>end or (dt.date.fromisoformat(end)-dt.date.fromisoformat(start)).days>3660: fail('Invalid or excessive date range')
            self.db.execute('BEGIN')
            try:
                rituals=[decode('rituals',r) for r in self.db.execute('SELECT * FROM rituals')]
                workouts=[dict(r) for r in self.db.execute('SELECT id,date,type FROM workouts')]
                result=status_report(rituals,workouts,self.exceptions(),instant(req.get('as_of',now())),start,end)
                self.db.execute('COMMIT'); return result
            except Exception:
                self.db.execute('ROLLBACK'); raise
        if op == "reminders": return self.reminders(req)
        if op == "source":
            ident = text(req.get("id"), "id", 200)
            row = self.db.execute("SELECT * FROM source_documents WHERE id=?", (ident,)).fetchone()
            return dict(row) if row else None
        if op == "history":
            entity = req.get("entity")
            if entity not in FIELDS: fail("Unknown entity")
            return [dict(r) for r in self.db.execute("SELECT * FROM changes WHERE entity=? AND entity_id=? ORDER BY id", (entity, text(req.get("id"), "id", 180)))]
        if op in WRITES:
            return self.mutate(req)
        fail("Unknown operation; arbitrary SQL and shell commands are not supported")

    def mutate(self, req):
        request_id = text(req.get("request_id"), "request_id", 180)
        source = text(req.get("source_text"), "source_text", 30000)
        request_hash = sha(pack(req))
        old = self.db.execute("SELECT request_hash,response_json FROM changes WHERE request_id=?", (request_id,)).fetchone()
        if old:
            if old[0] != request_hash: fail("request_id already used for different content")
            return {**json.loads(old[1]), "replayed": True}
        backup = self.backup()
        self.db.execute("BEGIN IMMEDIATE")
        try:
            # Recheck after obtaining the write lock to make concurrent retries safe.
            old = self.db.execute("SELECT request_hash,response_json FROM changes WHERE request_id=?", (request_id,)).fetchone()
            if old:
                if old[0] != request_hash: fail("request_id already used for different content")
                self.db.execute("ROLLBACK")
                return {**json.loads(old[1]), "replayed": True}
            op = req["op"]
            reason = None
            if op == "ritual_put":
                entity, key = "rituals", date(req.get("date"))
                before = self.get(entity, key)
                patch = validated(entity, req.get("patch"))
                if not patch or "date" in patch: fail("Patch must contain reported fields, without date")
                after = before.copy() if before else {"date": key, "checkins": [], **dict.fromkeys(BOOLS), "plank_seconds": None, "notes": None}
                for k, v in patch.items():
                    if k == "checkins": after[k] = sorted(set(after[k] + v))
                    elif k == "notes" and v: after[k] = "\n".join(filter(None, [after.get(k), v]))
                    elif before and after.get(k) is not None and after[k] != v: fail("Changing a recorded value requires correct with expected_revision and reason")
                    else: after[k] = v
            elif op == "weekly_put":
                # Like notes, a further answer for the same week is appended; changing earlier words needs correct.
                entity = "weekly_reviews"
                row = validated(entity, {"week_start": req.get("week_start"), "answer": req.get("answer")}, complete=True)
                key = row["week_start"]
                before = self.get(entity, key)
                after = {**before, "answer": before["answer"] + "\n" + row["answer"]} if before else row
            elif op in ("workout_add", "reminder_add", 'exception_add'):
                entity = {'workout_add':'workouts','reminder_add':'reminders','exception_add':'applicability_exceptions'}[op]
                values = dict(req.get("record", {}))
                values.setdefault("id", {'workouts':'w_','reminders':'r_','applicability_exceptions':'ae_'}[entity] + sha(request_id)[:24])
                if entity == "reminders":
                    values.setdefault("due_at", None)
                    values.setdefault("status", "pending")
                after = validated(entity, values, complete=True)
                key = after["id"]
                before = self.get(entity, key)
                if before: fail("Record already exists; use correct instead")
            else:
                entity = "reminders" if op == "reminder_mark" else req.get("entity")
                if entity not in FIELDS: fail("Unknown entity")
                key = text(req.get("id"), "id", 180)
                before = self.get(entity, key)
                if not before: fail("Record not found")
                if type(req.get("expected_revision")) is not int or req["expected_revision"] != self.revision(entity, key): fail("Revision conflict; read current record before changing it")
                reason = text(req.get("reason"), "reason", 2000)
                patch = validated(entity, {"status": req.get("status")} if op == "reminder_mark" else req.get("patch"))
                if not patch or key_of(entity) in patch: fail("Cannot change record identity; correct fields only")
                after = {**before, **patch}
            self.check_applicability(entity,after)
            self.save(entity, after, replacing=before is not None)
            response = self.record_change(request_id, request_hash, op, entity, key, before, after, source, reason, {"backup": backup, "replayed": False})
            self.db.execute("COMMIT")
            return response
        except Exception:
            if self.db.in_transaction: self.db.execute("ROLLBACK")
            raise

    def query(self, req):
        entity = req["op"]
        start, end = date(req.get("from")), date(req.get("to"))
        if start > end or (dt.date.fromisoformat(end) - dt.date.fromisoformat(start)).days > 3660: fail("Invalid or excessive date range")
        params = [start, end]
        column = "week_start" if entity == "weekly_reviews" else "date"
        where = f"{column} BETWEEN ? AND ?"
        if entity == "workouts" and req.get("type") is not None:
            where += " AND type=?"
            params.append(text(req["type"], "type", 120))
        rows = [decode(entity, r) for r in self.db.execute(f"SELECT * FROM {entity} WHERE {where} ORDER BY {column}" + (",id" if entity == "workouts" else ""), params)]
        for r in rows: r["revision"] = self.revision(entity, r[key_of(entity)])
        result = {"records": rows, "count": len(rows)}
        if entity == "workouts":
            result["active_days"] = len({r["date"] for r in rows})
            groups = {}
            grouping = req.get("group_by")
            if grouping not in (None, "week", "month"): fail("group_by must be week or month")
            if grouping:
                for r in rows:
                    day = dt.date.fromisoformat(r["date"])
                    period = r["date"][:7] if grouping == "month" else (day - dt.timedelta(days=day.weekday())).isoformat()
                    entry = groups.setdefault(period, {"workouts": 0, "days": set(), "by_type": {}})
                    entry["workouts"] += 1
                    entry["days"].add(r["date"])
                    entry["by_type"][r["type"]] = entry["by_type"].get(r["type"], 0) + 1
                result["groups"] = [{"period": k, "workouts": v["workouts"], "active_days": len(v["days"]), "by_type": v["by_type"]} for k, v in sorted(groups.items())]
        return result

    def reminders(self, req):
        as_of = instant(req.get("as_of", now()))
        mode = req.get("mode", "due")
        if mode == "due":
            rows = self.db.execute("SELECT * FROM reminders WHERE status='pending' AND due_at IS NOT NULL AND due_at<=? ORDER BY due_at,id", (as_of,))
        elif mode == "review":
            rows = self.db.execute("SELECT * FROM reminders WHERE status IN ('pending','delivered') ORDER BY due_at IS NOT NULL,due_at,id")
        elif mode == "all": rows = self.db.execute("SELECT * FROM reminders ORDER BY due_at,id")
        else: fail("mode must be due, review, or all")
        result = []
        for row in rows:
            item = dict(row)
            item["revision"] = self.revision("reminders", item["id"])
            item["is_due"] = bool(item["due_at"] and item["due_at"] <= as_of and item["status"] == "pending")
            result.append(item)
        return {"as_of": as_of, "records": result, "delivery_performed": False}

    def import_bundle(self, req):
        bundle = req.get("bundle")
        if not isinstance(bundle, dict) or bundle.get("format") != "ritual-source-import-v1": fail("Unsupported import format")
        batch_id = sha(pack(bundle))
        previous = self.db.execute("SELECT manifest FROM imports WHERE id=?", (batch_id,)).fetchone()
        if previous: return {"import_id": batch_id, "replayed": True, "manifest": json.loads(previous[0])}
        required = ("documents", "checkpoints", "rituals", "workouts", "uncertainties")
        if any(not isinstance(bundle.get(k), list) for k in required): fail("Incomplete import")
        for source in bundle["documents"]:
            if set(source) != {"id", "path", "sha256", "content"}: fail("Invalid source document")
            if sha(source["content"]) != source["sha256"]: fail("Source hash mismatch")
        for row in bundle["rituals"]: validated("rituals", row, True)
        for row in bundle["workouts"]: validated("workouts", row, True)
        ids = {s["id"] for s in bundle["documents"]}
        for row in bundle["checkpoints"]:
            if set(row) != {"id", "date", "checkpoint", "source_id", "text"} or row["source_id"] not in ids or row["checkpoint"] not in ("midday", "evening"): fail("Invalid source checkpoint")
            date(row["date"])
        backup = self.backup()
        self.db.execute("BEGIN IMMEDIATE")
        try:
            previous = self.db.execute("SELECT manifest FROM imports WHERE id=?", (batch_id,)).fetchone()
            if previous:
                self.db.execute("ROLLBACK")
                return {"import_id": batch_id, "replayed": True, "manifest": json.loads(previous[0])}
            # A later import may add evidence, but it must never silently overwrite edited records.
            for entity in ("rituals", "workouts"):
                for raw in bundle[entity]:
                    row = validated(entity, raw, True)
                    key = row["date"] if entity == "rituals" else row["id"]
                    existing = self.get(entity, key)
                    if existing and existing != row: fail(f"Import conflicts with existing {entity} record {key}")
                    self.check_applicability(entity,row)
                    if not existing: self.save(entity, row)
            for entity, key in (("source_documents", "documents"), ("legacy_checkpoints", "checkpoints")):
                for row in bundle[key]:
                    existing = self.db.execute(f"SELECT * FROM {entity} WHERE id=?", (row["id"],)).fetchone()
                    if existing and dict(existing) != row: fail("Source evidence identity conflict")
                    if not existing: self.save(entity, row)
            stamp = now()
            manifest = {"documents": len(bundle["documents"]), "checkpoints": len(bundle["checkpoints"]), "midday_checkpoints": sum(r["checkpoint"] == "midday" for r in bundle["checkpoints"]), "evening_checkpoints": sum(r["checkpoint"] == "evening" for r in bundle["checkpoints"]), "rituals": len(bundle["rituals"]), "workouts": len(bundle["workouts"]), "reminders_created": 0, "uncertainties": bundle["uncertainties"]}
            self.db.execute("INSERT INTO imports VALUES(?,?,?)", (batch_id, stamp, pack(manifest)))
            for entity in ("rituals", "workouts"):
                for row in bundle[entity]:
                    key = row["date"] if entity == "rituals" else row["id"]
                    request_id = f"import:{batch_id}:{entity}:{key}"
                    self.db.execute("INSERT INTO changes(request_id,request_hash,recorded_at,action,entity,entity_id,before_json,after_json,source_text,reason,response_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)", (request_id, sha(pack(row)), stamp, "import", entity, key, None, pack(row), "Preserved source import " + batch_id, "Source snapshot, no completion inference", "{}"))
            self.db.execute("COMMIT")
            self.db.execute("PRAGMA optimize")
            return {"import_id": batch_id, "replayed": False, "manifest": manifest, "backup": backup}
        except Exception:
            if self.db.in_transaction: self.db.execute("ROLLBACK")
            raise

    def export(self, save=False):
        self.db.execute("BEGIN")
        try:
            tables = {}
            for table in self.table_names:
                tables[table] = [decode(table, r) if table == "rituals" else dict(r) for r in self.db.execute(f"SELECT * FROM {table} ORDER BY {key_of(table)}")]
            self.db.execute("COMMIT")
        except Exception:
            self.db.execute("ROLLBACK")
            raise
        result = {"format": "ritual-database-export-v1", "schema_version": self.schema_version, "timezone": "Australia/Melbourne", "exported_at": now(), "data_sha256": sha(pack(tables)), "tables": tables}
        if not save: return result
        folder = self.directory / "exports"
        folder.mkdir(mode=0o700, exist_ok=True)
        target = folder / ("ritual-export-" + dt.datetime.now(UTC).strftime("%Y%m%dT%H%M%S") + "-" + uuid.uuid4().hex[:8] + ".json")
        target.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
        os.chmod(target, 0o600)
        return {"export": str(target), "sha256": sha(target.read_bytes()), "data_sha256": result["data_sha256"], "counts": {k: len(v) for k, v in tables.items()}}

    def restore(self, req):
        snap = req.get("snapshot")
        if not isinstance(snap, dict) or snap.get("format") != "ritual-database-export-v1" or snap.get("schema_version") not in TABLES_BY_VERSION: fail("Unsupported snapshot")
        if any(self.counts().values()): fail("Restore requires an empty store; originals will not be overwritten")
        tables = snap.get("tables", {})
        expected=TABLES_BY_VERSION[snap['schema_version']]
        if set(tables) != set(expected) or sha(pack(tables)) != snap.get("data_sha256"): fail("Snapshot hash or tables mismatch")
        # Validate shape before parameterized inserts. Never execute SQL from an export.
        for table, rows in tables.items():
            cols = {r[1] for r in self.db.execute(f"PRAGMA table_info({table})")}
            for row in rows:
                if set(row) != cols: fail("Snapshot record shape mismatch")
                if table in FIELDS: validated(table, row, True)
                if table == "source_documents" and sha(row["content"]) != row["sha256"]: fail("Snapshot source hash mismatch")
        self.db.execute("BEGIN IMMEDIATE")
        try:
            for table in TABLES:
                for row in tables.get(table,[]): self.save(table, row)
            for row in self.exceptions(): self.check_applicability('applicability_exceptions',row)
            # An older snapshot gets the same weekly move as an upgraded store, so its data matches this schema.
            if snap['schema_version'] < 3: self.move_weekly_notes(f"restore:{snap['data_sha256']}:3", "Restoring a version " + str(snap['schema_version']) + " snapshot")
            self.db.execute("COMMIT")
        except Exception:
            self.db.execute("ROLLBACK")
            raise
        return {"restored": True, "counts": self.counts(), "data_sha256": self.export()["data_sha256"], 'source_data_sha256':snap['data_sha256']}

def main():
    raw = sys.stdin.buffer.read(2_000_001)
    if len(raw) > 2_000_000: fail("Request exceeds 2MB")
    req = json.loads(raw)
    store = Store(os.environ.get("RITUAL_DATA_DIR", "/data"))
    try: result = store.request(req)
    finally: store.close()
    print(json.dumps({"ok": True, "result": result}, ensure_ascii=False))

if __name__ == "__main__":
    try: main()
    except (ValueError, KeyError, TypeError, sqlite3.Error, OSError) as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        sys.exit(1)
