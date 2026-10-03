import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
import local_client as client
from ritual import Store

REQ = {'op': 'ritual_put', 'date': '2026-10-02', 'patch': {'journalling': True}, 'request_id': 'test-cloud-held-1', 'source_text': 'Fictional validation only. Received at 2026-10-02T13:00:00Z; occurrence unknown.'}

class LocalClientTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.root = Path(self.tmp.name)
        Store(self.root/'data').close()
    def tearDown(self): self.tmp.cleanup()

    def test_direct_write_and_idempotent_replay(self):
        first = client.call(REQ, self.root)
        second = client.call(REQ, self.root)
        self.assertTrue(first['record']['journalling'])
        self.assertEqual(first['record']['checkins'], [])
        self.assertTrue(second['replayed'])
        self.assertEqual(first['revision'], second['revision'])

    def test_handoff_enqueues_then_replays(self):
        queued = client.enqueue(REQ, self.root)
        self.assertEqual(queued['status'], 'queued_on_mac')
        self.assertFalse(queued['database_confirmed'])
        self.assertEqual(client.call({'op':'status'}, self.root)['counts']['rituals'], 0)
        replay = client.replay(self.root)
        self.assertEqual(replay['remaining'], 0)
        self.assertEqual(len(list((self.root/'queue'/'sent').glob('*.json'))), 2)
        self.assertEqual(client.call({'op':'status'}, self.root)['counts']['rituals'], 1)

    def test_duplicate_delivery_after_lost_ack_is_safe(self):
        first = client.call(REQ, self.root)
        client.enqueue(REQ, self.root)
        result = client.replay(self.root)
        self.assertTrue(result['synced'][0]['replayed'])
        self.assertEqual(result['synced'][0]['revision'], first['revision'])

    def test_queue_conflicting_id_rejected(self):
        client.enqueue(REQ, self.root); client.enqueue(REQ, self.root)
        with self.assertRaisesRegex(ValueError, 'different content'):
            client.enqueue({**REQ, 'patch':{'journalling': False}}, self.root)

    def test_correction_requires_current_revision_and_preserves_source(self):
        first = client.call(REQ, self.root)
        correction = {'op':'correct','entity':'rituals','id':REQ['date'],'patch':{'journalling':False},'expected_revision':first['revision'],'reason':'Fictional correction','source_text':'Fictional user corrects original report','request_id':'test-correction'}
        client.enqueue(correction, self.root)
        self.assertEqual(client.replay(self.root)['remaining'], 0)
        history = client.call({'op':'history','entity':'rituals','id':REQ['date']}, self.root)
        self.assertEqual(len(history), 2)
        self.assertEqual(history[0]['source_text'], REQ['source_text'])

    def test_conflict_stops_replay_without_forcing_later_writes(self):
        first = client.call(REQ, self.root)
        bad = {'op':'correct','entity':'rituals','id':REQ['date'],'patch':{'journalling':False},'expected_revision':0,'reason':'Fictional stale correction','source_text':'Fictional stale report','request_id':'test-stale'}
        client.enqueue(bad, self.root)
        client.enqueue({**REQ,'date':'2026-10-03','request_id':'test-later'}, self.root)
        result = client.replay(self.root)
        self.assertTrue(result['requires_review'])
        self.assertEqual(result['remaining'], 2)
        self.assertEqual(client.call({'op':'status'}, self.root)['counts']['rituals'], 1)

    def test_storage_failure_queues_but_validation_failure_does_not(self):
        with patch.object(client, 'call', side_effect=client.StorageUnavailable('locked')):
            self.assertEqual(client.submit(REQ, self.root, True)['status'], 'queued_on_mac')
        with patch.object(client, 'call', side_effect=ValueError('conflict')):
            with self.assertRaises(ValueError): client.submit({**REQ,'request_id':'bad'}, self.root, True)
        self.assertEqual(len(list((self.root/'queue'/'pending').glob('*.json'))), 1)

    def test_no_automatic_empty_store_when_database_missing(self):
        missing = self.root/'other'
        with self.assertRaises(client.StorageUnavailable): client.call({'op':'status'}, missing)
        self.assertFalse((missing/'data'/'ritual.sqlite3').exists())

    def test_reads_do_not_queue_and_pending_payload_stays_exact(self):
        with self.assertRaises(ValueError): client.enqueue({'op':'status'}, self.root)
        client.enqueue(REQ, self.root)
        path = next((self.root/'queue'/'pending').glob('*.json'))
        self.assertEqual(json.loads(path.read_text())['request'], REQ)
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_frozen_backup_refuses_writes_and_keeps_reads(self):
        client.call(REQ, self.root)
        (self.root/'data'/'FROZEN_BACKUP.json').write_text('{}')
        self.assertEqual(client.call({'op':'status'}, self.root)['storage_role'], 'frozen_backup')
        with self.assertRaisesRegex(ValueError, 'Frozen backup copy'): client.call({**REQ,'request_id':'test-blocked'}, self.root)

    def test_init_creates_an_empty_store_once(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaises(client.StorageUnavailable): client.call({'op':'status'}, root)
            status = client.init(root)
            self.assertEqual(status['storage_role'], 'authoritative')
            self.assertEqual(sum(status['counts'].values()), 0)
            client.call(REQ, root)
            with self.assertRaisesRegex(ValueError, 'already exists'): client.init(root)
            self.assertEqual(client.call({'op':'status'}, root)['counts']['rituals'], 1)

    def test_export_roundtrip_after_queue_and_correction(self):
        client.enqueue(REQ, self.root); client.replay(self.root)
        snapshot = client.call({'op':'export'}, self.root)
        with tempfile.TemporaryDirectory() as directory:
            other = Store(directory)
            try:
                self.assertEqual(other.request({'op':'restore','snapshot':snapshot})['data_sha256'], snapshot['data_sha256'])
            finally: other.close()

if __name__ == '__main__': unittest.main(verbosity=2)
