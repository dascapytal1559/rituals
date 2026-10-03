#!/usr/bin/env python3
"""Local-only ritual entrypoint and durable replay queue. No network access."""
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
from ritual import Store, pack

ROOT = Path(__file__).resolve().parent.parent
WRITES = {'ritual_put', 'workout_add', 'reminder_add', 'correct', 'reminder_mark', 'exception_add'}

class StorageUnavailable(RuntimeError): pass

def call(request, root=ROOT):
    root = Path(root)
    if not (root/'data'/'ritual.sqlite3').is_file():
        raise StorageUnavailable('Authoritative Mac database is unavailable; no empty replacement was created')
    store = None
    try:
        store = Store(root/'data')
        result = store.request(request)
    except sqlite3.OperationalError as exc:
        if any(x in str(exc).lower() for x in ('locked', 'unable to open', 'disk i/o', 'readonly', 'full')):
            raise StorageUnavailable(str(exc)) from exc
        raise
    finally:
        if store: store.close()
    if request.get('op') in WRITES | {'import', 'restore', 'ritual_status', 'reminders'}:
        # The record is already committed. A view failure must never turn a
        # successful save into an apparent failure or trigger an offline retry.
        try:
            from dashboard import generate
            result = {**result, 'dashboard': generate(root)}
        except Exception as exc:
            result = {**result, 'dashboard': {'updated': False, 'error': str(exc), 'record_saved': request.get('op') in WRITES | {'import','restore'}}}
    return result

def init(root=ROOT):
    """Create a new empty store, explicitly and once; an existing database is never touched."""
    database = Path(root)/'data'/'ritual.sqlite3'
    if database.exists() or database.is_symlink():
        raise ValueError('A database already exists; --init only creates a new empty store')
    Store(database.parent).close()
    return call({'op': 'status'}, root)

def atomic_json(path, value, no_replace=False):
    path = Path(path)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.pending-', dir=path.parent)
    temporary = Path(temporary)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write('\n'); stream.flush(); os.fsync(stream.fileno())
        if no_replace: os.link(temporary, path)
        else: os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try: os.fsync(directory)
        finally: os.close(directory)
    finally:
        if temporary.exists(): temporary.unlink()

def enqueue(request, root=ROOT):
    if not isinstance(request, dict) or request.get('op') not in WRITES:
        raise ValueError('Only a prepared write can be queued; offline reads must remain unavailable')
    rid = request.get('request_id')
    if not isinstance(rid, str) or not rid or len(rid) > 180:
        raise ValueError('A stable request_id up to 180 characters is required')
    if not isinstance(request.get('source_text'), str) or not request['source_text'].strip():
        raise ValueError('Original source words, receipt time and interpretation are required in source_text')
    path = Path(root)/'queue'/'pending'/(hashlib.sha256(rid.encode()).hexdigest()+'.json')
    payload = {'request': request, 'queued_at': dt.datetime.now(dt.timezone.utc).isoformat()}
    try: atomic_json(path, payload, no_replace=True)
    except FileExistsError:
        if pack(json.loads(path.read_text())['request']) != pack(request):
            raise ValueError('Queued request_id already has different content')
    return {'status': 'queued_on_mac', 'database_confirmed': False, 'request_id': rid, 'pending_file': str(path)}

def submit(request, root=ROOT, queue_on_failure=False):
    try: return call(request, root)
    except StorageUnavailable:
        if not queue_on_failure: raise
        return enqueue(request, root)

def replay(root=ROOT):
    root = Path(root)
    q = root/'queue'; q.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (q/'.replay.lock').open('a') as lock:
        try: fcntl.flock(lock.fileno(), fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError: return {'status': 'replay_already_running', 'synced': []}
        entries = [(p, json.loads(p.read_text())) for p in (q/'pending').glob('*.json')]
        entries.sort(key=lambda pair: (pair[1]['queued_at'], pair[0].name))
        results = []
        for path, payload in entries:
            req = payload['request']
            try: result = call(req, root)
            except (ValueError, StorageUnavailable, sqlite3.Error) as exc:
                return {'status': 'blocked', 'synced': results, 'remaining': len(list((q/'pending').glob('*.json'))), 'blocked_request_id': req['request_id'], 'error': str(exc), 'requires_review': not isinstance(exc, StorageUnavailable)}
            stamp = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%S%f')
            sent = q/'sent'; sent.mkdir(mode=0o700, exist_ok=True)
            atomic_json(sent/(path.stem+'-'+stamp+'-receipt.json'), {'request_id': req['request_id'], 'applied_at': stamp, 'result': result})
            path.rename(sent/(path.stem+'-'+stamp+'-request.json'))
            results.append({'request_id': req['request_id'], 'replayed': result.get('replayed', False), 'revision': result.get('revision')})
        return {'status': 'complete', 'synced': results, 'remaining': 0}

def main():
    os.umask(0o077)
    args = sys.argv[1:]
    if args == ['--init']: result = init()
    elif args == ['--replay']: result = replay()
    elif args == ['--queue-status']:
        entries = [json.loads(p.read_text()) for p in (ROOT/'queue'/'pending').glob('*.json')]
        result = {'pending_count': len(entries), 'request_ids': [x['request']['request_id'] for x in entries]}
    else:
        if args not in ([], ['--enqueue'], ['--queue-on-failure']): raise ValueError('Usage: ritualctl [--init | --enqueue | --replay | --queue-status | --queue-on-failure]')
        raw = sys.stdin.buffer.read(2_000_001)
        if len(raw)>2_000_000: raise ValueError('Request exceeds 2MB')
        req = json.loads(raw)
        result = enqueue(req) if args == ['--enqueue'] else submit(req, queue_on_failure=bool(args))
    print(json.dumps(result, ensure_ascii=False, indent=2))

if __name__ == '__main__':
    try: main()
    except (ValueError, RuntimeError, sqlite3.Error, OSError) as exc:
        print(json.dumps({'ok': False, 'error': str(exc), 'kind': 'storage_unavailable' if isinstance(exc, StorageUnavailable) else 'requires_review'}))
        sys.exit(1)
