#!/usr/bin/env python3
"""Render a private, read-only SQLite snapshot. No server or network requests."""
import datetime as dt
from contextlib import closing
import fcntl
import html
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import tempfile
from ritual import BOOLS, TZ
from applicability import status_report
import dashboard_theme as theme

ROOT = Path(__file__).resolve().parent.parent

def read_records(root, with_exceptions=False):
    database = Path(root)/'data/ritual.sqlite3'
    with closing(sqlite3.connect(database.as_uri()+'?mode=ro', uri=True)) as db:
        db.row_factory = sqlite3.Row
        db.execute('BEGIN')
        rituals = [dict(r) for r in db.execute('SELECT date,checkins,magnesium,protein,stretching,journalling,plank_seconds FROM rituals ORDER BY date')]
        history = db.execute("""SELECT entity_id,action,before_json,after_json,source_text
            FROM changes WHERE entity='rituals'
            AND COALESCE(json_extract(before_json,'$.checkins'),'[]')
                != COALESCE(json_extract(after_json,'$.checkins'),'[]') ORDER BY id""")
        origins = checkin_origins(history)
        for row in rituals:
            row['checkins'] = json.loads(row['checkins'])
            row['_checkin_origins'] = origins.get(row['date'], {})
        workouts = [dict(r) for r in db.execute('SELECT id,date,type FROM workouts ORDER BY date,id')]
        exceptions = [dict(r) for r in db.execute('SELECT * FROM applicability_exceptions ORDER BY habit,start_date,id')] if with_exceptions else []
    return (rituals, workouts, exceptions) if with_exceptions else (rituals, workouts)

RECEIPT_STAMP = re.compile(r'\breceived(?:\s+at)?\s*:?\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))', re.I)

def checkin_instant(value):
    stamp = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
    if stamp.tzinfo is None:
        raise ValueError('Check-in timestamp has no timezone')
    return stamp.astimezone(dt.timezone.utc)

def checkin_origins(history):
    """Qualify only timestamps actually introduced by each audit entry.

    Sources stay private. A labelled receipt instant must match the check-in;
    later habit reports and their receipt times cannot create or relabel it.
    Historical midday checkpoints are deliberately never queried.
    """
    origins = {}
    for change in history:
        before = {checkin_instant(t) for t in json.loads(change['before_json'] or '{}').get('checkins', [])}
        after = {checkin_instant(t) for t in json.loads(change['after_json'] or '{}').get('checkins', [])}
        receipt_times = set()
        for match in RECEIPT_STAMP.finditer(change['source_text']):
            try:
                receipt_times.add(checkin_instant(match.group(1)))
            except ValueError:
                continue
        day = origins.setdefault(change['entity_id'], {})
        for stamp in before - after:
            day.pop(stamp, None)
        for stamp in after - before:
            day[stamp] = ('message_received' if stamp in receipt_times else
                          'source_recorded' if change['action'] == 'import' else 'recorded')
    return origins

def checkin_times(row):
    """Display the first recorded evening show-up; retain all stored history."""
    day = dt.date.fromisoformat(row['date'])
    origins = row.get('_checkin_origins', {})
    result = []
    for stamp in sorted({checkin_instant(t) for t in row.get('checkins', [])})[:1]:
        local = stamp.astimezone(TZ)
        offset = (local.date() - day).days
        day_label = '' if not offset else f'{offset:+d} '+('day' if abs(offset) == 1 else 'days')
        basis = origins.get(stamp, 'recorded')
        qualification = {'message_received':'Check-in message receipt time',
                         'source_recorded':'Evening check-in recorded in the imported source',
                         'recorded':'Recorded evening check-in'}[basis]
        result.append({'datetime':local.isoformat(), 'text':local.strftime('%H:%M'),
                       'day_offset':offset, 'day_label':day_label, 'basis':basis,
                       'label':local.strftime('%d %b %Y, %H:%M:%S %Z')+' · '+qualification})
    return result

def checkin_cell(row):
    times = checkin_times(row)
    if not times:
        return '<span class="none" title="No evening check-in recorded">—</span>'
    parts = []
    for item in times:
        parts.append(f'<div class="checkin-entry"><time datetime="{escape(item["datetime"])}" title="{escape(item["label"])}" aria-label="{escape(item["label"])}">{escape(item["text"])}</time></div>')
    return ''.join(parts)

