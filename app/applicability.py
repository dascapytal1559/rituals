"""Applicability and completion views; never overwrite raw observations."""
import datetime as dt
from pathlib import Path
from zoneinfo import ZoneInfo

TZ_PATH = Path(__file__).with_name('Melbourne.tzif')
TZ = ZoneInfo.from_file(TZ_PATH.open('rb'), key='Australia/Melbourne') if TZ_PATH.exists() else ZoneInfo('Australia/Melbourne')

HABITS = {'magnesium','protein','stretching','journalling','planks'}
TABLE_SQL = '''CREATE TABLE applicability_exceptions(
 id TEXT PRIMARY KEY,
 habit TEXT NOT NULL CHECK(habit IN ('magnesium','protein','stretching','journalling','planks')),
 start_date TEXT,
 end_date TEXT NOT NULL,
 reason TEXT NOT NULL,
 CHECK(start_date IS NULL OR start_date <= end_date)
);'''

class ApplicabilityConflict(ValueError): pass

def validate_exception(row, existing):
    if set(row) != {'id','habit','start_date','end_date','reason'}:
        raise ValueError('Exactly id, habit, start_date, end_date and reason are required')
    if not row['id'] or not row['reason'].strip() or row['habit'] not in HABITS:
        raise ValueError('Valid ID, habit and reason are required')
    for field in ('start_date','end_date'):
        value = row[field]
        if value is None and field=='start_date': continue
        if not isinstance(value,str) or dt.date.fromisoformat(value).isoformat()!=value:
            raise ValueError('Use ISO calendar dates')
    start = row['start_date'] or '0001-01-01'
    if start > row['end_date']: raise ValueError('Exception dates are reversed')
    for old in existing:
        if old['id']==row['id']:
            if old==row: return 'replayed'
            raise ValueError('Exception ID already has different content')
        if old['habit']==row['habit'] and start<=old['end_date'] and (old['start_date'] or '0001-01-01')<=row['end_date']:
            raise ValueError('Overlapping exceptions for the same habit')
    return 'new'

def applies(exception, habit, day):
    return exception['habit']==habit and (exception['start_date'] is None or exception['start_date']<=day) and day<=exception['end_date']

def derive(habit, day, raw, exceptions, closed_through, source_done=False):
    """Closure is explicit input until the reporting cutoff is agreed.

    source_done can preserve a verified legacy completion without duration;
    callers must supply its evidence rather than treating missing seconds as no.
    """
    if habit not in HABITS: raise ValueError('Unknown habit')
    done = source_done or (raw is not None and (raw>0 if habit=='planks' else bool(raw)))
    match = next((x for x in exceptions if applies(x,habit,day)),None)
    if match and done:
        raise ApplicabilityConflict(f'{day} {habit}: positive report conflicts with exception {match["id"]}')
    closed = closed_through is not None and day<=closed_through
    if match: status, basis = 'not_applicable','exception'
    elif done: status, basis = 'done','source_report' if source_done else 'explicit_report'
    elif raw is not None: status, basis = 'not_done','explicit_report'
    elif closed: status, basis = 'not_done','missing_after_close'
    else: status, basis = 'unreported','open_day'
    return {'status':status,'basis':basis,'raw':raw,'applicable':match is None,
            'included_in_completion':closed and match is None,
            'exception_id':match['id'] if match else None}

def completion(cells):
    eligible = [cell for cell in cells if cell['included_in_completion']]
    done = sum(cell['status']=='done' for cell in eligible)
    return {'done':done,'applicable':len(eligible),'percentage':100*done/len(eligible) if eligible else None}

def as_instant(value=None):
    if value is None: value = dt.datetime.now(dt.timezone.utc)
    if isinstance(value,str): value = dt.datetime.fromisoformat(value.replace('Z','+00:00'))
    if not isinstance(value,dt.datetime) or value.tzinfo is None:
        raise ValueError('as_of must be an instant with an offset')
    return value.astimezone(dt.timezone.utc)

def closes_at(day):
    return dt.datetime.combine(dt.date.fromisoformat(day)+dt.timedelta(days=1),dt.time(12),TZ)

def period(value=None):
    stamp = as_instant(value)
    local = stamp.astimezone(TZ)
    active = local.date()-dt.timedelta(days=int(local.hour<12))
    return {'as_of':stamp.isoformat(),'timezone':'Australia/Melbourne','cutoff':'12:00 next day',
            'active_date':active.isoformat(),'closed_through':(active-dt.timedelta(days=1)).isoformat(),
            'active_closes_at':closes_at(active.isoformat()).isoformat()}

def status_report(rituals, workouts, exceptions, as_of=None, start=None, end=None):
    context = period(as_of)
    raw = {r['date']:r for r in rituals}
    activity_dates = {w['date'] for w in workouts}
    known = sorted(set(raw)|activity_dates)
    def row(day):
        original = raw.get(day,{})
        cells = {habit:derive(habit,day,original.get('plank_seconds' if habit=='planks' else habit),exceptions,context['closed_through']) for habit in sorted(HABITS)}
        return {'date':day,'has_ritual':day in raw,'has_activity':day in activity_dates,
                'period':'closed' if day<=context['closed_through'] else ('open' if day==context['active_date'] else 'upcoming'),
                'closes_at':closes_at(day).isoformat(),'habits':cells}
    records=[]
    if known:
        first=max(known[0],start or known[0]); last=min(known[-1],end or known[-1])
        day=dt.date.fromisoformat(first)
        while day.isoformat()<=last:
            records.append(row(day.isoformat())); day+=dt.timedelta(days=1)
    return {**context,'coverage':{'from':known[0],'to':known[-1]} if known else None,
            'records':records,'count':len(records),'active_period':row(context['active_date']),
            'completion':completion([cell for r in records for cell in r['habits'].values()]),
            'by_habit':{h:completion([r['habits'][h] for r in records]) for h in sorted(HABITS)}}
