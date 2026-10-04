"""Weekly review answers: their own record, the reviewed migration out of notes, and the answer-only views."""
import datetime as dt
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

import dashboard
import dashboard_web
import local_client
from applicability import TABLE_SQL
from ritual import Store, SCHEMA, pack, sha

def weekly(week, answer, key):
    return {'op':'weekly_put','week_start':week,'answer':answer,'request_id':key,'source_text':'Fictional weekly answer, isolated test only'}

def version2_store(folder, notes):
    """A store as it was before weekly_reviews existed, with fictional notes per ritual date."""
    path = Path(folder)/'ritual.sqlite3'
    with sqlite3.connect(path) as db:
        db.executescript(SCHEMA+TABLE_SQL)
        db.execute("INSERT INTO schema_migrations VALUES(1,'old'),(2,'old')")
        for day, text in notes.items():
            db.execute("INSERT INTO rituals(date,protein,notes) VALUES(?,1,?)", (day, text))
    return path

class WeeklyRecordTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.store = Store(self.tmp.name)
    def tearDown(self): self.store.close(); self.tmp.cleanup()

    def test_new_store_starts_at_current_schema(self):
        status = self.store.request({'op':'status'})
        self.assertEqual((status['schema_version'], status['migration_required'], status['counts']['weekly_reviews']), (3, False, 0))
        self.assertFalse((Path(self.tmp.name)/'backups').exists())

    def test_put_appends_replays_and_corrects_with_revision(self):
        first = self.store.request(weekly('2026-09-28', 'Fictional: shipped the thing', 'fictional-msg-1:weekly'))
        self.assertEqual(first['record'], {'week_start':'2026-09-28', 'answer':'Fictional: shipped the thing'})
        self.assertTrue(self.store.request(weekly('2026-09-28', 'Fictional: shipped the thing', 'fictional-msg-1:weekly'))['replayed'])
        with self.assertRaisesRegex(ValueError, 'different content'):
            self.store.request(weekly('2026-09-28', 'Changed', 'fictional-msg-1:weekly'))
        added = self.store.request(weekly('2026-09-28', 'Fictional: and one more', 'fictional-msg-2:weekly'))
        self.assertEqual(added['record']['answer'], 'Fictional: shipped the thing\nFictional: and one more')
        with self.assertRaisesRegex(ValueError, 'Revision conflict'):
            self.store.request({'op':'correct','entity':'weekly_reviews','id':'2026-09-28','patch':{'answer':'Fixed'},'expected_revision':first['revision'],'reason':'Fictional fix','request_id':'fictional-fix','source_text':'Fictional'})
        fixed = self.store.request({'op':'correct','entity':'weekly_reviews','id':'2026-09-28','patch':{'answer':'Fixed'},'expected_revision':added['revision'],'reason':'Fictional fix','request_id':'fictional-fix','source_text':'Fictional'})
        self.assertEqual(fixed['record']['answer'], 'Fixed')
        with self.assertRaisesRegex(ValueError, 'identity'):
            self.store.request({'op':'correct','entity':'weekly_reviews','id':'2026-09-28','patch':{'week_start':'2026-09-21'},'expected_revision':fixed['revision'],'reason':'x','request_id':'fictional-move','source_text':'Fictional'})
        self.assertEqual(len(self.store.request({'op':'history','entity':'weekly_reviews','id':'2026-09-28'})), 3)
        read = self.store.request({'op':'weekly_reviews','from':'2026-09-01','to':'2026-09-30'})
        self.assertEqual([(r['week_start'], r['revision']) for r in read['records']], [('2026-09-28', fixed['revision'])])

    def test_week_must_be_a_monday_with_an_answer(self):
        for week in ('2026-10-04', '2026-09-29', '2026-9-28', None):
            with self.assertRaisesRegex(ValueError, 'Monday|calendar date'):
                self.store.request(weekly(week, 'Fictional', 'fictional-bad-week-'+str(week)))
        for answer in ('', '   ', None):
            with self.assertRaisesRegex(ValueError, 'answer'):
                self.store.request(weekly('2026-09-28', answer, 'fictional-bad-answer-'+repr(answer)))
        with self.assertRaises(sqlite3.IntegrityError):
            self.store.db.execute("INSERT INTO weekly_reviews VALUES('2026-10-04','Sunday is not a week start')")
        self.assertEqual(self.store.counts()['weekly_reviews'], 0)

    def test_frozen_copy_refuses_weekly_writes(self):
        (Path(self.tmp.name)/'FROZEN_BACKUP.json').write_text('{}')
        with self.assertRaisesRegex(ValueError, 'Frozen'):
            self.store.request(weekly('2026-09-28', 'Fictional', 'fictional-frozen'))

