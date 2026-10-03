"""Control the existing approved named app, without modifying its configuration."""
import json
import os
from pathlib import Path
import plistlib
import re
import subprocess
import socket
import errno
import sys
import time
import urllib.error
import urllib.request

ROOT=Path(__file__).resolve().parent.parent
LABEL='local.ritual-dashboard'

def command(args):
    return subprocess.run(['/bin/launchctl',*args],capture_output=True,text=True)

def validate():
    plist=Path.home()/'Library/LaunchAgents'/f'{LABEL}.plist'
    cfg=plistlib.loads(plist.read_bytes())
    executable=Path.home()/'Applications/Ritual Dashboard.app/Contents/MacOS/RitualDashboard'
    if cfg.get('Label')!=LABEL or cfg.get('ProgramArguments')!=[str(executable)]:
        raise ValueError('Existing LaunchAgent identity/program differs; review instead of changing it')
    if not executable.is_file(): raise ValueError('Named app missing; no alternate service will be started')
    return plist,f'gui/{os.getuid()}',executable

def probe():
    # Owner comes from existing private config only; never output headers/config.
    from dashboard_server import load_config
    cfg=load_config(ROOT/'config/dashboard-server.json')
    req=urllib.request.Request('http://127.0.0.1:8765/api/dashboard',
          headers={'Tailscale-User-Login':cfg['owner_login']})
    try:
        opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(req,timeout=2) as response:
            value=json.loads(response.read())
            return {'ready':response.status==200,'rows':value['count']}
    except urllib.error.HTTPError as exc:
        raise RuntimeError('Existing backend rejected readiness request; review config/service identity') from exc
    except urllib.error.URLError as exc:
        if getattr(exc.reason,'errno',None) in (1,13):
            raise RuntimeError('Network readiness probe blocked by execution permissions; use authorized Mac execution, not a service/config change') from exc
        if getattr(exc.reason,'errno',None) not in (61,111):
            raise RuntimeError('Readiness probe failed ambiguously; inspect service before restarting') from exc
        return {'ready':False}
    except (OSError,ValueError) as exc:
        raise RuntimeError('Readiness probe failed ambiguously; inspect service before restarting') from exc

def status(domain):
    result=command(['print',domain+'/'+LABEL])
    return {'loaded':result.returncode==0,**probe()}

def port_open():
    # Port occupancy, not an HTTP response, determines whether shutdown completed.
    with socket.socket(socket.AF_INET,socket.SOCK_STREAM) as connection:
        connection.settimeout(2)
        code=connection.connect_ex(('127.0.0.1',8765))
    if code==0: return True
    if code==errno.ECONNREFUSED: return False
    raise RuntimeError('Port occupancy probe blocked or ambiguous; do not start a second service')

def stop(domain):
    probe()  # Verify probe permission before any mutation.
    job=command(['print',domain+'/'+LABEL])
    loaded=job.returncode==0
    match=re.search(r'^\s*pid = (\d+)\s*$',job.stdout,re.M)
    old_pid=int(match.group(1)) if match else None
    if loaded:
        result=command(['bootout',domain+'/'+LABEL])
        if result.returncode: raise RuntimeError('Existing LaunchAgent could not be stopped')
    # bootout sends SIGTERM; named app joins its own child on shutdown.
    for _ in range(60):
        job_gone=command(['print',domain+'/'+LABEL]).returncode!=0
        alive=False
        if old_pid:
            try: os.kill(old_pid,0);alive=True
            except ProcessLookupError: pass
        if job_gone and not alive and not port_open(): return
        time.sleep(0.2)
    raise RuntimeError('Named app/job or backend is still shutting down; do not start a second service')

def start(plist,domain):
    probe()  # Verify probe permission before any mutation.
    loaded=command(['print',domain+'/'+LABEL]).returncode==0
    result=command(['kickstart',domain+'/'+LABEL]) if loaded else command(['bootstrap',domain,str(plist)])
    if result.returncode: raise RuntimeError('Existing LaunchAgent could not be started')
    for _ in range(60):
        if probe()['ready']: return
        time.sleep(0.2)
    raise RuntimeError('Named app did not become ready; inspect generic app logs, do not broaden permissions')

def main(args):
    if len(args)!=1 or args[0] not in ('status','start','stop','restart'):
        raise ValueError('Usage: ritual-service status|start|stop|restart')
    plist,domain,_=validate()
    if args[0]=='status': return status(domain)
    if args[0] in ('stop','restart'): stop(domain)
    if args[0] in ('start','restart'): start(plist,domain)
    return {'action':args[0],**status(domain)}

if __name__=='__main__':
    os.umask(0o077)
    try: print(json.dumps(main(sys.argv[1:]),indent=2))
    except (ValueError,RuntimeError,OSError) as exc:
        print(json.dumps({'ok':False,'error':str(exc)}));sys.exit(1)
