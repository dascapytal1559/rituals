"""Fresh sequential clients and cooperative edit ownership, only temporary stores."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import agent_work
from ritual import Store

APP=Path(__file__).resolve().parent.parent/'app'

class AgentHandoverTests(unittest.TestCase):
    def test_two_fresh_clients_replay_correct_and_restore(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            Store(root/'data').close()
            # Each action starts a new process: no hidden in-memory handover state.
            def client(action,request=None):
                code=('import json,sys;from pathlib import Path;import local_client as c;'
                      'r=Path(sys.argv[1]);q=json.loads(sys.argv[2]);'
                      'print(json.dumps(c.'+action+'(q,r)))') if action!='replay' else (
                      'import json,sys;from pathlib import Path;import local_client as c;'
                      'print(json.dumps(c.replay(Path(sys.argv[1]))))')
                import os
                result=subprocess.run([sys.executable,'-c',code,str(root),json.dumps(request)],
                      env={**os.environ,'PYTHONPATH':str(APP),'PYTHONDONTWRITEBYTECODE':'1'},capture_output=True,text=True)
                if result.returncode: raise ValueError(result.stderr)
                return json.loads(result.stdout)
            first={'op':'ritual_put','date':'2026-10-03','patch':{'journalling':True},
                   'request_id':'fictional-agent-a:ritual','source_text':'Fictional isolated report. Received2026-10-03T12:00:00Z; actual completion unknown.'}
            self.assertFalse(client('enqueue',first)['database_confirmed'])
            self.assertEqual(client('replay')['remaining'],0)
            retry=client('call',first)
            self.assertTrue(retry['replayed'])
            second={**first,'request_id':'fictional-agent-b:ritual','patch':{'protein':True}}
            saved=client('call',second)
            self.assertTrue(saved['record']['journalling'])
            self.assertEqual(saved['record']['checkins'],[])
            correction={'op':'correct','entity':'rituals','id':first['date'],'patch':{'protein':False},
                        'request_id':'fictional-agent-b:correct','source_text':'Fictional correction.',
                        'reason':'Fictional mistaken report','expected_revision':retry['revision']}
            with self.assertRaisesRegex(ValueError,'Revision conflict'): client('call',correction)
            correction['expected_revision']=saved['revision']
            final=client('call',correction)
            with self.assertRaises(ValueError): client('call',{**first,'patch':{'journalling':False}})
            history=client('call',{'op':'history','entity':'rituals','id':first['date']})
            self.assertEqual(len(history),3)
            self.assertEqual(history[0]['source_text'],first['source_text'])
            stale={**correction,'request_id':'fictional-stale-queued','expected_revision':saved['revision']}
            client('enqueue',stale)
            client('enqueue',{**first,'date':'2026-10-04','request_id':'fictional-later-held'})
            blocked=client('replay')
            self.assertEqual((blocked['status'],blocked['remaining']),('blocked',2))
            self.assertEqual(client('call',{'op':'status'})['counts']['rituals'],1)
            snapshot=client('call',{'op':'export'})
            with tempfile.TemporaryDirectory() as restored:
                other=Store(restored)
                try:
                    self.assertEqual(other.request({'op':'restore','snapshot':snapshot})['data_sha256'],snapshot['data_sha256'])
                    self.assertEqual(other.request(correction)['revision'],final['revision'])
                finally: other.close()

    def test_edit_claim_rejects_other_owner_then_allows_next_turn(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            self.assertFalse(agent_work.act(['status'],root)['claimed'])
            agent_work.act(['claim','fictional-a','UI'],root)
            with self.assertRaises(ValueError): agent_work.act(['claim','fictional-b','migration'],root)
            with self.assertRaises(ValueError): agent_work.act(['release','fictional-b'],root)
            agent_work.act(['release','fictional-a'],root)
            agent_work.act(['claim','fictional-b','UI'],root)
            agent_work.act(['release','fictional-b'],root)