class MigrationTests(unittest.TestCase):
    NOTES = {'2026-09-20':'Weekly: Fictional quiet week',
             '2026-09-27':'Fictional topic line\nWeekly: Fictional shipped a prototype\nFictional closing line',
             '2026-09-28':'Weekly:',
             '2026-09-29':'Not a weekly line: Weekly: stays'}

    def test_migration_is_explicit_backed_up_moves_lines_and_audits_both_sides(self):
        with tempfile.TemporaryDirectory() as folder:
            version2_store(folder, self.NOTES)
            store = Store(folder)
            try:
                self.assertTrue(store.request({'op':'status'})['migration_required'])
                for request in ({'op':'rituals','from':'2026-09-01','to':'2026-09-30'}, weekly('2026-09-28','x','fictional-early')):
                    with self.assertRaisesRegex(ValueError, '--migrate'): store.request(request)
                self.assertEqual(store.request({'op':'export'})['schema_version'], 2)
                result = store.migrate()
                self.assertEqual((result['migrated'], result['from_version'], result['schema_version']), (True, 2, 3))
                self.assertEqual(result['moved_weekly_answers'], [{'date':'2026-09-20','week_start':'2026-09-14','lines':1},{'date':'2026-09-27','week_start':'2026-09-21','lines':1}])
                self.assertEqual(sha(Path(result['backup']).read_bytes()), result['backup_sha256'])
                with sqlite3.connect(result['backup']) as backup:
                    self.assertEqual(backup.execute('SELECT MAX(version) FROM schema_migrations').fetchone()[0], 2)
                    self.assertEqual(backup.execute("SELECT notes FROM rituals WHERE date='2026-09-20'").fetchone()[0], self.NOTES['2026-09-20'])
                self.assertEqual([dict(r) for r in store.db.execute('SELECT * FROM weekly_reviews ORDER BY week_start')],
                                 [{'week_start':'2026-09-14','answer':'Fictional quiet week'},{'week_start':'2026-09-21','answer':'Fictional shipped a prototype'}])
                notes = dict(store.db.execute('SELECT date,notes FROM rituals').fetchall())
                self.assertEqual(notes, {'2026-09-20':None,'2026-09-27':'Fictional topic line\nFictional closing line',
                                         '2026-09-28':'Weekly:','2026-09-29':self.NOTES['2026-09-29']})
                self.assertTrue(store.get('rituals','2026-09-27')['protein'])
                history = store.request({'op':'history','entity':'rituals','id':'2026-09-27'})
                self.assertEqual(json.loads(history[-1]['before_json'])['notes'], self.NOTES['2026-09-27'])
                self.assertEqual(history[-1]['action'], 'migrate')
                moved = store.request({'op':'history','entity':'weekly_reviews','id':'2026-09-21'})
                self.assertEqual((len(moved), moved[0]['action']), (1, 'migrate'))
                self.assertIn('2026-09-27', moved[0]['source_text'])
                self.assertEqual(store.migrate(), {'migrated':False,'schema_version':3})
                self.assertEqual(len(list((Path(folder)/'backups').glob('*.sqlite3'))), 1)
                # Normal writes resume and keep the revision guard working after the move.
                self.assertEqual(store.request(weekly('2026-09-21','Fictional addition','fictional-after'))['record']['answer'], 'Fictional shipped a prototype\nFictional addition')
            finally: store.close()
            again = Store(folder)
            try: self.assertEqual((again.schema_version, again.migration_required), (3, False))
            finally: again.close()

    def test_frozen_old_copy_reads_but_never_migrates(self):
        with tempfile.TemporaryDirectory() as folder:
            version2_store(folder, self.NOTES)
            (Path(folder)/'FROZEN_BACKUP.json').write_text('{}')
            store = Store(folder)
            try:
                self.assertEqual(store.request({'op':'rituals','from':'2026-09-01','to':'2026-09-30'})['count'], 4)
                with self.assertRaisesRegex(ValueError, 'Frozen'): store.migrate()
            finally: store.close()

    def test_cli_migrate_refreshes_views_and_never_creates_a_store(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            with self.assertRaises(local_client.StorageUnavailable): local_client.migrate(root)
            self.assertFalse((root/'data/ritual.sqlite3').exists())
            (root/'data').mkdir(); version2_store(root/'data', self.NOTES)
            result = local_client.migrate(root)
            self.assertTrue(result['migrated'] and result['dashboard']['updated'])
            self.assertEqual(result['dashboard']['weeks'], 2)
            self.assertIn('Fictional shipped a prototype', Path(result['dashboard']['weekly_path']).read_text())
            self.assertFalse(local_client.migrate(root)['migrated'])

    def test_restoring_a_version2_snapshot_applies_the_same_move(self):
        with tempfile.TemporaryDirectory() as old, tempfile.TemporaryDirectory() as new:
            version2_store(old, self.NOTES)
            source = Store(old)
            try: snapshot = source.request({'op':'export'})
            finally: source.close()
            target = Store(new)
            try:
                restored = target.request({'op':'restore','snapshot':snapshot})
                self.assertEqual(restored['source_data_sha256'], snapshot['data_sha256'])
                self.assertEqual(target.counts()['weekly_reviews'], 2)
                self.assertIsNone(target.get('rituals','2026-09-20')['notes'])
            finally: target.close()

class WeeklyViewTests(unittest.TestCase):
    def test_week_labels_span_months_and_years(self):
        self.assertEqual(dashboard.week_view({'week_start':'2026-09-21','answer':'x'})['display'], 'Sep 21 – 27')
        self.assertEqual(dashboard.week_view({'week_start':'2026-09-28','answer':'x'})['display'], 'Sep 28 – Oct 4')
        view = dashboard.week_view({'week_start':'2026-12-28','answer':'x'})
        self.assertEqual((view['display'], view['week_end']), ('Dec 28 – Jan 3', '2027-01-03'))
        self.assertEqual(view['full'], 'Week of Monday 28 December 2026 – Sunday 3 January 2027')

    def test_api_and_snapshot_expose_only_weekly_answers(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); store = Store(root/'data')
            try:
                store.request({'op':'ritual_put','date':'2026-09-27','patch':{'notes':'Fictional private note'},'request_id':'fictional-note','source_text':'Fictional private source words'})
                for week, key in (('2026-09-21','a'), ('2026-09-28','b')):
                    store.request(weekly(week, f'Fictional answer {key}\n<script>alert(1)</script>', 'fictional-weekly-'+key))
            finally: store.close()
            data = dashboard_web.weekly_data(root, dt.datetime.fromisoformat('2026-10-04T20:00:00+11:00'))
            self.assertEqual(set(data), {'generated_at','updated_display','timezone','count','weeks'})
            self.assertEqual([set(w) for w in data['weeks']], [{'week_start','week_end','display','full','answer'}]*2)
            self.assertEqual([w['week_start'] for w in data['weeks']], ['2026-09-28','2026-09-21'])
            raw = dashboard_web.weekly_response(root).decode()
            for private in ('Fictional private', 'source', 'revision', 'request_id', 'notes'):
                self.assertNotIn(private, raw)
            result = dashboard.generate(root)
            page = Path(result['weekly_path']).read_text()
            self.assertEqual(Path(result['weekly_path']).stat().st_mode & 0o777, 0o600)
            self.assertNotIn('Fictional private', page)
            self.assertNotIn('<script>alert', page)
            self.assertIn('&lt;script&gt;alert', page)
            self.assertIn('<title>Weekly review</title>', page)
            self.assertIn('<option value="ritual-dashboard.html">Daily rituals</option><option value="weekly-review.html" selected>Weekly review</option>', page)
            self.assertIn('>2 weeks</span>', page)
            self.assertNotIn('Fictional private', Path(result['path']).read_text())

    def test_empty_weekly_page(self):
        page = dashboard.render_weekly([], dt.datetime.now(dt.timezone.utc))
        self.assertIn('>0 weeks</span>', page)
        self.assertIn(dashboard.WEEKLY_EMPTY+'</p>', page)
        self.assertNotIn('<tr data-week=', page)
        self.assertEqual(page.count('<script>'), 1)

if __name__ == '__main__': unittest.main()