def matrix(rituals, workouts):
    rows = {r['date']:{**r, 'activities':[], 'workout_count':0, 'has_ritual':True} for r in rituals}
    for workout in workouts:
        day = workout['date']
        row = rows.setdefault(day, {'date':day, **dict.fromkeys(BOOLS), 'plank_seconds':None, 'activities':[], 'workout_count':0, 'has_ritual':False})
        row['workout_count'] += 1
        if workout['type'] not in row['activities']:
            row['activities'].append(workout['type'])
    if rows:
        day=dt.date.fromisoformat(min(rows)); last=max(rows)
        while day.isoformat()<=last:
            rows.setdefault(day.isoformat(), {'date':day.isoformat(), **dict.fromkeys(BOOLS), 'plank_seconds':None, 'activities':[], 'workout_count':0, 'has_ritual':False})
            day+=dt.timedelta(days=1)
    return sorted(rows.values(), key=lambda r:r['date'], reverse=True)

def plank(value):
    return None if value is None else f'{value // 60}:{value % 60:02d}'

def escape(value):
    return html.escape(str(value), quote=True)

def mark(value):
    kind, label, glyph = ('unknown','Unreported','·') if value is None else (('done','Done','✓') if value else ('not-done','Not done','×'))
    return f'<span class="mark {kind}" role="img" aria-label="{label}" title="{label}">{glyph}</span>'

def status_mark(cell, seconds=None):
    state=cell['status']
    label={'done':'Done','not_done':'Not done','not_applicable':'Not applicable','unreported':'Open — not reported'}[state]
    basis={'missing_after_close':'No report by the next-day noon cutoff; stored value remains unknown','exception':'Outside the habit expectation','explicit_report':'Explicit report','open_day':'Open period; excluded from percentages'}.get(cell['basis'],cell['basis'])
    if state=='done' and seconds is not None:
        return f'<span class="time" title="{seconds} seconds">{plank(seconds)}</span>'
    kind,glyph={'done':('done','✓'),'not_done':('not-done','×'),'not_applicable':('na','N/A'),'unreported':('unknown','·')}[state]
    return f'<span class="mark {kind}" role="img" aria-label="{label}" title="{escape(label+": "+basis)}">{glyph}</span>'

def rate(value):
    return '—' if value['percentage'] is None else f'{value["percentage"]:.1f}%'

