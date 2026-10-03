import sqlite3
import unittest
from applicability import ApplicabilityConflict, TABLE_SQL, completion, derive, validate_exception

TRAVEL={'id':'example-travel','habit':'protein','start_date':'2026-09-17','end_date':'2026-09-24','reason':'Travel'}
PLANK={'id':'example-prestart','habit':'planks','start_date':None,'end_date':'2026-09-16','reason':'Not started'}

class ApplicabilityTests(unittest.TestCase):
    def test_inclusive_travel_boundaries(self):
        self.assertEqual([derive('protein',d,None,[TRAVEL],'2026-09-30')['status'] for d in ('2026-09-16','2026-09-17','2026-09-24','2026-09-25')],['not_done','not_applicable','not_applicable','not_done'])
    def test_prestart_null_bound_and_first_day(self):
        self.assertEqual(derive('planks','2026-08-23',None,[PLANK],'2026-10-01')['status'],'not_applicable')
        self.assertEqual(derive('planks','2026-09-17',67,[PLANK],'2026-10-01')['status'],'done')
    def test_positive_unknown_duration_source_conflict_stops(self):
        for day in ('2026-09-15','2026-09-16'):
            with self.assertRaises(ApplicabilityConflict): derive('planks',day,None,[PLANK],'2026-10-01',source_done=True)
    def test_explicit_positive_exception_conflict_stops(self):
        with self.assertRaises(ApplicabilityConflict): derive('protein','2026-09-17',True,[TRAVEL],'2026-10-01')
    def test_missing_closed_is_derived_without_mutating_raw(self):
        cell=derive('protein','2026-09-16',None,[],'2026-09-30')
        self.assertIsNone(cell['raw']); self.assertEqual(cell['basis'],'missing_after_close')
    def test_open_day_and_future_are_not_counted_as_failures(self):
        cells=[derive('protein',d,None,[],'2026-09-30') for d in ('2026-10-01','2026-10-02')]
        self.assertTrue(all(x['status']=='unreported' for x in cells))
        self.assertEqual(completion(cells),{'done':0,'applicable':0,'percentage':None})
    def test_late_report_recomputes_status(self):
        before=derive('journalling','2026-09-17',None,[],'2026-10-01')
        after=derive('journalling','2026-09-17',True,[],'2026-10-01')
        self.assertEqual([before['status'],after['status']],['not_done','done'])
    def test_na_excluded_from_both_numerator_and_denominator(self):
        cells=[derive('protein','2026-09-17',None,[TRAVEL],'2026-09-30'),derive('protein','2026-09-25',False,[TRAVEL],'2026-09-30'),derive('protein','2026-09-26',True,[TRAVEL],'2026-09-30')]
        self.assertEqual(completion(cells),{'done':1,'applicable':2,'percentage':50})
    def test_no_applicable_days_returns_no_percentage(self):
        self.assertIsNone(completion([derive('protein','2026-09-17',None,[TRAVEL],'2026-09-30')])['percentage'])
    def test_duplicate_id_and_overlap_guards(self):
        self.assertEqual(validate_exception(TRAVEL,[TRAVEL]),'replayed')
        with self.assertRaises(ValueError): validate_exception({**TRAVEL,'reason':'Different'},[TRAVEL])
        with self.assertRaises(ValueError): validate_exception({**TRAVEL,'id':'second','start_date':'2026-09-24'},[TRAVEL])
        self.assertEqual(validate_exception({**TRAVEL,'id':'later','start_date':'2026-09-25','end_date':'2026-09-26'},[TRAVEL]),'new')
        self.assertEqual(validate_exception({**TRAVEL,'id':'magnesium','habit':'magnesium'},[TRAVEL]),'new')
    def test_minimal_table_in_isolated_memory(self):
        with sqlite3.connect(':memory:') as db:
            db.execute(TABLE_SQL)
            self.assertEqual([r[1] for r in db.execute('PRAGMA table_info(applicability_exceptions)')],['id','habit','start_date','end_date','reason'])

if __name__=='__main__': unittest.main()
