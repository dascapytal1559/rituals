#!/usr/bin/env python3
"""Private Serve backend: one owner, one read-only page, loopback only."""
import datetime as dt
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import sys

import dashboard
from dashboard_web import CSP, frontend, json_response

ROOT = Path(__file__).resolve().parent.parent


def load_config(path):
    config = json.loads(Path(path).read_text())
    if set(config) != {'listen_host','listen_port','tailscale_hostname','owner_login'}:
        raise ValueError('Unexpected dashboard configuration fields')
    if config['listen_host'] != '127.0.0.1' or config['listen_port'] != 8765:
        raise ValueError('Dashboard must use the approved loopback address and port')
    hostname = config['tailscale_hostname']
    if not isinstance(hostname,str) or not re.fullmatch(r'[a-z0-9-]+\.[a-z0-9-]+\.ts\.net',hostname):
        raise ValueError('Expected a verified Tailscale hostname')
    owner = config['owner_login']
    if not isinstance(owner,str) or not owner or len(owner)>320 or owner != owner.strip() or not owner.isascii() or any(ord(c)<33 or ord(c)==127 for c in owner):
        raise ValueError('Expected the exact existing Tailscale login')
    return config




class DashboardServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    request_queue_size = 16

    def __init__(self,root,owner_login,hostname,port,renderer=json_response):
        self.root = Path(root).resolve()
        self.owner_login = owner_login
        self.hostname = hostname
        self.renderer = renderer
        super().__init__(('127.0.0.1',port),DashboardHandler)

    def handle_error(self,request,client_address):
        # No paths, headers, identities, or health content in logs.
        print('dashboard_request_failed',file=sys.stderr,flush=True)


class DashboardHandler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.0'
    server_version = 'RitualDashboard'
    sys_version = ''

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def log_message(self,format,*args):
        pass

    def reply(self,status,body,content_type='text/plain; charset=utf-8',allow=None):
        self.send_response(status)
        self.send_header('Content-Type',content_type)
        self.send_header('Content-Length',str(len(body)))
        self.send_header('Cache-Control','no-store')
        self.send_header('Pragma','no-cache')
        self.send_header('X-Content-Type-Options','nosniff')
        self.send_header('Referrer-Policy','no-referrer')
        self.send_header('Content-Security-Policy',CSP)
        self.send_header('X-Frame-Options','DENY')
        if allow: self.send_header('Allow',allow)
        self.send_header('Connection','close')
        self.end_headers()
        self.close_connection=True
        if self.command != 'HEAD': self.wfile.write(body)

    def send_error(self,code,message=None,explain=None):
        self.reply(code,b'Request rejected.\n')

    def authorized(self):
        identities=self.headers.get_all('Tailscale-User-Login',[])
        return (self.client_address[0]=='127.0.0.1' and len(identities)==1
                and identities[0].isascii()
                and hmac.compare_digest(identities[0],self.server.owner_login))

    def read_page(self):
        if not self.authorized():
            self.reply(403,b'Access denied.\n');return
        hosts=self.headers.get_all('Host',[])
        allowed={self.server.hostname,self.server.hostname+':443',
                 '127.0.0.1:'+str(self.server.server_port)}
        if len(hosts)!=1 or hosts[0] not in allowed:
            self.reply(400,b'Invalid request.\n');return
        if self.path not in ('/','/api/dashboard'):
            self.reply(404,b'Not found.\n');return
        if self.headers.get_all('Transfer-Encoding') or self.headers.get_all('Content-Length',[]) not in ([],['0']):
            self.reply(400,b'Invalid request.\n');return
        try:
            content=frontend() if self.path=='/' else self.server.renderer(self.server.root)
        except Exception:
            print('dashboard_render_failed',file=sys.stderr,flush=True)
            self.reply(503,b'Dashboard temporarily unavailable.\n');return
        self.reply(200,content,'text/html; charset=utf-8' if self.path=='/' else 'application/json; charset=utf-8')

    do_GET = read_page
    do_HEAD = read_page

    def reject_method(self):
        self.reply(405,b'Method not allowed.\n',allow='GET, HEAD')

    do_POST = reject_method
    do_PUT = reject_method
    do_PATCH = reject_method
    do_DELETE = reject_method
    do_OPTIONS = reject_method
    do_TRACE = reject_method
    do_CONNECT = reject_method


def main():
    os.umask(0o077)
    if len(sys.argv)!=1: raise ValueError('No command-line options accepted')
    config=load_config(ROOT/'config/dashboard-server.json')
    with DashboardServer(ROOT,config['owner_login'],config['tailscale_hostname'],config['listen_port']) as server:
        print('dashboard_listening_on_approved_loopback',flush=True)
        server.serve_forever(poll_interval=0.5)


if __name__=='__main__':
    try: main()
    except KeyboardInterrupt: pass
    except Exception:
        print('dashboard_start_failed',file=sys.stderr,flush=True)
        sys.exit(1)
