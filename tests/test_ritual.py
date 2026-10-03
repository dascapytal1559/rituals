import datetime as dt
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest

from ritual import Store, TZ, sha

# Made-up fixtures by default; RITUAL_FIXTURE_DIR can point at a local evidence folder instead.
HERE = Path(os.environ.get('RITUAL_FIXTURE_DIR', Path(__file__).resolve().parent/'fixtures'))
BUNDLE = json.loads((HERE / 'import-bundle.json').read_text())
PENDING = json.loads((HERE / 'pending-journalling-2026-09-30.json').read_text())

class RitualTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = Store(self.tmp.name)
        self.import_result = self.store.request({'op': 'import', 'bundle': BUNDLE})

    def tearDown(self):
        self.store.close()
        self.tmp.cleanup()

    def test_import_preserves_all_original_checkpoints_and_source_hashes(self):
        c = self.store.counts()
        self.assertEqual((c['rituals'], c['legacy_checkpoints'], c['workouts'], c['source_documents'], c['reminders']), (len(BUNDLE['rituals']), len(BUNDLE['checkpoints']), len(BUNDLE['workouts']), len(BUNDLE['documents']), 0))
        self.assertEqual(self.store.db.execute("SELECT COUNT(*) FROM legacy_checkpoints WHERE checkpoint='midday'").fetchone()[0], sum(r['checkpoint'] == 'midday' for r in BUNDLE['checkpoints']))
        for row in self.store.db.execute('SELECT content,sha256 FROM source_documents'):
            self.assertEqual(sha(row['content']), row['sha256'])
        self.assertEqual(self.store.db.execute('PRAGMA integrity_check').fetchone()[0], 'ok')

    def test_no_midday_showups_in_daily_evening_rows(self):
        r = self.store.get('rituals', '2026-08-24')
        self.assertEqual(r['checkins'], ['2026-08-24T15:01:00Z'])
        r = self.store.get('rituals', '2026-09-30')
        self.assertEqual(r['checkins'], ['2026-09-30T12:55:00Z', '2026-09-30T15:26:00Z'])

    def test_unknown_pause_and_no_are_distinct_from_true(self):
        self.assertIsNone(self.store.get('rituals', '2026-09-13')['protein'])
        self.assertIsNone(self.store.get('rituals', '2026-09-16')['magnesium'])
        self.assertIs(self.store.get('rituals', '2026-09-25')['protein'], False)
        self.assertIs(self.store.get('rituals', '2026-09-26')['protein'], True)
        self.assertIsNone(self.store.get('rituals', '2026-09-15')['plank_seconds'])
        self.assertEqual(self.store.get('rituals', '2026-09-30')['plank_seconds'], 66)

    def test_source_import_idempotent(self):
        before = self.store.counts()
        result = self.store.request({'op': 'import', 'bundle': BUNDLE})
        self.assertTrue(result['replayed'])
        self.assertEqual(before, self.store.counts())

    def test_real_journalling_receipt_is_not_a_showup_timestamp(self):
        before = self.store.get('rituals', '2026-09-30')['checkins']
        result = self.store.request(PENDING)
        self.assertIs(result['record']['journalling'], True)
        self.assertEqual(result['record']['checkins'], before)
        again = self.store.request(PENDING)
        self.assertTrue(again['replayed'])
        self.assertEqual(result['revision'], again['revision'])
        row = self.store.db.execute('SELECT source_text,before_json,after_json FROM changes WHERE request_id=?', (PENDING['request_id'],)).fetchone()
        self.assertIn('2026-09-30T17:06:13Z', row['source_text'])
        self.assertIn('Actual journalling occurrence time: unknown', row['source_text'])
        self.assertIsNone(json.loads(row['before_json'])['journalling'])
        self.assertIs(json.loads(row['after_json'])['journalling'], True)

    def test_source_id_conflict_rejected(self):
        self.store.request(PENDING)
        with self.assertRaisesRegex(ValueError, 'different content'):
            self.store.request({**PENDING, 'patch': {'journalling': False}})

    def test_correct_is_version_guarded_and_has_history(self):
        first = self.store.request(PENDING)
        correction = {'op': 'correct', 'entity': 'rituals', 'id': '2026-09-30', 'patch': {'journalling': None}, 'expected_revision': first['revision'], 'reason': 'Example correction: user says this belonged to a different day', 'source_text': 'test correction', 'request_id': 'test-correction'}
        result = self.store.request(correction)
        self.assertIsNone(result['record']['journalling'])
        with self.assertRaisesRegex(ValueError, 'Revision conflict'):
            self.store.request({**correction, 'request_id': 'test-stale-correction'})
        self.assertEqual(len(self.store.request({'op': 'history', 'entity': 'rituals', 'id': '2026-09-30'})), 3)

    def test_reports_before_checkin_do_not_invent_showup(self):
        result = self.store.request({'op': 'ritual_put', 'date': '2026-10-02', 'patch': {'stretching': True}, 'source_text': 'test stretch report', 'request_id': 'test-early'})
        self.assertEqual(result['record']['checkins'], [])
        result = self.store.request({'op': 'ritual_put', 'date': '2026-10-02', 'patch': {'checkins': ['2026-10-03T00:12:00+10:00']}, 'source_text': 'test evening checkin', 'request_id': 'test-showup'})
        self.assertTrue(result['record']['stretching'])
        self.assertEqual(len(result['record']['checkins']), 1)

    def test_workouts_are_four_columns_open_types_and_unlimited_rows(self):
        self.assertEqual([r['name'] for r in self.store.db.execute('PRAGMA table_info(workouts)')], ['id', 'date', 'type', 'details'])
        for i, kind in enumerate(['walk', 'gym pull', 'swim']):
            self.store.request({'op': 'workout_add', 'record': {'date': '2026-10-02', 'type': kind, 'details': 'test free text'}, 'source_text': 'test workout', 'request_id': 'test-workout-' + str(i)})
        result = self.store.request({'op': 'workouts', 'from': '2026-10-01', 'to': '2026-10-31', 'group_by': 'month'})
        self.assertEqual((result['count'], result['active_days']), (3, 1))
        self.assertEqual(result['groups'][0]['active_days'], 1)
        with self.assertRaisesRegex(ValueError, 'Unknown record fields'):
            self.store.request({'op': 'workout_add', 'record': {'date': '2026-10-02', 'type': 'run', 'details': '', 'distance': 5}, 'source_text': 'test', 'request_id': 'test-no-extra-column'})

    def test_due_reminders_independent_of_noon_review(self):
        first = self.store.request({'op': 'reminder_add', 'record': {'text': 'test Monday morning task', 'due_at': '2026-10-05T08:00:00+11:00'}, 'source_text': 'test fixture, not a real reminder', 'request_id': 'test-reminder'})
        self.store.request({'op': 'reminder_add', 'record': {'text': 'test stashed task'}, 'source_text': 'test fixture', 'request_id': 'test-stashed'})
        self.assertEqual(len(self.store.request({'op': 'reminders', 'mode': 'due', 'as_of': '2026-10-05T07:59:00+11:00'})['records']), 0)
        due = self.store.request({'op': 'reminders', 'mode': 'due', 'as_of': '2026-10-05T08:00:00+11:00'})
        self.assertEqual(len(due['records']), 1)
        self.assertEqual(len(self.store.request({'op': 'reminders', 'mode': 'review'})['records']), 2)
        self.store.request({'op': 'reminder_mark', 'id': first['record']['id'], 'status': 'delivered', 'expected_revision': first['revision'], 'reason': 'test delivery receipt', 'source_text': 'test fixture', 'request_id': 'test-delivered'})
        self.assertEqual(len(self.store.request({'op': 'reminders', 'as_of': '2026-10-05T12:00:00+11:00'})['records']), 0)

    def test_melbourne_dst_transition(self):
        self.assertEqual(dt.datetime(2026, 10, 3, 12, tzinfo=TZ).utcoffset(), dt.timedelta(hours=10))
        self.assertEqual(dt.datetime(2026, 10, 4, 12, tzinfo=TZ).utcoffset(), dt.timedelta(hours=11))

    def test_backup_precedes_write(self):
        result = self.store.request(PENDING)
        con = sqlite3.connect(result['backup'])
        self.assertIsNone(con.execute("SELECT journalling FROM rituals WHERE date='2026-09-30'").fetchone()[0])
        self.assertEqual(con.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
        con.close()

    def test_export_restore_roundtrip(self):
        self.store.request(PENDING)
        export = self.store.request({'op': 'export'})
        with tempfile.TemporaryDirectory() as directory:
            other = Store(directory)
            try:
                result = other.request({'op': 'restore', 'snapshot': export})
                self.assertEqual(result['data_sha256'], export['data_sha256'])
                self.assertTrue(other.request(PENDING)['replayed'])
                with self.assertRaisesRegex(ValueError, 'empty store'):
                    other.request({'op': 'restore', 'snapshot': export})
            finally: other.close()

    def test_indexes_support_date_and_type_queries(self):
        date_plan = str([tuple(r) for r in self.store.db.execute("EXPLAIN QUERY PLAN SELECT * FROM workouts WHERE date BETWEEN '2026-09-01' AND '2026-09-30'")])
        type_plan = str([tuple(r) for r in self.store.db.execute("EXPLAIN QUERY PLAN SELECT * FROM workouts WHERE type='run' AND date BETWEEN '2026-09-01' AND '2026-09-30'")])
        self.assertIn('idx_workouts_date', date_plan)
        self.assertIn('idx_workouts_type_date', type_plan)

    def test_tampered_source_rejected(self):
        modified = json.loads(json.dumps(BUNDLE))
        modified['documents'][0]['content'] += 'tampered'
        with self.assertRaisesRegex(ValueError, 'Source hash mismatch'):
            self.store.request({'op': 'import', 'bundle': modified})

if __name__ == '__main__': unittest.main(verbosity=2)
