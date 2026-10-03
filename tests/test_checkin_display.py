import datetime as dt
import hashlib
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import dashboard
import dashboard_web
from ritual import Store


class Cells(HTMLParser):
    def __init__(self, page):
        super().__init__()
        self.rows = []
        self.current = None
        self.checkin = False
        self.headers = []
        self.feed(page)

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'tr' and 'data-date' in attrs:
            self.current = {'date':attrs['data-date'], 'times':[], 'text':[]}
            self.rows.append(self.current)
        if tag == 'td':
            self.checkin = attrs.get('class') == 'checkin'
        if self.checkin and tag == 'time':
            self.current['times'].append(attrs)
        if tag == 'th' and attrs.get('scope') == 'col':
            self.headers.append(attrs)

    def handle_data(self, text):
        if self.checkin:
            self.current['text'].append(text)

    def handle_endtag(self, tag):
        if tag == 'td':
            self.checkin = False


class CheckinDisplayTests(unittest.TestCase):
    def row(self, day='2026-09-30', times=None):
        return {'date':day,'checkins':times or [],**dict.fromkeys(dashboard.BOOLS),
                'plank_seconds':None}

    def test_september_30_shows_initial_time_and_preserves_both_records(self):
        row = self.row(times=['2026-09-30T15:26:00Z','2026-09-30T12:55:00Z'])
        original = list(row['checkins'])
        items = dashboard.checkin_times(row)
        self.assertEqual([r['text'] for r in items], ['22:55'])
        self.assertEqual(items[0]['datetime'],'2026-09-30T22:55:00+10:00')
        self.assertEqual(row['checkins'],original)

    def test_later_updates_do_not_replace_initial_after_midnight_time(self):
        row = self.row('2026-10-02',['2026-10-02T15:30:00Z','2026-10-02T14:44:00Z'])
        row.update(magnesium=True,protein=True)
        items = dashboard.checkin_times(row)
        self.assertEqual(len(items),1)
        self.assertEqual((items[0]['text'],items[0]['day_label']),('00:44','+1 day'))
        self.assertEqual(len(row['checkins']),2)

    def test_missing_does_not_infer_from_completion_or_workout(self):
        row = self.row('2026-10-03')
        row.update(protein=True,stretching=True)
        self.assertEqual(dashboard.checkin_times(row), [])
        self.assertIn('No evening check-in recorded',dashboard.checkin_cell(row))
        activity = dashboard.matrix([], [{'id':'x','date':'2026-10-03','type':'run'}])[0]
        self.assertEqual(dashboard.checkin_times(activity), [])

    def test_offsets_and_actual_dst_conversion(self):
        row = self.row('2026-10-03',['2026-10-03T15:59:00Z','2026-10-03T16:01:00Z'])
        items = dashboard.checkin_times(row)
        self.assertEqual([r['text'] for r in items], ['01:59'])
        self.assertTrue(items[0]['datetime'].endswith('+10:00'))
        after = dashboard.checkin_times(self.row('2026-10-03',['2026-10-03T16:01:00Z']))
        self.assertEqual(after[0]['text'],'03:01')
        self.assertTrue(after[0]['datetime'].endswith('+11:00'))
        self.assertTrue(all(r['day_label']=='+1 day' for r in items))
        later = dashboard.checkin_times(self.row('2026-10-01',['2026-10-03T16:01:00Z']))
        self.assertEqual(later[0]['day_label'],'+3 days')

    def test_timezone_is_required_and_equivalent_instants_not_duplicated(self):
        with self.assertRaises(ValueError):
            dashboard.checkin_times(self.row(times=['2026-09-30T22:55:00']))
        items = dashboard.checkin_times(self.row(times=['2026-09-30T12:55:00Z','2026-09-30T22:55:00+10:00']))
        self.assertEqual(len(items),1)

    def test_receipt_basis_requires_matching_added_timestamp_and_stays_private(self):
        stamp='2026-10-02T13:21:59Z'
        event={'entity_id':'2026-10-02','action':'ritual_put',
               'before_json':json.dumps({'checkins':[]}),
               'after_json':json.dumps({'checkins':[stamp]}),
               'source_text':'Private words. Received 2026-10-02T13:21:59Z. Private ID.'}
        origins=dashboard.checkin_origins([event])
        row=self.row('2026-10-02',[stamp]);row['_checkin_origins']=origins[row['date']]
        item=dashboard.checkin_times(row)[0]
        self.assertEqual(item['basis'],'message_received')
        self.assertIn('receipt time',item['label'])
        self.assertNotIn('message received',dashboard.checkin_cell(row))
        self.assertIn('receipt time',dashboard.checkin_cell(row))
        self.assertNotIn('Private',json.dumps(item))
        # An unrelated later report cannot reinterpret an existing check-in.
        event['before_json']=event['after_json'];event['source_text']='Received 2026-10-02T14:00:00Z'
        self.assertEqual(dashboard.checkin_origins([event])['2026-10-02'],{})

    def test_corrected_timestamp_does_not_keep_old_receipt_qualification(self):
        old='2026-10-02T13:21:59Z';new='2026-10-02T13:15:00Z'
        events=[{'entity_id':'2026-10-02','action':'ritual_put','before_json':None,
                 'after_json':json.dumps({'checkins':[old]}),'source_text':'Received at: '+old},
                {'entity_id':'2026-10-02','action':'correct','before_json':json.dumps({'checkins':[old]}),
                 'after_json':json.dumps({'checkins':[new]}),'source_text':'Reported actual check-in time; received 2026-10-02T14:00:00Z'}]
        result=dashboard.checkin_origins(events)['2026-10-02']
        self.assertNotIn(dashboard.checkin_instant(old),result)
        self.assertEqual(result[dashboard.checkin_instant(new)],'recorded')

    def test_isolated_import_read_does_not_mix_in_midday_or_write(self):
        bundle=json.loads((Path(os.environ.get('RITUAL_FIXTURE_DIR',Path(__file__).resolve().parent/'fixtures'))/'import-bundle.json').read_text())
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);store=Store(root/'data')
            try:
                store.request({'op':'import','bundle':bundle})
                store.request({'op':'ritual_put','date':'2026-10-01',
                    'patch':{'checkins':['2026-10-01T14:44:39Z']},'request_id':'fictional-receipt',
                    'source_text':'Fictional Checking in. Received at2026-10-01T14:44:39Z; actual physical instant unknown.'})
                store.request({'op':'ritual_put','date':'2026-10-03','patch':{'protein':True},
                    'request_id':'fictional-habit-only','source_text':'Fictional habit report only'})
            finally: store.close()
            db=root/'data/ritual.sqlite3';before=hashlib.sha256(db.read_bytes()).hexdigest()
            rituals,_=dashboard.read_records(root);rows={r['date']:r for r in rituals}
            old=dashboard.checkin_times(rows['2026-08-24'])
            self.assertEqual([(r['text'],r['day_label']) for r in old],[('01:01','+1 day')])
            self.assertEqual(old[0]['basis'],'source_recorded')
            item=dashboard.checkin_times(rows['2026-10-01'])[0]
            self.assertEqual((item['text'],item['day_label'],item['basis']),('00:44','+1 day','message_received'))
            self.assertEqual(dashboard.checkin_times(rows['2026-10-03']),[])
            self.assertEqual(before,hashlib.sha256(db.read_bytes()).hexdigest())

    def test_static_and_api_match_and_percentage_inputs_are_unchanged(self):
        stamp=dt.datetime.fromisoformat('2026-10-03T20:00:00+10:00')
        rituals=[self.row(),self.row('2026-10-01',['2026-10-01T14:44:39Z']),
                 self.row('2026-10-02',['2026-10-02T13:21:59Z']),self.row('2026-10-03')]
        rituals[0]['checkins']=['2026-09-30T12:55:00Z','2026-09-30T15:26:00Z']
        rituals[2]['_checkin_origins']={dashboard.checkin_instant('2026-10-02T13:21:59Z'):'message_received'}
        original=json.dumps([{k:v for k,v in r.items() if not k.startswith('_')} for r in rituals],sort_keys=True)
        workouts=[{'id':'one','date':'2026-10-01','type':'gym push'}]
        report=dashboard.status_report(rituals,workouts,[],stamp)
        page=dashboard.render(dashboard.matrix(rituals,workouts),stamp,Path('/unused'),report)
        parsed=Cells(page)
        self.assertEqual(len(parsed.headers),8)
        self.assertEqual(parsed.headers[1]['class'],'checkin-col')
        self.assertNotIn('data-rate',dashboard.CHECKIN_HEADER)
        with patch('dashboard.read_records',return_value=(rituals,workouts,[])):
            data=dashboard_web.dashboard_data(Path('/unused'),stamp)
        for actual,api in zip(parsed.rows,data['rows']):
            self.assertEqual(actual['date'],api['date'])
            self.assertEqual([t['datetime'] for t in actual['times']], [t['datetime'] for t in api['checkin_times']])
            self.assertEqual(actual['text'], [t['text'] for t in api['checkin_times']] or ['—'])
        self.assertEqual(data['rates']['workout']['percentage'],100/3)
        self.assertNotIn('checkin_times',data['rates'])
        self.assertEqual(original,json.dumps([{k:v for k,v in r.items() if not k.startswith('_')} for r in rituals],sort_keys=True))


if __name__=='__main__':
    unittest.main()
