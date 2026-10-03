import datetime as dt
import hashlib
import http.client
import json
from pathlib import Path
import socket
import sqlite3
import tempfile
import threading
import unittest
from unittest.mock import patch
import dashboard_server
from ritual import Store

class ServerTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
  self.store=Store(self.root/'data')
  self.server=dashboard_server.DashboardServer(self.root,'owner@example.invalid','test.tail123.ts.net',0)
  self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
 def tearDown(self):
  self.server.shutdown();self.server.server_close();self.thread.join();self.store.close();self.temp.cleanup()
 def request(self,method='GET',path='/',identity='owner@example.invalid',headers=None):
  h={} if identity is None else {'Tailscale-User-Login':identity}
  h.update(headers or {})
  conn=http.client.HTTPConnection('127.0.0.1',self.server.server_port,timeout=5)
  conn.request(method,path,headers=h)
  res=conn.getresponse();out=(res.status,dict(res.getheaders()),res.read());conn.close();return out
 def test_only_exact_owner_is_accepted(self):
  self.assertEqual(self.server.server_address[0],'127.0.0.1')
  for identity in (None,'other@example.invalid','OWNER@example.invalid','', 'owner@example.invalid,other@example.invalid'):
   status,headers,body=self.request(identity=identity)
   self.assertEqual(status,403);self.assertNotIn(b'Daily ritual',body)
   self.assertEqual(self.request(path='/api/dashboard',identity=identity)[0],403)
  status,headers,body=self.request()
  self.assertEqual(status,200);self.assertIn(b'Daily ritual',body)
  self.assertEqual(headers['Cache-Control'],'no-store')
  self.assertIn("frame-ancestors 'none'",headers['Content-Security-Policy'])
 def test_duplicate_identity_rejected(self):
  with socket.create_connection(('127.0.0.1',self.server.server_port),timeout=5) as sock:
   req=('GET / HTTP/1.0\r\nHost: 127.0.0.1:'+str(self.server.server_port)+'\r\nTailscale-User-Login: owner@example.invalid\r\nTailscale-User-Login: owner@example.invalid\r\n\r\n').encode()
   sock.sendall(req);self.assertIn(b'403',sock.recv(1024).split(b'\r\n')[0])
 def test_no_file_paths_queries_or_write_methods(self):
  for path in ('/data/ritual.sqlite3','/../AGENTS.md','/%2e%2e/config/dashboard-server.json','/?download=1','/evidence/','//data/ritual.sqlite3','/api/rituals'):
   self.assertEqual(self.request(path=path)[0],404,path)
  for method in ('POST','PUT','PATCH','DELETE','OPTIONS','TRACE','CONNECT'):
   status,headers,body=self.request(method=method)
   self.assertEqual(status,405,method);self.assertEqual(headers['Allow'],'GET, HEAD')
 def test_head_host_and_body_handling(self):
  status,headers,body=self.request(method='HEAD')
  self.assertEqual(status,200);self.assertEqual(body,b'');self.assertGreater(int(headers['Content-Length']),0)
  self.assertEqual(self.request(headers={'Host':'attacker.invalid'})[0],400)
  self.assertEqual(self.request(headers={'Content-Length':'8'})[0],400)
 def test_fresh_data_and_no_database_or_snapshot_writes(self):
  self.assertEqual(json.loads(self.request(path='/api/dashboard')[2])['count'],0)
  self.store.request({'op':'ritual_put','date':'2026-09-27','patch':{'protein':True},'request_id':'isolated-server-test','source_text':'Test fixture only'})
  database=self.root/'data/ritual.sqlite3';before=hashlib.sha256(database.read_bytes()).hexdigest()
  status,headers,body=self.request(path='/api/dashboard')
  self.assertEqual(status,200);self.assertIn('Sun · Sep 27'.encode(),body)
  self.assertEqual(before,hashlib.sha256(database.read_bytes()).hexdigest())
  self.assertFalse((self.root/'data/views').exists())
  page=self.request()[2]
  self.assertIn(b'width=device-width',page);self.assertIn(b'@media(max-width:760px)',page)
  self.assertIn(b'overflow:auto',page);self.assertIn(b'position:sticky',page)
 def test_database_opened_read_only(self):
  original=sqlite3.connect;seen=[]
  def checked(database_uri,*args,**kwargs):
   self.assertIn('?mode=ro',database_uri);db=original(database_uri,*args,**kwargs)
   with self.assertRaises(sqlite3.OperationalError):db.execute('CREATE TABLE unauthorized_write(x)')
   db.rollback()
   seen.append(True);return db
  with patch('dashboard.sqlite3.connect',side_effect=checked):self.assertEqual(self.request(path='/api/dashboard')[0],200)
  self.assertEqual(seen,[True])
 def test_errors_do_not_leak_local_data(self):
  def fail(root):raise RuntimeError('private raw health source and local path')
  self.server.renderer=fail
  status,headers,body=self.request(path='/api/dashboard')
  self.assertEqual(status,503);self.assertNotIn(b'private',body);self.assertNotIn(str(self.root).encode(),body)
 def test_configuration_fails_closed(self):
  path=self.root/'config.json'
  good={'listen_host':'127.0.0.1','listen_port':8765,'tailscale_hostname':'test.tail123.ts.net','owner_login':'owner@example.invalid'}
  path.write_text(json.dumps(good));self.assertEqual(dashboard_server.load_config(path),good)
  for key,value in [('listen_host','0.0.0.0'),('listen_port',80),('owner_login',''),('tailscale_hostname','public.example')]:
   path.write_text(json.dumps({**good,key:value}))
   with self.assertRaises(ValueError):dashboard_server.load_config(path)

if __name__=='__main__':unittest.main()
