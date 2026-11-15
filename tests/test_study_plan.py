import calendar
from copy import deepcopy
from datetime import date
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

from api import server
from api.study_plan import assess, build_plan, load_calendar


def config(**changes):
    return dict({'bbox': [68, 53, 71, 55], 'preset': 'custom', 'start': '2020-01-01', 'end': '2025-12-31',
                 'baseline_start': 2020, 'baseline_end': 2023, 'grid_km': 10, 'quality': 'sp', 'daynight': 'all'}, **changes)


def metadata(platforms=('Aqua', 'NOAA-20'), years=range(2020, 2026)):
    rows = []
    for year in years:
        for month in range(1, 13):
            for platform in platforms:
                rows.append(dict(month=f'{year}-{month:02}', platform=platform, points=0,
                                 eligible_days=calendar.monthrange(year, month)[1], nrt_points=0,
                                 preliminary=False, partial=False))
    return dict(revision='calendar-fixture', snapshot_at='2026-01-02T00:00:00Z', monthly=rows)


def result():
    def row(month, **changes):
        return dict(dict(month=month, platform='NOAA-20', cells=20, points=30, eligible_days=30, calendar_days=30,
                         comparison_status='ok', baseline_year_ids=[2020, 2021, 2022, 2023], baseline=20,
                         nrt_points=0, preliminary_days=0, calibration_eligible=True, model_valid=True,
                         baseline_calibration_eligible=True, baseline_equivalent=10, anomaly_pct=0), **changes)
    return dict(config=config(), analysis_version=server.ANALYSIS_VERSION, extract_id='e' * 32,
                snapshot_at='stored-snapshot', monthly=[row('2024-04'), row('2025-04')],
                models={'NOAA-20': dict(accepted=True, coefficient=.5, fit_months=48, test_months=24,
                                       checks={'fit_months': True, 'test_months': True, 'improves_uncorrected': True})},
                provenance={'sources': [{'sha256': 'stored-source-hash'}]})


