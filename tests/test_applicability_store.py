import datetime as dt
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest

import dashboard
from applicability import closes_at, period, status_report
from ritual import Store, SCHEMA, TABLES, pack, sha

BUNDLE=json.loads((Path(os.environ.get('RITUAL_FIXTURE_DIR',Path(__file__).resolve().parent/'fixtures'))/'import-bundle.json').read_text())

def exception(habit,start,end,key=None):
    return {'op':'exception_add','record':{'habit':habit,'start_date':start,'end_date':end,'reason':'Isolated validation'},'request_id':key or 'test-exception-'+habit,'source_text':'Isolated test, not a live user entry'}

class ApplicabilityStoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(); self.root=Path(self.tmp.name); self.store=Store(self.root/'data')
        self.store.request({'op':'import','bundle':BUNDLE})
    def tearDown(self): self.store.close(); self.tmp.cleanup()
    def seed(self):
        for day in ('2026-09-15','2026-09-16'):
            self.store.request({'op':'correct','entity':'rituals','id':day,'patch':{'plank_seconds':60},'expected_revision':self.store.revision('rituals',day),'reason':'Test confirmed duration','request_id':'test-plank-'+day,'source_text':'Isolated test of confirmed duration'})
        for habit in ('magnesium','protein'): self.store.request(exception(habit,'2026-09-17','2026-09-24'))
        self.store.request(exception('planks',None,'2026-09-14'))
    def report(self,start='2026-08-23',end='2026-09-30',as_of='2026-10-02T12:00:00+10:00'):
        return self.store.request({'op':'ritual_status','from':start,'to':end,'as_of':as_of})

    def test_requested_historical_cases_and_denominators(self):
        self.seed(); result=self.report(); rows={r['date']:r for r in result['records']}
        magnesium=rows['2026-09-27']['habits']['magnesium']
        self.assertEqual(magnesium['status'],'not_done'); self.assertIsNone(magnesium['raw'])
        self.assertEqual(magnesium['basis'],'missing_after_close')
        for day in ('2026-09-17','2026-09-24'):
            for habit in ('magnesium','protein'): self.assertEqual(rows[day]['habits'][habit]['status'],'not_applicable')
        for day in ('2026-09-15','2026-09-16'):
            self.assertEqual(rows[day]['habits']['planks']['raw'],60)
            self.assertEqual(rows[day]['habits']['planks']['status'],'done')
        self.assertEqual(rows['2026-09-14']['habits']['planks']['status'],'not_applicable')
        self.assertEqual(result['by_habit']['planks']['applicable'],16)
        self.assertEqual(result['by_habit']['protein']['applicable'],31)
        self.assertEqual(result['completion']['applicable'],156)
        self.assertIsNone(self.store.get('rituals','2026-09-27')['magnesium'])

    def test_seed_idempotency_and_corrected_exception_history(self):
        request=exception('protein','2026-09-17','2026-09-24')
        first=self.store.request(request); second=self.store.request(request)
        self.assertTrue(second['replayed']); self.assertEqual(first['revision'],second['revision'])
        changed=self.store.request({'op':'correct','entity':'applicability_exceptions','id':first['record']['id'],'patch':{'reason':'Clarified test rationale'},'expected_revision':first['revision'],'reason':'Test correction','request_id':'test-exception-correct','source_text':'Isolated correction'})
        history=self.store.request({'op':'history','entity':'applicability_exceptions','id':first['record']['id']})
        self.assertEqual(len(history),2); self.assertEqual(changed['record']['start_date'],'2026-09-17')

    def test_overlap_rejected_without_inserting_second_exception(self):
        self.store.request(exception('protein','2026-09-17','2026-09-24'))
        with self.assertRaisesRegex(ValueError,'Overlapping'):
            self.store.request(exception('protein','2026-09-24','2026-09-25','test-overlap'))
        self.assertEqual(self.store.counts()['applicability_exceptions'],1)

    def test_numeric_and_source_only_positive_conflicts_stop(self):
        with self.assertRaisesRegex(ValueError,'Positive report'):
            self.store.request(exception('protein','2026-09-15','2026-09-17'))
        with self.assertRaisesRegex(ValueError,'Positive source plank'):
            self.store.request(exception('planks',None,'2026-09-16'))
        self.assertEqual(self.store.counts()['applicability_exceptions'],0)

    def test_new_positive_report_cannot_silently_override_exception(self):
        self.store.request(exception('protein','2026-09-17','2026-09-24'))
        with self.assertRaisesRegex(ValueError,'Positive report conflicts'):
            self.store.request({'op':'ritual_put','date':'2026-09-17','patch':{'protein':True},'request_id':'test-conflicting-report','source_text':'Isolated conflicting report'})
        self.assertIsNone(self.store.get('rituals','2026-09-17')['protein'])

    def test_late_actual_report_updates_past_derived_status(self):
        self.seed()
        before=self.report('2026-09-27','2026-09-27')['records'][0]
        self.assertEqual(before['habits']['magnesium']['status'],'not_done')
        previous=self.store.get('rituals','2026-09-27')
        self.store.request({'op':'correct','entity':'rituals','id':'2026-09-27','patch':{'magnesium':True},'expected_revision':self.store.revision('rituals','2026-09-27'),'reason':'Test late report','request_id':'test-late-magnesium','source_text':'Isolated late correction'})
        after=self.report('2026-09-27','2026-09-27')['records'][0]
        self.assertEqual(after['habits']['magnesium']['status'],'done')
        self.assertEqual(self.store.get('rituals','2026-09-27')['checkins'],previous['checkins'])

    def test_noon_boundary_and_current_day_expectations_without_insert(self):
        self.seed(); count=self.store.counts()['rituals']
        before=self.report('2026-09-30','2026-09-30','2026-10-01T11:59:59+10:00')
        after=self.report('2026-09-30','2026-09-30','2026-10-01T12:00:00+10:00')
        self.assertEqual(before['records'][0]['period'],'open'); self.assertEqual(before['completion']['applicable'],0)
        self.assertEqual(after['records'][0]['period'],'closed'); self.assertEqual(after['completion']['applicable'],5)
        self.assertEqual(after['active_period']['date'],'2026-10-01')
        self.assertFalse(after['active_period']['has_ritual'])
        self.assertEqual(self.store.counts()['rituals'],count)

    def test_zero_applicable_and_outside_coverage(self):
        self.seed()
        result=self.report('2026-08-23','2026-09-14')
        self.assertEqual(result['by_habit']['planks'],{'done':0,'applicable':0,'percentage':None})
        outside=self.report('2026-10-01','2026-10-31')
        self.assertEqual(outside['records'],[]); self.assertIsNone(outside['completion']['percentage'])

    def test_melbourne_noon_across_both_dst_changes(self):
        self.assertEqual(closes_at('2026-10-03').isoformat(),'2026-10-04T12:00:00+11:00')
        self.assertEqual(period('2026-10-04T00:59:59Z')['active_date'],'2026-10-03')
        self.assertEqual(period('2026-10-04T01:00:00Z')['active_date'],'2026-10-04')
        self.assertEqual(closes_at('2026-04-04').isoformat(),'2026-04-05T12:00:00+10:00')
        self.assertEqual(period('2026-04-05T01:59:59Z')['active_date'],'2026-04-04')
        self.assertEqual(period('2026-04-05T02:00:00Z')['active_date'],'2026-04-05')

    def test_version2_export_roundtrip_with_exceptions_and_audits(self):
        self.seed(); snapshot=self.store.request({'op':'export'})
        with tempfile.TemporaryDirectory() as folder:
            other=Store(folder)
            try:
                restored=other.request({'op':'restore','snapshot':snapshot})
                self.assertEqual(restored['data_sha256'],snapshot['data_sha256'])
                self.assertEqual(other.counts()['applicability_exceptions'],3)
            finally:other.close()

    def test_version1_export_restores_without_losing_original_tables(self):
        snapshot=self.store.request({'op':'export'})
        snapshot['schema_version']=1
        for table in ('applicability_exceptions','weekly_reviews'): snapshot['tables'].pop(table)
        snapshot['data_sha256']=sha(pack(snapshot['tables']))
        with tempfile.TemporaryDirectory() as folder:
            other=Store(folder)
            try:
                restored=other.request({'op':'restore','snapshot':snapshot})
                self.assertEqual(restored['source_data_sha256'],snapshot['data_sha256'])
                current=other.request({'op':'export'})['tables']
                self.assertEqual({k:current[k] for k in snapshot['tables']},snapshot['tables'])
                self.assertEqual((current['applicability_exceptions'],current['weekly_reviews']),([],[]))
            finally:other.close()

    def test_migration_is_backed_up_once_and_keeps_existing_schema_columns(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'ritual.sqlite3'
            with sqlite3.connect(path) as db:
                db.executescript(SCHEMA)
                db.execute("INSERT INTO schema_migrations VALUES(1,'old')")
                db.execute("INSERT INTO rituals(date,protein) VALUES('2026-09-27',NULL)")
            store=Store(folder)
            try:
                self.assertEqual(store.schema_version,2)
                self.assertIsNone(store.get('rituals','2026-09-27')['protein'])
                self.assertEqual([r[1] for r in store.db.execute('PRAGMA table_info(workouts)')],['id','date','type','details'])
                self.assertEqual([r[1] for r in store.db.execute('PRAGMA table_info(applicability_exceptions)')],['id','habit','start_date','end_date','reason'])
            finally:store.close()
            backups=list((Path(folder)/'backups').glob('*.sqlite3')); self.assertEqual(len(backups),1)
            with sqlite3.connect(backups[0]) as db:
                self.assertEqual(db.execute('SELECT version FROM schema_migrations').fetchall(),[(1,)])
                self.assertIsNone(db.execute("SELECT name FROM sqlite_master WHERE name='applicability_exceptions'").fetchone())
            Store(folder).close(); self.assertEqual(len(list((Path(folder)/'backups').glob('*.sqlite3'))),1)

    def test_dashboard_cells_use_derived_status_and_preserve_durations(self):
        self.seed(); result=dashboard.generate(self.root)
        page=Path(result['path']).read_text()
        import re
        def row(day):return re.search('<tr data-date="'+day+'".*?</tr>',page,re.S).group(0)
        self.assertIn('data-field="magnesium" data-status="not_done"',row('2026-09-27'))
        self.assertIn('data-field="protein" data-status="not_applicable"',row('2026-09-17'))
        for day in ('2026-09-15','2026-09-16'):self.assertIn('1:00',row(day))
        self.assertIn('data-field="plank_seconds" data-status="not_applicable"',row('2026-09-14'))
        self.assertIn('data-rate-habit="planks"',page)

    def test_gap_inside_coverage_is_view_only_and_future_not_added(self):
        rows=[{'date':'2026-09-01','protein':True},{'date':'2026-09-03','protein':True}]
        result=status_report(rows,[],[],'2026-09-04T12:00:00+10:00')
        self.assertEqual([r['date'] for r in result['records']],['2026-09-01','2026-09-02','2026-09-03'])
        self.assertFalse(result['records'][1]['has_ritual'])
        self.assertEqual(result['records'][1]['habits']['protein']['basis'],'missing_after_close')
        self.assertEqual(len(rows),2)

if __name__=='__main__':unittest.main()