CSS = '''
:root{color-scheme:light;--ink:#243c36;--subtle:#64736b;--line:#dce5df;--paper:#fff;--wash:#f3f6f2;--green:#256449}
*{box-sizing:border-box}body{margin:0;background:var(--wash);color:var(--ink);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:1440px;margin:auto;padding:34px 32px 24px}.eyebrow{font-size:11px;letter-spacing:.14em;text-transform:uppercase;font-weight:650;color:var(--subtle);margin:0 0 9px}header{display:flex;align-items:flex-start;justify-content:space-between;gap:20px}h1{margin:0;font:550 32px/1.2 -apple-system,BlinkMacSystemFont,sans-serif;letter-spacing:-1px}.subhead{margin:8px 0 0;color:var(--subtle)}.snapshot{margin:0;text-align:right;font-size:12px;line-height:1.8;color:var(--subtle)}.snapshot strong{font-weight:550;color:var(--ink)}.toolbar{display:flex;justify-content:space-between;align-items:end;gap:18px;margin:28px 0 14px;flex-wrap:wrap}.filters{display:flex;gap:10px;align-items:end}label{display:block;font-size:11px;font-weight:650;letter-spacing:.04em;color:var(--subtle)}select,button{font:inherit;color:var(--ink);background:var(--paper);border:1px solid #cbd7ce;border-radius:6px;padding:8px 12px;margin-top:5px;min-height:38px}select{min-width:150px}button{cursor:pointer;background:transparent}button:hover{background:#e9efe9}button:focus-visible,select:focus-visible{outline:2px solid var(--green);outline-offset:2px}.legend{display:flex;align-items:center;gap:16px;font-size:12px;color:var(--subtle);flex-wrap:wrap}.legend span{display:inline-flex;align-items:center;gap:6px}.legend .mark{width:23px;height:23px;font-size:17px}.sheet{margin-top:28px;border:1px solid #cfdbd2;border-radius:9px;background:var(--paper);overflow:hidden;box-shadow:0 2px 4px #173c2310}.scroll{max-height:calc(100vh - 260px);min-height:280px;overflow:auto}table{border-collapse:separate;border-spacing:0;width:100%;min-width:945px;table-layout:fixed}thead th{position:sticky;top:0;z-index:3;background:#e7eee7;border-bottom:1px solid #bccdbe;height:48px;font-size:12px;font-weight:650;color:#4d6255}th,td{border-right:1px solid var(--line);text-align:center;padding:7px 14px}th:last-child,td:last-child{border-right:0}tbody td,tbody th{border-bottom:1px solid var(--line);height:48px}tbody tr:last-child td,tbody tr:last-child th{border-bottom:0}tbody tr{--row-bg:#fff;background:var(--row-bg)}tbody tr:nth-child(even){--row-bg:#fafcf9}tbody tr:first-child{--row-bg:#f0f6ec}tbody tr:hover{--row-bg:#edf4ef}th.date,td.date{position:sticky;left:0;z-index:2;background:var(--row-bg,#e7eee7);width:156px;text-align:left}thead th.date{z-index:4;background:#e7eee7}.date time{font-weight:600;font-variant-numeric:tabular-nums}.weekday{font-size:11px;color:var(--subtle);font-weight:400;margin-left:7px}.date small{display:block;font-size:10px;font-weight:400;color:var(--subtle)}.check-col{width:113px}.plank-col{width:110px}.activities{text-align:left;width:auto;min-width:210px}.activity-text{line-height:1.4;overflow-wrap:anywhere}.mark{display:inline-flex;justify-content:center;align-items:center;border-radius:5px;width:27px;height:27px;font-size:19px;font-weight:500}.done{background:#e0eee0;color:#2d6949}.not-done{background:#f9e9d8;color:#9d5e28}.unknown{color:#9aa79e;font-size:24px}.time{font:600 14px ui-monospace,SFMono-Regular,Menlo,monospace;font-variant-numeric:tabular-nums;color:#354d40}.none{color:#9aa79e}.table-foot{padding:10px 14px;display:flex;justify-content:space-between;border-top:1px solid var(--line);font-size:11px;color:var(--subtle);gap:12px}.footnote{font-size:12px;color:var(--subtle);margin:14px 0 0;max-width:950px}.empty{text-align:center;padding:28px;color:var(--subtle)}[hidden]{display:none!important}details{margin-top:16px;font-size:12px;color:var(--subtle)}summary{cursor:pointer}code{font-size:11px;overflow-wrap:anywhere}details p{max-width:1000px}noscript{display:block;padding:10px;color:#9d5e28}@media(max-width:760px){main{padding:22px 14px}header{display:block}.snapshot{text-align:left;margin-top:12px}.toolbar{margin-top:20px}.legend{gap:12px}.scroll{max-height:65vh}.filters{flex-wrap:wrap}select{min-width:125px}.table-foot{flex-wrap:wrap}}@media print{body{background:white}main{padding:0}.filters,details{display:none}.scroll{max-height:none;overflow:visible}table{min-width:0;font-size:10px}.sheet{overflow:visible}th.date,td.date,thead th{position:static}}
'''
CSS += '''.na{font-size:10px;color:#637588;background:#edf0f4}.open-badge{color:#346883!important}.period-note{padding:10px 12px;border:1px solid #d4e0dc;background:#eef4f0;border-radius:6px;margin-top:18px;font-size:12px}.completion-note{font-size:12px;color:var(--subtle);margin:10px 0}.completion-note strong{color:var(--ink)}.header-metric{display:block;font-variant-numeric:tabular-nums;font-weight:500;color:#4d6255;margin-top:2px}'''

