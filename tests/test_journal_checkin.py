"""Journal defaults through the real transactional store and local queue API.

All reports here are fictional and use temporary stores.
"""
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import tempfile
import threading
import unittest

import dashboard_web
import local_client as client
from ritual import Store


class JournalCheckinTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        Store(self.root/'data').close()

    def tearDown(self):
        self.tmp.cleanup()

    def journal(self, ident='fictional-first-journal', stamp='2026-10-08T22:15:00+11:00', patch=None):
        return {'op':'ritual_put','date':'2026-10-08',
                'patch':{'journalling':True} if patch is None else patch,
                'journal_entry_at':stamp,'request_id':ident,
                'source_text':'Fictional journal. Received at '+stamp+'. Original receipt supplies authorized journal default; actual physical arrival/completion unknown.'}

    def row(self):
        return client.call({'op':'rituals','from':'2026-10-08','to':'2026-10-08'},self.root)['records'][0]

    def history(self):
        return client.call({'op':'history','entity':'rituals','id':'2026-10-08'},self.root)

    def test_first_journal_defaults_without_inventing_other_habits(self):
        first = client.call(self.journal(),self.root)
        self.assertEqual(first['record']['checkins'],['2026-10-08T11:15:00Z'])
        self.assertIs(first['record']['journalling'],True)
        self.assertIsNone(first['record']['protein'])
        self.assertIsNone(first['record']['plank_seconds'])
        event = self.history()[0]
        self.assertEqual(event['source_text'],self.journal()['source_text'])
        self.assertEqual(json.loads(event['after_json'])['checkins'],first['record']['checkins'])

    def test_empty_patch_records_only_the_authorized_default(self):
        first = client.call(self.journal(patch={}),self.root)
        self.assertEqual(first['record']['checkins'],['2026-10-08T11:15:00Z'])
        self.assertIsNone(first['record']['journalling'])

    def test_explicit_first_is_preserved_even_when_journal_instant_is_earlier(self):
        explicit = client.call({'op':'ritual_put','date':'2026-10-08',
            'patch':{'checkins':['2026-10-08T22:00:00+11:00'],'protein':True},
            'request_id':'fictional-explicit','source_text':'Fictional explicit check-in. Received at 2026-10-08T22:00:00+11:00; exact physical instant unknown.'},self.root)
        after = client.call(self.journal(stamp='2026-10-08T21:00:00+11:00'),self.root)
        self.assertEqual(after['record']['checkins'],explicit['record']['checkins'])
        self.assertIs(after['record']['protein'],True)

    def test_explicit_patch_wins_over_default_in_the_same_request(self):
        after = client.call(self.journal(patch={'checkins':['2026-10-08T22:00:00+11:00']}),self.root)
        self.assertEqual(after['record']['checkins'],['2026-10-08T11:00:00Z'])

    def test_continuation_and_exact_retry_leave_default_stable(self):
        req = self.journal()
        first = client.call(req,self.root)
        retry = client.call(req,self.root)
        self.assertTrue(retry['replayed'])
        self.assertEqual(retry['revision'],first['revision'])
        later = client.call(self.journal('fictional-continuation','2026-10-09T02:10:00+11:00',{}),self.root)
        self.assertEqual(later['record']['checkins'],first['record']['checkins'])
        self.assertEqual(len(self.history()),2)
        with self.assertRaisesRegex(ValueError,'different content'):
            client.call({**req,'journal_entry_at':'2026-10-09T02:10:00+11:00'},self.root)

    def test_offline_replay_uses_original_instant_and_deduplicates_lost_ack(self):
        req = self.journal()
        client.enqueue(req,self.root)
        first_replay = client.replay(self.root)
        self.assertEqual(first_replay['remaining'],0)
        first_revision = self.row()['revision']
        client.enqueue(req,self.root)
        second_replay = client.replay(self.root)
        self.assertTrue(second_replay['synced'][0]['replayed'])
        self.assertEqual(self.row()['revision'],first_revision)
        self.assertEqual(self.row()['checkins'],['2026-10-08T11:15:00Z'])
        self.assertEqual(len(self.history()),1)

    def test_after_midnight_keeps_logical_date_and_receipt_qualification(self):
        req = self.journal(stamp='2026-10-09T01:15:00+11:00')
        req['source_text'] += ' Logical ritual date is prior evening October 8, not date of receipt.'
        first = client.call(req,self.root)
        self.assertEqual(first['record']['date'],'2026-10-08')
        self.assertEqual(first['record']['checkins'],['2026-10-08T14:15:00Z'])
        item = dashboard_web.dashboard_data(self.root)['rows'][0]['checkin_times'][0]
        self.assertEqual((item['text'],item['day_offset'],item['basis']),('01:15',1,'message_received'))
        self.assertTrue(item['datetime'].endswith('+11:00'))
        self.assertIn('receipt time',item['label'])

    def test_invalid_naive_timestamp_does_not_create_a_record(self):
        with self.assertRaisesRegex(ValueError,'UTC offset'):
            client.call(self.journal(stamp='2026-10-08T22:15:00'),self.root)
        self.assertEqual(client.call({'op':'rituals','from':'2026-10-08','to':'2026-10-08'},self.root)['records'],[])
        self.assertEqual(self.history(),[])

    def test_correction_history_survives_original_retry_and_continuation(self):
        req = self.journal()
        first = client.call(req,self.root)
        corrected = client.call({'op':'correct','entity':'rituals','id':'2026-10-08',
            'patch':{'checkins':['2026-10-08T22:05:00+11:00']},'expected_revision':first['revision'],
            'reason':'Fictional user supplies corrected check-in','request_id':'fictional-correction',
            'source_text':'Fictional corrected check-in; original default retained in history.'},self.root)
        client.call(req,self.root)
        self.assertEqual(self.row()['checkins'],corrected['record']['checkins'])
        continuation = client.call(self.journal('fictional-after-correction','2026-10-09T02:10:00+11:00',{}),self.root)
        self.assertEqual(continuation['record']['checkins'],corrected['record']['checkins'])
        self.assertEqual(len(self.history()),3)
        self.assertEqual(json.loads(self.history()[1]['before_json'])['checkins'],first['record']['checkins'])

    def test_two_agents_cannot_add_two_competing_defaults(self):
        barrier = threading.Barrier(2)
        def write(req):
            store = Store(self.root/'data')
            try:
                barrier.wait(timeout=5)
                return store.request(req)
            finally:
                store.close()
        requests = [self.journal('fictional-agent-a'),self.journal('fictional-agent-b','2026-10-08T22:20:00+11:00')]
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(write,requests))
        first = min(results,key=lambda r:r['revision'])
        self.assertEqual(self.row()['checkins'],first['record']['checkins'])
        self.assertEqual(len(self.row()['checkins']),1)
        self.assertEqual(len(self.history()),2)


if __name__ == '__main__':
    unittest.main()
