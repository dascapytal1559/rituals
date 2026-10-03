"""Dashboard-only API projection and frontend; source records are never exposed."""
import base64
import datetime as dt
import hashlib
import json
import dashboard
import dashboard_theme as theme
from applicability import status_report

HABITS=(('magnesium','Magnesium'),('protein','Protein'),('stretching','Stretches'),('planks','Plank'),('journalling','Journalling'))


def cell_view(cell,seconds=None):
    state=cell['status']
    labels={'done':'Done','not_done':'Not done','not_applicable':'Not applicable','unreported':'Open — not reported'}
    text={'done':'✓','not_done':'×','not_applicable':'N/A','unreported':'·'}[state]
    numeric=state=='done' and seconds is not None
    if numeric:text=dashboard.plank(seconds)
    return {'status':state,'text':text,'label':f'{seconds} seconds' if numeric else labels[state],'numeric':numeric}


def dashboard_data(root,as_of=None):
    rituals,workouts,exceptions=dashboard.read_records(root,True)
    stamp=as_of or dt.datetime.now(dt.timezone.utc)
    report=status_report(rituals,workouts,exceptions,stamp)
    derived={r['date']:r for r in report['records']}
    rows=[];workout_days=closed_days=0
    for row in dashboard.matrix(rituals,workouts):
        day=dt.date.fromisoformat(row['date']);state=derived[row['date']]
        closed=state['period']=='closed';closed_days+=int(closed)
        workout_days+=int(closed and row['workout_count']>0)
        annotation=(state['period'].capitalize()+' · not counted') if not closed else ('' if row['has_ritual'] else ('Activities only' if row['workout_count'] else 'No report'))
        rows.append({'date':row['date'],'display_date':f'{day.strftime("%a · %b")} {day.day}',
          'full_date':f'{day.strftime("%A")}, {day.day} {day.strftime("%B %Y")}',
          'period':state['period'],'annotation':annotation,
          'checkin_times':dashboard.checkin_times(row),
          'cells':{h:cell_view(state['habits'][h],row['plank_seconds'] if h=='planks' else None) for h,label in HABITS},
          'workouts':{'types':row['activities'],'count':row['workout_count']}})
    rates={h:{'done':report['by_habit'][h]['done'],'denominator':report['by_habit'][h]['applicable'],'percentage':report['by_habit'][h]['percentage']} for h,label in HABITS}
    rates['workout']={'done':workout_days,'denominator':closed_days,'percentage':100*workout_days/closed_days if closed_days else None}
    return {'generated_at':stamp.isoformat(),'updated_display':stamp.astimezone(dashboard.TZ).strftime('%d %b %Y · %H:%M:%S %Z'),
      'timezone':'Australia/Melbourne','count':len(rows),'rates':rates,'rows':rows}


SCRIPT='''const habits = ['magnesium','protein','stretching','planks','journalling'];
const body = document.querySelector('tbody');
const message = document.querySelector('#message');
let loading = false;
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function render(data) {
  const fragment = document.createDocumentFragment();
  for (const row of data.rows) {
    const tr = element('tr');
    const date = element('th', undefined, 'date'); date.scope = 'row';
    const time = element('time', row.display_date); time.dateTime = row.date;
    time.title = row.full_date; time.setAttribute('aria-label', row.full_date); date.append(time);
    if (row.annotation) date.append(element('small', row.annotation, row.period === 'closed' ? '' : 'open-badge'));
    tr.append(date);
    const checkin = element('td', undefined, 'checkin');
    const times = row.checkin_times || [];
    if (!times.length) {
      const empty = element('span', '—', 'none');
      empty.title = 'No evening check-in recorded'; checkin.append(empty);
    }
    for (const item of times) {
      const entry = element('div', undefined, 'checkin-entry');
      const time = element('time', item.text); time.dateTime = item.datetime;
      time.title = item.label; time.setAttribute('aria-label', item.label); entry.append(time);
      checkin.append(entry);
    }
    tr.append(checkin);
    for (const habit of habits) {
      const cell = row.cells[habit];
      const td = element('td');
      const classes = {done:'done',not_done:'not-done',not_applicable:'na',unreported:'unknown'};
      const mark = element('span', cell.text, cell.numeric ? 'time' : 'mark '+classes[cell.status]);
      mark.title = cell.label; mark.setAttribute('aria-label', cell.label);
      if (!cell.numeric) mark.setAttribute('role','img');
      td.append(mark);tr.append(td);
    }
    const workouts = element('td', undefined, 'activities');
    const types = element('span', row.workouts.types.length ? row.workouts.types.join(', ') : '—', row.workouts.types.length ? 'activity-text' : 'none');
    types.title = row.workouts.count+' recorded workouts';workouts.append(types);tr.append(workouts);
    fragment.append(tr);
  }
  body.replaceChildren(fragment);
  document.querySelector('#day-count').textContent = data.count+' '+(data.count === 1 ? 'day' : 'days');
  for (const node of document.querySelectorAll('[data-rate]')) {
    const metric = data.rates[node.dataset.rate];
    node.textContent = metric.percentage === null ? '—' : metric.percentage.toFixed(1)+'%';
    node.title = metric.done+' of '+metric.denominator+(node.dataset.rate === 'workout' ? ' closed days with a recorded workout' : ' applicable closed days');
  }
  document.querySelector('#updated').textContent = 'Updated '+data.updated_display;
  message.textContent = data.count ? '' : 'No dates recorded yet.';message.hidden = data.count !== 0;
}
async function refresh() {
  if (loading) return;
  loading = true;
  try {
    const response = await fetch('/api/dashboard', {cache:'no-store',credentials:'same-origin'});
    if (!response.ok) throw new Error('Unavailable');
    render(await response.json());
  } catch (_) {
    message.textContent = 'Dashboard unavailable. Last loaded values may be out of date. Refresh to retry.';
    message.hidden = false;
  } finally { loading = false; }
}
refresh();
setInterval(() => { if (!document.hidden) refresh(); }, 60000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });'''
SCRIPT_HASH=base64.b64encode(hashlib.sha256(SCRIPT.encode()).digest()).decode()
CSP="default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-"+SCRIPT_HASH+"' 'sha256-"+theme.HASH+"'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"


def frontend():
    headers=''.join(f'<th class="{"plank-col" if h=="planks" else "check-col"}" scope="col">{label}<span class="header-metric">(<span data-rate="{h}">—</span>)</span></th>' for h,label in HABITS)
    return f'''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta http-equiv="Content-Security-Policy" content="{dashboard.escape(CSP)}"><title>Daily rituals</title><script>{theme.SCRIPT}</script><style>{dashboard.CSS}</style></head><body><main>
<header><h1>Daily rituals</h1><div class="header-actions"><p class="snapshot" id="updated">Updated —</p>{theme.BUTTON}</div></header>
<div class="sheet"><div class="scroll"><table aria-label="Daily ritual and workout matrix"><thead><tr><th class="date" scope="col">Date<span class="header-metric">(<span id="day-count">—</span>)</span></th>{dashboard.CHECKIN_HEADER}{headers}<th class="activities" scope="col">Workout<span class="header-metric">(<span data-rate="workout">—</span>)</span></th></tr></thead><tbody></tbody></table><p class="empty" id="message" role="status">Loading dashboard…</p></div></div>
</main><script>{SCRIPT}</script></body></html>'''.encode('utf-8')


def json_response(root):
    return json.dumps(dashboard_data(root),ensure_ascii=False,allow_nan=False).encode('utf-8')
