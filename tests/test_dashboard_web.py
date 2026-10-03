import datetime as dt
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import dashboard
import dashboard_web

class DashboardWebTests(unittest.TestCase):
 def fixture(self):
  rituals=[{'date':'2026-10-03',**dict.fromkeys(dashboard.BOOLS),'plank_seconds':None},
           {'date':'2026-10-04','magnesium':1,'protein':0,'stretching':1,'journalling':None,'plank_seconds':60}]
  workouts=[{'id':'a','date':'2026-10-03','type':'run'}, {'id':'b','date':'2026-10-03','type':'gym pull'}]
  return rituals,workouts,[]
 def test_only_dashboard_projection_is_returned(self):
  with patch('dashboard.read_records',return_value=self.fixture()):
   result=dashboard_web.dashboard_data(Path('/unused'),dt.datetime.fromisoformat('2026-10-05T12:00:00+11:00'))
  self.assertEqual(set(result),{'generated_at','updated_display','timezone','count','rates','rows'})
  self.assertEqual(set(result['rows'][0]),{'date','display_date','full_date','period','annotation','cells','workouts','checkin_times'})
  forbidden={'notes','checkins','source_text','sources','source_documents','raw','revision','request_id','details','exception_id'}
  def check(value):
   if isinstance(value,dict):
    self.assertFalse(set(value)&forbidden)
    for item in value.values():check(item)
   elif isinstance(value,list):
    for item in value:check(item)
  check(result)
  self.assertEqual(result['rates']['workout'],{'done':1,'denominator':2,'percentage':50.0})
  self.assertEqual(result['rows'][1]['workouts']['count'],2)
 def test_noon_and_dst_are_computed_on_each_request(self):
  with patch('dashboard.read_records',return_value=self.fixture()) as read:
   before=dashboard_web.dashboard_data(Path('/unused'),dt.datetime.fromisoformat('2026-10-04T11:59:59+11:00'))
   after=dashboard_web.dashboard_data(Path('/unused'),dt.datetime.fromisoformat('2026-10-04T12:00:00+11:00'))
  self.assertEqual(read.call_count,2)
  self.assertEqual(before['rows'][1]['period'],'open')
  self.assertEqual(before['rows'][1]['cells']['magnesium']['status'],'unreported')
  self.assertIsNone(before['rates']['workout']['percentage'])
  self.assertEqual(after['rows'][1]['period'],'closed')
  self.assertEqual(after['rows'][1]['cells']['magnesium']['status'],'not_done')
  self.assertEqual(after['rates']['workout']['percentage'],100.0)
 def test_exceptions_and_open_days_stay_out_of_denominator(self):
  rituals,workouts,exceptions=self.fixture()
  exceptions=[{'id':'example','habit':'magnesium','start_date':'2026-10-03','end_date':'2026-10-03','reason':'Test'}]
  with patch('dashboard.read_records',return_value=(rituals,workouts,exceptions)):
   data=dashboard_web.dashboard_data(Path('/unused'),dt.datetime.fromisoformat('2026-10-04T12:00:00+11:00'))
  self.assertEqual(data['rows'][1]['cells']['magnesium']['status'],'not_applicable')
  self.assertIsNone(data['rates']['magnesium']['percentage'])
 def test_frontend_has_no_record_data_or_unsafe_html_sink(self):
  page=dashboard_web.frontend().decode()
  self.assertIn("fetch('/api/dashboard'",page)
  self.assertIn("connect-src &#x27;self&#x27;",page)
  self.assertIn(dashboard_web.SCRIPT_HASH,page)
  self.assertNotIn('innerHTML',dashboard_web.SCRIPT)
  self.assertNotIn('<select',page)
  self.assertIn('<h1>Daily rituals</h1>',page)
  self.assertIn('Date<span',page)
  self.assertNotIn('2026-',page)

if __name__=='__main__':unittest.main()
