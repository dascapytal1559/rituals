"""Cooperative edit ownership. Does not lock ordinary ritual writes."""
import datetime as dt
import json
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent.parent

def act(args, root=ROOT):
    claim = Path(root)/'.agent-work'
    if args == ['status']:
        if not claim.exists(): return {'claimed':False}
        try: owner=json.loads((claim/'owner.json').read_text())
        except (OSError,ValueError): return {'claimed':True,'requires_review':True}
        return {'claimed':True,**owner}
    if len(args)==3 and args[0]=='claim':
        owner,scope=args[1:]
        if not owner.strip() or not scope.strip() or len(owner)>180 or len(scope)>500:
            raise ValueError('Nonempty owner/scope within 180/500 characters required')
        # Atomic directory creation selects one cooperating editor.
        try: claim.mkdir(mode=0o700)
        except FileExistsError: raise ValueError('Edit work already claimed; inspect status and coordinate')
        payload={'owner':owner,'scope':scope,'started_at':dt.datetime.now(dt.timezone.utc).isoformat()}
        try:
            with (claim/'owner.json').open('x') as stream:
                json.dump(payload,stream,indent=2);stream.write('\n');stream.flush();os.fsync(stream.fileno())
            os.chmod(claim/'owner.json',0o600)
        except Exception:
            # Do not remove ownership after an ambiguous partial failure.
            raise
        return {'claimed':True,**payload}
    if len(args)==2 and args[0]=='release':
        payload=json.loads((claim/'owner.json').read_text())
        if payload.get('owner')!=args[1]: raise ValueError('Only the recorded owner can release; coordinate stale claims')
        if set(p.name for p in claim.iterdir())!={'owner.json'}: raise ValueError('Unexpected claim files; review before release')
        (claim/'owner.json').unlink();claim.rmdir()
        return {'claimed':False,'released':args[1]}
    raise ValueError('Usage: ritual-agent status | claim OWNER SCOPE | release OWNER')

if __name__=='__main__':
    os.umask(0o077)
    try: print(json.dumps(act(sys.argv[1:]),indent=2))
    except (ValueError,OSError) as exc:
        print(json.dumps({'ok':False,'error':str(exc)}));sys.exit(1)