class StudyPlanTests(unittest.TestCase):
    def test_real_calendar_distinguishes_absence_short_history_and_sp_nrt(self):
        snapshot = json.loads((server.ROOT / 'web/data/world-calendar.json').read_bytes())
        early = build_plan(config(start='2000-11-01', end='2001-12-31', baseline_start=2000, baseline_end=2001),
                           'anomaly', 'Aqua', snapshot, 'seed-world-calendar')
        self.assertEqual(early['options'][0]['status'], 'unavailable')
        self.assertEqual(early['requested_config']['end'], '2001-12-31')
        self.assertEqual(early['options'][-1]['id'], 'current-request')
        newest = build_plan(config(), 'anomaly', 'NOAA-21', snapshot, 'seed-world-calendar')
        self.assertEqual(newest['options'][0]['status'], 'unavailable')
        coverage = next(p for p in newest['availability']['platforms'] if p['platform'] == 'NOAA-21')
        self.assertTrue(coverage['first_month'])
        self.assertIsNone(coverage['sp_first_month'])
        self.assertEqual(coverage['eligible_sp_years'], [])
        self.assertTrue(any('сохранённый' in message for message in newest['warnings']))

    def test_zero_detections_with_product_can_support_a_proposal(self):
        proposal = build_plan(config(), 'anomaly', 'Aqua', metadata())
        self.assertEqual(proposal['options'][0]['status'], 'proposed')
        self.assertEqual(proposal['options'][0]['config'], config())
        absent = metadata()
        for row in absent['monthly']:
            if row['platform'] == 'Aqua':
                row.update(points=None, eligible_days=0)
        self.assertEqual(build_plan(config(), 'anomaly', 'Aqua', absent)['options'][0]['status'], 'unavailable')

    def test_baseline_expansion_is_explicit_and_target_year_is_left_out(self):
        original = config(start='2023-01-01', baseline_start=2023, baseline_end=2025)
        before = deepcopy(original)
        plan = build_plan(original, 'anomaly', 'Aqua', metadata())
        option = plan['options'][0]
        self.assertEqual(option['status'], 'proposed')
        self.assertLess(option['config']['baseline_end'], 2025)
        self.assertGreaterEqual(option['config']['baseline_end'] - option['config']['baseline_start'] + 1, 3)
        self.assertEqual({c['field'] for c in option['changes']}, {'start', 'baseline_start', 'baseline_end'})
        self.assertEqual(original, before)
        self.assertEqual(plan['requested_config'], before)
        self.assertEqual(plan['options'][-1]['config'], before)
        server.validate(option['config'])

    def test_short_platform_history_does_not_invent_three_reference_years(self):
        snapshot = metadata(('NOAA-21',), range(2024, 2026))
        plan = build_plan(config(), 'anomaly', 'NOAA-21', snapshot)
        self.assertEqual(plan['options'][0]['status'], 'unavailable')
        self.assertIn('три других', plan['options'][0]['reason'])
        early = build_plan(config(start='2010-01-01', end='2011-12-31', baseline_start=2010, baseline_end=2011),
                           'anomaly', 'NOAA-21', snapshot)
        self.assertEqual(early['options'][0]['status'], 'unavailable')
        self.assertEqual(early['options'][0]['config']['end'], '2011-12-31')

    def test_recent_mixed_month_changes_end_only_in_visible_option(self):
        snapshot = metadata()
        for row in snapshot['monthly']:
            if row['month'] >= '2025-10':
                row.update(nrt_points=4, preliminary=True)
        plan = build_plan(config(), 'anomaly', 'Aqua', snapshot)
        option = plan['options'][0]
        self.assertEqual(option['status'], 'proposed')
        self.assertEqual(option['config']['end'], '2025-09-30')
        self.assertEqual(plan['requested_config']['end'], '2025-12-31')
        self.assertEqual(next(c for c in option['changes'] if c['field'] == 'end')['from'], '2025-12-31')
        self.assertTrue(any('предварительн' in limit or 'NRT' in limit for limit in option['limitations']))
        server.validate(option['config'])

    def test_unknown_metadata_does_not_create_an_automatic_source(self):
        plan = build_plan(config(), 'anomaly', 'auto', {})
        self.assertEqual(plan['availability']['status'], 'unknown')
        self.assertIsNone(plan['recommended_option_id'])
        self.assertLessEqual(len(plan['options']), 3)
        self.assertTrue(all(option['status'] == 'unavailable' for option in plan['options']))
        manual = build_plan(config(), 'anomaly', 'Aqua', {})['options'][-1]
        self.assertEqual(manual['config'], config())
        self.assertEqual(manual['status'], 'proposed')
        self.assertIn('пригодность заранее не обещана', manual['description'])

    def test_compare_years_preserves_dates_and_does_not_sum_sources(self):
        plan = build_plan(config(), 'compare-years', 'auto', metadata())
        self.assertEqual(len(plan['options']), 3)
        for option in plan['options'][:-1]:
            self.assertEqual(option['config'], config())
            self.assertIn(option['platform'], server.PLATFORMS)
            self.assertNotIn('all', option['platform'])
        self.assertEqual(plan['options'][-1]['status'], 'unavailable')

    def test_transition_is_deferred_and_never_a_preflight_model(self):
        option = build_plan(config(), 'sensor-transition', 'NOAA-20', metadata())['options'][0]
        self.assertEqual(option['status'], 'proposed')
        self.assertIn('До результата', option['description'])
        self.assertNotIn('coefficient', option)
        no_heldout = config(end='2023-12-31')
        short = metadata(years=range(2020, 2023))
        self.assertEqual(build_plan(no_heldout, 'sensor-transition', 'NOAA-20', short)['options'][0]['status'], 'unavailable')

    def test_published_calendar_precedes_seed_and_corrupt_falls_back(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            cache = root / 'cache'
            server.atomic_json(root / 'web/data/world-calendar.json', metadata())
            server.atomic_json(cache / 'world-calendar/published.json', {**metadata(), 'revision': 'live'})
            snapshot, source, revision = load_calendar(cache, root)
            self.assertEqual((source, revision), ('published-world-calendar', 'live'))
            (cache / 'world-calendar/published.json').write_text('{broken')
            self.assertEqual(load_calendar(cache, root)[1], 'seed-world-calendar')
            self.assertEqual(snapshot['snapshot_at'], metadata()['snapshot_at'])


class StudyAssessmentTests(unittest.TestCase):
    def test_anomaly_assessment_is_scoped_to_selected_month(self):
        analysis = result()
        analysis['monthly'][1].update(comparison_status='insufficient_baseline', baseline_year_ids=[2023])
        self.assertEqual(assess(analysis, 'anomaly', 'NOAA-20', month='2024-04')['status'], 'ready')
        limited = assess(analysis, 'anomaly', 'NOAA-20')
        self.assertEqual(limited['status'], 'limited')
        self.assertEqual(limited['facts']['comparable_months'], ['2024-04'])
        rejected = assess(analysis, 'anomaly', 'NOAA-20', month='2025-04')
        self.assertEqual(rejected['status'], 'unavailable')
        self.assertEqual(rejected['facts']['target_months'], ['2025-04'])
        self.assertEqual(rejected['facts']['comparison_status'], {'insufficient_baseline': 1})

    def test_contaminated_or_too_short_reference_is_not_ready(self):
        analysis = result()
        analysis['monthly'][0]['baseline_year_ids'] = [2021, 2022, 2024]
        self.assertEqual(assess(analysis, 'anomaly', 'NOAA-20', month='2024-04')['status'], 'unavailable')

    def test_two_years_with_incomplete_target_days_are_limited(self):
        analysis = result()
        analysis['monthly'][1].update(eligible_days=1, comparison_status='insufficient_target_days')
        self.assertEqual(assess(analysis, 'compare-years', 'NOAA-20')['status'], 'limited')
        analysis['monthly'][1].update(eligible_days=30, comparison_status='incomplete_utc_day')
        self.assertEqual(assess(analysis, 'compare-years', 'NOAA-20')['status'], 'limited')

    def test_rejected_fit_never_admits_sensor_transition(self):
        analysis = result()
        analysis['models']['NOAA-20']['accepted'] = False
        self.assertEqual(assess(analysis, 'sensor-transition', 'NOAA-20')['status'], 'unavailable')
        analysis['models']['NOAA-20']['accepted'] = True
        analysis['models']['NOAA-20']['checks']['improves_uncorrected'] = False
        self.assertEqual(assess(analysis, 'sensor-transition', 'NOAA-20')['status'], 'unavailable')
        analysis['models']['NOAA-20']['checks']['improves_uncorrected'] = True
        self.assertEqual(assess(analysis, 'sensor-transition', 'NOAA-20')['status'], 'ready')

    def test_nrt_is_not_admitted_by_an_accepted_sp_model(self):
        analysis = result()
        analysis['monthly'][1].update(nrt_points=2, calibration_eligible=False, model_valid=False)
        assessment = assess(analysis, 'sensor-transition', 'NOAA-20')
        self.assertEqual(assessment['status'], 'limited')
        self.assertEqual(assessment['facts']['preliminary_months'], ['2025-04'])
        self.assertEqual(assess(analysis, 'anomaly', 'NOAA-20', month='2025-04')['status'], 'limited')

    def test_absence_is_not_zero_and_result_remains_bound_to_stored_sources(self):
        analysis = result()
        analysis['monthly'][1].update(cells=None, eligible_days=0, comparison_status='insufficient_target_days')
        assessment = assess(analysis, 'anomaly', 'NOAA-20', month='2025-04')
        self.assertEqual(assessment['status'], 'unavailable')
        self.assertEqual(assessment['facts']['source_sha256'], ['stored-source-hash'])
        self.assertEqual(assessment['facts']['snapshot_at'], 'stored-snapshot')
        self.assertEqual(assessment['local_coverage'], 'unknown')
        analysis['monthly'][1]['cells'] = 0
        analysis['monthly'][1]['eligible_days'] = 30
        self.assertEqual(assess(analysis, 'compare-years', 'NOAA-20')['status'], 'ready')


class StudyHTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.thread.join()

    def request(self, method, path, body=None):
        connection = HTTPConnection('127.0.0.1', self.httpd.server_port, timeout=5)
        try:
            connection.request(method, path, body=json.dumps(body) if body is not None else None,
                               headers={'Content-Type': 'application/json'})
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def test_preflight_never_starts_heavy_queries_or_jobs(self):
        before = deepcopy(server.JOBS)
        with tempfile.TemporaryDirectory() as folder, patch.object(server, 'CACHE', Path(folder)), \
                patch.object(server.POOL, 'submit') as analysis_jobs, patch.object(server.MATRIX_POOL, 'submit') as matrix_jobs, \
                patch.object(server, 'pinned_sources', side_effect=AssertionError('must not open archive')), \
                patch.object(server, 'connection', side_effect=AssertionError('bbox requires no DB')):
            status, plan = self.request('POST', '/api/v1/study-plan', dict(question='anomaly', platform='auto', config=config()))
        self.assertEqual(status, 200)
        self.assertEqual(plan['version'], 1)
        analysis_jobs.assert_not_called()
        matrix_jobs.assert_not_called()
        self.assertEqual(server.JOBS, before)

    def test_invalid_payload_and_geometry_are_rejected_before_jobs(self):
        for payload in ([], dict(question='unknown', config=config()),
                        dict(question='anomaly', platform='all', config=config()),
                        dict(question='anomaly', platform='Aqua', config=config(bbox=[0, 0, 0, 1])),
                        dict(question='anomaly', platform='Aqua', config=config(geometry={'type': 'Point', 'coordinates': [0, 0]}))):
            with self.subTest(payload=payload):
                self.assertEqual(self.request('POST', '/api/v1/study-plan', payload)[0], 400)

    def test_exact_polygon_hole_filters_and_circle_survive_options(self):
        geometry = {'type': 'Polygon', 'coordinates': [[[68, 53], [71, 53], [71, 55], [68, 55], [68, 53]],
                                                      [[69, 53.5], [69, 54], [70, 54], [70, 53.5], [69, 53.5]]]}
        for fields in (dict(geometry=geometry), dict(circle={'center': [179.8, 50], 'radius_km': 70})):
            requested = config(**fields, grid_km=5, daynight='N', quality='all', roi_name='Точная область', roi_source='drawn')
            normalized = server.validate(requested)
            status, plan = self.request('POST', '/api/v1/study-plan', dict(question='anomaly', platform='Aqua', config=requested))
            self.assertEqual(status, 200)
            for option in plan['options']:
                for field in ('bbox', 'geometry', 'circle', 'grid_km', 'daynight', 'quality', 'roi_name', 'roi_source'):
                    self.assertEqual(option['config'].get(field), normalized.get(field), field)

    def test_assessment_uses_completed_sources_not_current_calendar(self):
        identifier = 'f' * 32
        with tempfile.TemporaryDirectory() as folder, patch.object(server, 'CACHE', Path(folder)), \
                patch.object(server, 'load_calendar', side_effect=AssertionError('must assess saved snapshot')):
            server.atomic_json(Path(folder) / 'jobs' / (identifier + '.json'), result())
            status, assessment = self.request('GET', f'/api/v1/analyses/{identifier}/study-assessment?question=anomaly&platform=NOAA-20&month=2025-04')
            self.assertEqual(status, 200)
            self.assertEqual(assessment['facts']['analysis_id'], identifier)
            self.assertEqual(assessment['facts']['source_sha256'], ['stored-source-hash'])
            self.assertEqual(assessment['facts']['target_months'], ['2025-04'])
            self.assertEqual(self.request('GET', f'/api/v1/analyses/{identifier}/study-assessment?platform=NOAA-20&month=invalid')[0], 400)
            old = result()
            old['analysis_version'] = 'legacy'
            server.atomic_json(Path(folder) / 'jobs' / (identifier + '.json'), old)
            self.assertEqual(self.request('GET', f'/api/v1/analyses/{identifier}/study-assessment?platform=NOAA-20')[0], 409)


if __name__ == '__main__':
    unittest.main()