CSS += theme.CSS
CSS += '''table{min-width:1105px}.checkin-col{width:160px}.checkin{font-variant-numeric:tabular-nums;vertical-align:middle}.checkin-entry{white-space:nowrap}.checkin-entry+.checkin-entry{margin-top:5px}.checkin-entry time{font-weight:550}.checkin-offset{margin-left:6px;color:var(--subtle);font-size:11px}.checkin-basis{display:block;color:var(--subtle);font-size:10px;font-weight:400}.checkin-zone{display:block;color:var(--subtle);font-size:10px;font-weight:400}@media print{table{min-width:0}}'''
CHECKIN_HEADER = '<th class="checkin-col" scope="col">Check-in time</th>'
# iOS 26 home-screen web apps report a 0 top inset yet blur about 40pt at the top of the page; only there, start the title bar below it.
# display-mode needs a manifest in WebKit, so the theme script also flags navigator.standalone (iOS web clips).
CSS += ''':root{--web-app-top:0px}
@media (display-mode:standalone),(display-mode:fullscreen){:root{--web-app-top:10px}}
:root[data-web-app]{--web-app-top:10px}
'''
CSS += '''
@media screen and (max-width:760px){
html,body{height:100%;overflow:hidden}
main{width:100%;max-width:none;height:100vh;height:100dvh;margin:0;padding:0;display:flex;flex-direction:column}
header{display:flex;flex:none;align-items:center;justify-content:space-between;gap:12px;padding:calc(4px + var(--web-app-top) + env(safe-area-inset-top)) calc(8px + env(safe-area-inset-right)) 4px calc(12px + env(safe-area-inset-left));background:var(--paper);border-bottom:1px solid var(--border)}
header h1{font-size:18px;font-weight:600;letter-spacing:-.3px}
.header-actions{margin:0}
header .snapshot{display:none}
.sheet{flex:1;min-height:0;margin:0;border:0;border-radius:0;box-shadow:none}
.scroll{width:100%;height:100%;max-height:none;min-height:0;overflow:auto;overscroll-behavior:contain;padding-bottom:env(safe-area-inset-bottom)}
table{min-width:680px;font-size:12px}
th,td{padding:4px 6px}
thead th{height:42px;font-size:10px}
tbody td,tbody th{height:34px}
th.date,td.date{width:108px;padding-left:8px;line-height:1.3}
.date small{font-size:9px;line-height:1.2}
.checkin-col{width:80px}
.check-col{width:74px}
.plank-col{width:62px}
.activities{min-width:120px}
.mark{width:22px;height:22px;font-size:16px}
.na{font-size:9px}
.time{font-size:12px}
.header-metric{margin-top:1px}
.theme-toggle{width:44px;height:44px;min-width:44px;min-height:44px;margin:0;padding:0;border:1px solid var(--border);border-radius:50%;font-size:0;background:var(--paper)}
.theme-toggle::before{content:'◐';font-size:21px;line-height:1}
:root[data-theme="light"] .theme-toggle::before{content:'☀'}
:root[data-theme="dark"] .theme-toggle::before{content:'☾'}
}
'''

