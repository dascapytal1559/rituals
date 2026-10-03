import datetime as dt
import hashlib
from html.parser import HTMLParser
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

import dashboard
import local_client
from ritual import Store

REAL_ROOT = Path(__file__).resolve().parent.parent

class WorkoutMetrics(HTMLParser):
    def __init__(self, page):
        super().__init__()
        self.title = None
        self.feed(page)

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if attrs.get('data-rate-habit') == 'workout':
            self.title = attrs['title']

class DashboardTests(unittest.TestCase):
    def test_isolated_database_matches_matrix_without_writing(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            store=Store(root/'data')
            try:
                store.request({'op':'ritual_put','date':'2026-10-01',
                    'patch':{'protein':False,'plank_seconds':60,'magnesium':True,'stretching':True,'journalling':True},
                    'request_id':'fictional-matrix','source_text':'Isolated test only'})
                store.request({'op':'workout_add','record':{'date':'2026-10-02','type':'Future type','details':''},
                    'request_id':'fictional-workout','source_text':'Isolated test only'})
            finally: store.close()
            dbfile=root/'data/ritual.sqlite3'
            before=hashlib.sha256(dbfile.read_bytes()).hexdigest()
            rituals,workouts=dashboard.read_records(root)
            rows=dashboard.matrix(rituals,workouts)
            self.assertEqual({r['date'] for r in rows},{r['date'] for r in rituals}|{w['date'] for w in workouts})
            by_date={r['date']:r for r in rows}
            for ritual in rituals:
                for field in (*dashboard.BOOLS,'plank_seconds'):
                    self.assertEqual(by_date[ritual['date']][field],ritual[field])
            self.assertEqual(sum(r['workout_count'] for r in rows),len(workouts))
            self.assertEqual(dashboard.plank(by_date['2026-10-01']['plank_seconds']),'1:00')
            self.assertIsNone(by_date['2026-10-02']['protein'])
            self.assertEqual(before,hashlib.sha256(dbfile.read_bytes()).hexdigest())

    def test_union_retains_workout_only_dates_and_exact_open_categories(self):
        rituals = [{'date':'2026-10-01',**dict.fromkeys(dashboard.BOOLS),'plank_seconds':None}]
        workouts = [{'id':str(i),'date':'2026-10-02','type':kind} for i,kind in enumerate(['run','gym-pull','run','Future Type / custom'])]
        rows = dashboard.matrix(rituals, workouts)
        self.assertEqual([r['date'] for r in rows], ['2026-10-02','2026-10-01'])
        self.assertFalse(rows[0]['has_ritual'])
        self.assertTrue(all(rows[0][k] is None for k in dashboard.BOOLS))
        self.assertEqual(rows[0]['activities'], ['run','gym-pull','Future Type / custom'])
        self.assertEqual(rows[0]['workout_count'], 4)
        self.assertEqual(rows[1]['activities'], [])

    def test_multiple_activities_join_existing_ritual_without_changing_flags(self):
        rituals = [{'date':'2026-10-01','magnesium':1,'protein':0,'stretching':None,'journalling':1,'plank_seconds':66}]
        workouts = [{'id':str(i),'date':'2026-10-01','type':kind} for i,kind in enumerate(['gym pull','run'])]
        row = dashboard.matrix(rituals, workouts)[0]
        self.assertEqual(row['activities'], ['gym pull','run'])
        self.assertEqual(row['protein'], 0)
        self.assertIsNone(row['stretching'])

    def test_boolean_and_plank_unknown_zero_and_seconds_are_distinct(self):
        self.assertIn('Done', dashboard.mark(True))
        self.assertIn('Not done', dashboard.mark(False))
        self.assertIn('Unreported', dashboard.mark(None))
        self.assertNotEqual(dashboard.mark(False),dashboard.mark(None))
        self.assertEqual([dashboard.plank(x) for x in (None,0,1,60,66,600)], [None,'0:00','0:01','1:00','1:06','10:00'])

    def test_activity_text_and_filter_values_cannot_inject_markup(self):
        value = '</script><img src=https://example.invalid onerror=alert(1)>'
        rows = dashboard.matrix([], [{'date':'2026-10-01','id':'example','type':value}])
        page = dashboard.render(rows,dt.datetime.now(dt.timezone.utc),REAL_ROOT)
        self.assertNotIn(value,page)
        self.assertIn('&lt;img',page)
        self.assertEqual(page.count('<script>'),1)
        self.assertIn('default-src &#x27;none&#x27;',page)

    def test_empty_database_renders_without_invented_dates(self):
        page = dashboard.render([],dt.datetime.now(dt.timezone.utc),REAL_ROOT)
        self.assertIn('>0 days</span>',page)
        self.assertIn('No dates recorded yet.',page)
        self.assertNotIn('<tr data-date=',page)
        self.assertIn('data-rate-habit="workout" title="0 of 0 closed days with a recorded workout">—</span>',page)

    def test_workout_percentage_counts_closed_dates_once_including_workout_only_days(self):
        rituals = [{'date':'2026-10-01',**dict.fromkeys(dashboard.BOOLS),'plank_seconds':None}]
        workouts = [
            {'id':str(i),'date':day,'type':kind}
            for i,(day,kind) in enumerate([
                ('2026-09-29','gym pull'),('2026-09-29','run'),('2026-09-29','run'),
                ('2026-09-30','Future open type'),('2026-10-02','bike'),('2026-10-03','walk')])]
        rows = dashboard.matrix(rituals,workouts)
        stamp = dt.datetime.fromisoformat('2026-10-02T12:00:00+10:00')
        report = dashboard.status_report(rituals,workouts,[],stamp)
        original_completion = json.dumps(report['completion'],sort_keys=True)
        page = dashboard.render(rows,stamp,REAL_ROOT,report)
        metrics = WorkoutMetrics(page)
        self.assertEqual(metrics.title,'2 of 3 closed days with a recorded workout')
        self.assertIn('>66.7%</span>',page)
        self.assertIn('Date <span class="header-metric">',page)
        self.assertIn('>5 days</span>',page)
        for removed in ('<select', 'id="month"', 'id="activity"', 'Ritual date'):
            self.assertNotIn(removed,page)
        self.assertEqual(original_completion,json.dumps(report['completion'],sort_keys=True))
        self.assertNotIn('workout',report['by_habit'])

    def test_workout_rate_obeys_noon_cutoff_across_dst_and_missing_dates(self):
        workouts = [{'id':'dst','date':'2026-10-03','type':'run'},
                    {'id':'later','date':'2026-10-05','type':'walk'}]
        rows = dashboard.matrix([],workouts)
        before = dt.datetime.fromisoformat('2026-10-04T11:59:59+11:00')
        page = dashboard.render(rows,before,REAL_ROOT)
        self.assertEqual(WorkoutMetrics(page).title,'0 of 0 closed days with a recorded workout')
        self.assertIn('data-rate-habit="workout" title="0 of 0 closed days with a recorded workout">—</span>',page)
        at_cutoff = before+dt.timedelta(seconds=1)
        self.assertEqual(WorkoutMetrics(dashboard.render(rows,at_cutoff,REAL_ROOT)).title,
                         '1 of 1 closed days with a recorded workout')
        later = dt.datetime.fromisoformat('2026-10-06T12:00:00+11:00')
        self.assertEqual(WorkoutMetrics(dashboard.render(rows,later,REAL_ROOT)).title,
                         '2 of 3 closed days with a recorded workout')

    def test_save_and_replay_refresh_snapshot_without_extra_revisions(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            Store(root/'data').close()
            req = {'op':'ritual_put','date':'2026-10-02','patch':{'protein':False,'plank_seconds':60},'request_id':'fictional-dashboard-check','source_text':'Isolated test only'}
            first = local_client.call(req,root)
            self.assertTrue(first['dashboard']['updated'])
            target = Path(first['dashboard']['path'])
            self.assertIn('1:00',target.read_text())
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)
            second = local_client.call(req,root)
            self.assertTrue(second['replayed'])
            self.assertEqual(first['revision'],second['revision'])
            self.assertEqual(local_client.call({'op':'status'},root)['counts']['changes'],1)

    def test_snapshot_failure_does_not_fail_or_queue_successful_save(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            Store(root/'data').close()
            req = {'op':'ritual_put','date':'2026-10-02','patch':{'journalling':True},'request_id':'fictional-view-failure','source_text':'Isolated test only'}
            with patch('dashboard.generate',side_effect=OSError('Read-only view folder')):
                result = local_client.submit(req,root,queue_on_failure=True)
            self.assertTrue(result['record']['journalling'])
            self.assertFalse(result['dashboard']['updated'])
            self.assertTrue(result['dashboard']['record_saved'])
            self.assertEqual(local_client.call({'op':'status'},root)['counts']['changes'],1)
            self.assertEqual(list((root/'queue/pending').glob('*.json')),[])

    def test_missing_database_does_not_create_empty_replacement(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(sqlite3.OperationalError): dashboard.generate(folder)
            self.assertFalse((Path(folder)/'data/ritual.sqlite3').exists())

if __name__ == '__main__': unittest.main()