def render(rows, generated_at, root, report=None):
    if report is None: report=status_report(rows,[],[],generated_at)
    derived={r['date']:r for r in report['records']}
    stamp = generated_at.astimezone(TZ).strftime('%d %b %Y · %H:%M:%S %Z')
    body = []
    workout_days = closed_days = 0
    for row in rows:
        state=derived[row['date']]
        date = dt.date.fromisoformat(row['date'])
        display_date = f'{date.strftime("%a · %b")} {date.day}'
        full_date = f'{date.strftime("%A")}, {date.day} {date.strftime("%B %Y")}'
        date_cell = f'<time datetime="{row["date"]}" title="{escape(full_date)}" aria-label="{escape(full_date)}">{display_date}</time>'
        if state['period']!='closed': date_cell += f'<small class="open-badge">{state["period"].capitalize()} · not counted</small>'
        elif not row['has_ritual']: date_cell += '<small>'+('Activities only' if row['workout_count'] else 'No report')+'</small>'
        cells = [f'<th scope="row" class="date">{date_cell}</th>']
        cells.append(f'<td class="checkin">{checkin_cell(row)}</td>')
        for field in ('magnesium','protein','stretching'):
            cell=state['habits'][field]
            cells.append(f'<td data-field="{field}" data-status="{cell["status"]}">{status_mark(cell)}</td>')
        plank_cell=state['habits']['planks']
        cells.append(f'<td data-field="plank_seconds" data-status="{plank_cell["status"]}">{status_mark(plank_cell,row["plank_seconds"])}</td>')
        cell=state['habits']['journalling']
        cells.append(f'<td data-field="journalling" data-status="{cell["status"]}">{status_mark(cell)}</td>')
        categories = escape(', '.join(row['activities'])) if row['activities'] else '<span class="none" title="No activities recorded">—</span>'
        cells.append(f'<td class="activities"><span class="activity-text" title="{row["workout_count"]} recorded workouts">{categories}</span></td>')
        closed = state['period']=='closed'
        workout_days += int(closed and row['workout_count']>0)
        closed_days += int(closed)
        body.append(f'<tr data-date="{row["date"]}" data-period="{state["period"]}">'+''.join(cells)+'</tr>')
    csp = "default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-"+theme.HASH+"'; base-uri 'none'; form-action 'none'"
    habit_headers=''.join(f'<th class="{"plank-col" if h=="planks" else "check-col"}" scope="col">{label} <span class="header-metric">(<span data-rate-habit="{h}" title="{report["by_habit"][h]["done"]} of {report["by_habit"][h]["applicable"]} applicable closed days">{rate(report["by_habit"][h])}</span>)</span></th>' for h,label in (('magnesium','Magnesium'),('protein','Protein'),('stretching','Stretches'),('planks','Plank'),('journalling','Journalling')))
    workout_rate = rate({'percentage':100*workout_days/closed_days if closed_days else None})
    workout_header = f'<th class="activities" scope="col">Workout <span class="header-metric">(<span data-rate-habit="workout" title="{workout_days} of {closed_days} closed days with a recorded workout">{workout_rate}</span>)</span></th>'
    return f'''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta http-equiv="Content-Security-Policy" content="{escape(csp)}"><title>Daily rituals</title><script>{theme.SCRIPT}</script><style>{CSS}</style></head><body><main>
<header><h1>Daily rituals</h1><div class="header-actions"><p class="snapshot">Updated {escape(stamp)}</p>{theme.BUTTON}</div></header>
<div class="sheet"><div class="scroll"><table aria-label="Daily ritual and workout matrix"><thead><tr><th class="date" scope="col">Date <span class="header-metric">(<span id="visible-count" aria-live="polite">{len(rows)} {'day' if len(rows)==1 else 'days'}</span>)</span></th>{CHECKIN_HEADER}{habit_headers}{workout_header}</tr></thead><tbody>{''.join(body)}</tbody></table><p class="empty"{' hidden' if rows else ''}>No dates recorded yet.</p></div></div>
</main></body></html>'''

def generate(root=ROOT):
    root = Path(root).resolve()
    folder = root/'data/views'
    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    lock_fd = os.open(folder/'.dashboard.lock', os.O_CREAT|os.O_WRONLY, 0o600)
    with os.fdopen(lock_fd, 'w') as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        rituals, workouts, exceptions = read_records(root,True)
        rows = matrix(rituals, workouts)
        stamp = dt.datetime.now(dt.timezone.utc)
        report = status_report(rituals,workouts,exceptions,stamp)
        content = render(rows, stamp, root,report)
        target = folder/'ritual-dashboard.html'
        fd, temp = tempfile.mkstemp(prefix='.dashboard-', dir=folder)
        try:
            with os.fdopen(fd,'w') as stream:
                stream.write(content); stream.flush(); os.fsync(stream.fileno())
            os.replace(temp, target)
            directory = os.open(folder, os.O_RDONLY)
            try: os.fsync(directory)
            finally: os.close(directory)
        finally:
            if os.path.exists(temp): os.unlink(temp)
    return {'updated':True, 'path':str(target), 'generated_at':stamp.isoformat(), 'days':len(rows), 'workouts':len(workouts)}

if __name__ == '__main__':
    os.umask(0o077)
    if len(sys.argv) != 1: raise SystemExit('Usage: ritual-dashboard')
    try: print(json.dumps(generate(),ensure_ascii=False))
    except (OSError, sqlite3.Error, ValueError) as exc:
        print(json.dumps({'updated':False,'error':str(exc)})); sys.exit(1)
