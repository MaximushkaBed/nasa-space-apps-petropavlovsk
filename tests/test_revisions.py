from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from datetime import date, timedelta
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
import json
import multiprocessing
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

from api.revisions import RevisionError, RevisionStore, compare_results


def result():
    return dict(config=dict(preset='custom', bbox=[68, 53, 71, 55], start='2020-01-01', end='2025-12-31',
                            baseline_start=2020, baseline_end=2023, grid_km=10, quality='sp', daynight='all'),
                unit='active cell-days on a fixed 10 km EPSG:6933 grid', analysis_version='nasa-temporal-v4',
                extract_id='e' * 32, snapshot_at='2026-01-01T00:00:00Z', calculated_at='2026-01-02T00:00:00Z',
                provenance=dict(extract_version='nasa-spatial-v2', sources=[dict(path='year=2025', sha256='source-v1')]),
                monthly=[dict(month='2025-04', platform='NOAA-20', cells=20, points=30, eligible_days=30,
                              nrt_points=0, preliminary_days=0, comparison_status='ok', comparison_day_numbers=list(range(1, 31)),
                              baseline=10, baseline_low=8, baseline_high=12, baseline_year_ids=[2020, 2021, 2022, 2023],
                              anomaly_pct=100, percentile=100, model_valid=True, baseline_calibration_eligible=True,
                              aqua_equivalent=10, baseline_equivalent=5)],
                daily=[dict(date='2025-04-01', platform='NOAA-20', cells=20, points=30, sp_cells=20, nrt_points=0)],
                availability=[dict(date=f'2025-04-{day:02}', platform='NOAA-20', sp=True) for day in range(1, 31)],
                models={'NOAA-20': dict(accepted=True, coefficient=.5, fit_months=48, test_months=12,
                                       checks={'fit_months': True, 'test_months': True})})


def compare(a, b, **scope):
    return compare_results(a, b, **(dict(question='anomaly', platform='NOAA-20', month='2025-04') | scope))


def metric(comparison, name):
    return next(row for row in comparison['metrics'] if row['name'] == name)


def process_save(arguments):
    folder, identifier = arguments
    try:
        return RevisionStore(folder, max_snapshots=1).save(identifier, result())['status']
    except RevisionError as error:
        return error.status


class ImmutableStoreTests(unittest.TestCase):
    def test_save_is_idempotent_preserves_full_result_and_outlives_jobs(self):
        with tempfile.TemporaryDirectory() as folder:
            store = RevisionStore(folder, max_snapshots=1)
            identifier = 'a' * 32
            source = result()
            first = store.save(identifier, source)
            saved = store.directory / (identifier + '.json')
            bytes_before = saved.read_bytes()
            self.assertEqual(store.save(identifier, deepcopy(source)), first)
            self.assertEqual(saved.read_bytes(), bytes_before)
            source['monthly'][0]['cells'] = 999
            self.assertEqual(store.load(identifier)[0]['monthly'][0]['cells'], 20)
            self.assertEqual(store.snapshot(identifier)['retention'], 'saved')
            self.assertFalse((Path(folder) / 'jobs').exists())

    def test_same_id_with_different_result_is_never_overwritten(self):
        with tempfile.TemporaryDirectory() as folder:
            store = RevisionStore(folder)
            store.save('a' * 32, result())
            previous = (store.directory / ('a' * 32 + '.json')).read_bytes()
            changed = result()
            changed['monthly'][0]['cells'] = 21
            with self.assertRaises(RevisionError) as raised:
                store.save('a' * 32, changed)
            self.assertEqual(raised.exception.status, 409)
            self.assertEqual((store.directory / ('a' * 32 + '.json')).read_bytes(), previous)

    def test_count_byte_and_individual_quotas_preserve_existing_versions(self):
        with tempfile.TemporaryDirectory() as folder:
            store = RevisionStore(folder, max_snapshots=1)
            first = store.save('a' * 32, result())
            for limited in (store, RevisionStore(folder, max_total_bytes=first['bytes'] + 1), RevisionStore(folder, max_result_bytes=100)):
                with self.subTest(limit=limited.max_result_bytes), self.assertRaises(RevisionError) as raised:
                    limited.save('b' * 32, result())
                self.assertIn(raised.exception.status, (413, 507))
            self.assertEqual(store.snapshot('a' * 32)['retention'], 'saved')
            self.assertFalse((store.directory / ('b' * 32 + '.json')).exists())

    def test_concurrent_processes_cannot_exceed_quota(self):
        with tempfile.TemporaryDirectory() as folder:
            with multiprocessing.get_context('fork').Pool(3) as pool:
                receipts = pool.map(process_save, [(folder, c * 32) for c in 'abc'])
            self.assertEqual(receipts.count('saved'), 1)
            self.assertEqual(receipts.count(507), 2)
            self.assertEqual(len(list((Path(folder) / 'saved-analyses').glob('*.json'))), 1)

    def test_racing_idempotent_saves_publish_one_complete_file(self):
        with tempfile.TemporaryDirectory() as folder:
            with ThreadPoolExecutor(max_workers=4) as pool:
                receipts = list(pool.map(lambda _: RevisionStore(folder).save('a' * 32, result()), range(8)))
            self.assertTrue(all(r == receipts[0] for r in receipts))
            saved = Path(folder) / 'saved-analyses' / ('a' * 32 + '.json')
            self.assertEqual(json.loads(saved.read_bytes())['result'], result())
            self.assertEqual(list(saved.parent.glob('*.part')), [])

    def test_publication_is_atomic_and_failed_write_leaves_no_snapshot(self):
        with tempfile.TemporaryDirectory() as folder:
            store = RevisionStore(folder)
            original_link = os.link

            def observe_link(source, destination):
                self.assertFalse(Path(destination).exists())
                self.assertEqual(json.loads(Path(source).read_bytes())['result'], result())
                with self.assertRaises(RevisionError) as raised:
                    store.load('a' * 32)
                self.assertEqual(raised.exception.status, 404)
                original_link(source, destination)

            with patch('api.revisions.os.link', side_effect=observe_link):
                store.save('a' * 32, result())
            (store.directory / '.snapshot-interrupted.part').write_bytes(b'unpublished')
            with patch('api.revisions.os.fsync', side_effect=OSError('disk full')), self.assertRaises(RevisionError) as raised:
                store.save('b' * 32, result())
            self.assertEqual(raised.exception.status, 507)
            self.assertFalse((store.directory / ('b' * 32 + '.json')).exists())
            self.assertEqual(list(store.directory.glob('*.part')), [])

    def test_noncooperating_name_collision_cannot_replace_file(self):
        with tempfile.TemporaryDirectory() as folder:
            store = RevisionStore(folder)

            def collide(source, destination):
                Path(destination).write_text('external-writer')
                raise FileExistsError('collision')

            with patch('api.revisions.os.link', side_effect=collide), self.assertRaises(RevisionError) as raised:
                store.save('a' * 32, result())
            self.assertEqual(raised.exception.status, 409)
            self.assertEqual((store.directory / ('a' * 32 + '.json')).read_text(), 'external-writer')

    def test_saved_checksum_failure_does_not_fall_back_to_mutable_cache(self):
        with tempfile.TemporaryDirectory() as folder:
            store = RevisionStore(folder)
            identifier = 'a' * 32
            store.save(identifier, result())
            saved = store.directory / (identifier + '.json')
            envelope = json.loads(saved.read_bytes())
            envelope['result']['monthly'][0]['cells'] = 999
            saved.write_text(json.dumps(envelope))
            jobs = Path(folder) / 'jobs'
            jobs.mkdir()
            (jobs / (identifier + '.json')).write_text(json.dumps(result()))
            with self.assertRaises(RevisionError) as raised:
                store.snapshot(identifier)
            self.assertEqual(raised.exception.code, 'snapshot_corrupt')

    def test_cache_only_and_historical_versions_are_explicit(self):
        with tempfile.TemporaryDirectory() as folder:
            store = RevisionStore(folder)
            jobs = Path(folder) / 'jobs'
            jobs.mkdir()
            old = result()
            old['analysis_version'] = 'nasa-temporal-v3'
            (jobs / ('a' * 32 + '.json')).write_text(json.dumps(old))
            info = store.snapshot('a' * 32)
            self.assertEqual((info['retention'], info['method_status'], info['capabilities']['assessment']), ('cache-only', 'historical', 'unsupported'))
            self.assertEqual(store.save('a' * 32)['method_status'], 'historical')
            (jobs / ('a' * 32 + '.json')).unlink()
            self.assertEqual(store.snapshot('a' * 32)['retention'], 'saved')
            with self.assertRaises(RevisionError) as raised:
                store.snapshot('b' * 32)
            self.assertEqual(raised.exception.status, 404)


class RevisionComparisonTests(unittest.TestCase):
    def test_baseline_change_shows_numbers_and_derived_direction_without_causal_share(self):
        before, after = result(), result()
        after['config']['baseline_end'] = 2024
        after['monthly'][0].update(baseline=40, anomaly_pct=-50, baseline_year_ids=[2020, 2021, 2022, 2023, 2024])
        compared = compare(before, after)
        self.assertEqual(compared['status'], 'comparable')
        self.assertEqual(metric(compared, 'cells')['delta'], 0)
        self.assertEqual(metric(compared, 'baseline')['delta'], 30)
        self.assertTrue(compared['outcomes']['changed'])
        self.assertEqual(compared['outcomes']['before']['classification'], 'above-baseline')
        self.assertEqual(compared['outcomes']['after']['classification'], 'below-baseline')
        self.assertTrue(any(c['field'].endswith('baseline_year_ids') for c in compared['changes']))
        self.assertIn('не оценивался', compared['attribution']['reason'])

    def test_source_hash_change_without_recorded_effect_is_metadata_only(self):
        after = result()
        after['provenance']['sources'][0]['sha256'] = 'source-v2'
        after['snapshot_at'] = 'new snapshot'
        compared = compare(result(), after)
        self.assertFalse(compared['outcomes']['changed'])
        self.assertEqual(compared['attribution']['status'], 'unresolved')
        self.assertEqual(next(c for c in compared['changes'] if c['field'] == 'source_hashes')['evidence'], 'metadata-only')
        self.assertTrue(all(c['evidence'] == 'metadata-only' for c in compared['changes']))

    def test_different_roi_grid_filters_mask_or_method_never_claim_causal_revision(self):
        for kind in ('roi', 'grid', 'filters', 'mask', 'method'):
            after = result()
            if kind == 'roi': after['config']['bbox'] = [-10, 30, 0, 40]
            if kind == 'grid': after['config']['grid_km'] = 20
            if kind == 'filters': after['config']['quality'] = 'all'
            if kind == 'mask': after['monthly'][0]['comparison_day_numbers'] = list(range(1, 20))
            if kind == 'method': after['analysis_version'] = 'nasa-temporal-v3'
            after['monthly'][0].update(cells=5, anomaly_pct=-50)
            with self.subTest(kind=kind):
                compared = compare(result(), after)
                self.assertFalse(compared['comparability']['direct'])
                self.assertIsNone(compared['outcomes']['changed'])
                self.assertIsNone(metric(compared, 'cells')['delta'])
                self.assertEqual(compared['attribution']['status'], 'unresolved')

    def test_labels_do_not_change_roi_and_missing_preset_geometry_is_unknown(self):
        after = result()
        after['config'].update(roi_name='Новое название', roi_source='renamed')
        self.assertEqual(compare(result(), after)['comparability']['roi'], 'same')
        before = result()
        before['config']['preset'] = after['config']['preset'] = 'sko'
        self.assertEqual(compare(before, after)['comparability']['roi'], 'unknown')

    def test_null_is_not_zero_and_zero_baseline_has_no_percentage_verdict(self):
        before, after = result(), result()
        before['monthly'][0]['cells'] = None
        after['monthly'][0].update(cells=0, baseline=0, anomaly_pct=None)
        compared = compare(before, after)
        cells = metric(compared, 'cells')
        self.assertIsNone(cells['before'])
        self.assertEqual(cells['after'], 0)
        self.assertIsNone(cells['delta'])
        self.assertEqual(compared['outcomes']['after']['classification'], 'unavailable')

    def test_calibrated_values_never_fall_back_to_raw_or_raw_interval(self):
        before, after = result(), result()
        after['monthly'][0].update(model_valid=False, aqua_equivalent=None, baseline_equivalent=None)
        compared = compare(before, after, series_mode='calibrated')
        self.assertEqual(metric(compared, 'cells')['before'], 10)
        self.assertIsNone(metric(compared, 'cells')['after'])
        self.assertIsNone(metric(compared, 'anomaly_pct')['after'])
        self.assertNotIn('baseline_low', [m['name'] for m in compared['metrics']])
        self.assertEqual(compared['outcomes']['after']['classification'], 'unavailable')

    def test_actual_daily_and_available_date_differences_are_observed(self):
        after = result()
        after['daily'][0]['cells'] = 21
        after['availability'].pop()
        after['monthly'][0]['comparison_day_numbers'].pop()
        compared = compare(result(), after)
        changed = {c['field']:c for c in compared['changes']}
        self.assertEqual(changed['daily_values']['examples'][0]['before']['cells'], 20)
        self.assertEqual(changed['daily_values']['examples'][0]['after']['cells'], 21)
        self.assertEqual(changed['available_dates']['changed_records'], 1)
        self.assertFalse(compared['comparability']['direct'])

    def test_old_method_is_not_reassessed_and_transition_reads_stored_flags(self):
        old = result()
        old['analysis_version'] = 'nasa-temporal-v3'
        after = deepcopy(old)
        after['models']['NOAA-20']['accepted'] = False
        with patch('api.study_plan.assess', side_effect=AssertionError('no current assessor')), patch('api.analysis.analyze', side_effect=AssertionError('no recomputation')):
            compared = compare(old, after, question='sensor-transition', month=None)
        self.assertEqual(compared['outcomes']['after']['classification'], 'model-rejected')
        self.assertTrue(any('историческая' in warning for warning in compared['warnings']))

    def test_iso_years_are_separate_weekly_values_without_average_verdict(self):
        before = result()
        years = {}
        metrics = {}
        for year in (2024, 2025):
            years[str(year)] = [dict(week=1, cells=7, rate=1, eligible_days=7, complete=True)]
            metrics[str(year)] = dict(total_cells=7, available_weeks=1, start_date=date.fromisocalendar(year, 1, 1).isoformat(),
                                      end_date=(date.fromisocalendar(year + 1, 1, 1) - timedelta(days=1)).isoformat())
        before['weekly_profiles'] = {'NOAA-20': dict(year_basis='ISO', years=years, year_metrics=metrics)}
        after = deepcopy(before)
        after['weekly_profiles']['NOAA-20']['years']['2025'][0]['cells'] = 14
        compared = compare(before, after, question='compare-years', month=None, years='2024,2025')
        self.assertIsNone(compared['outcomes']['changed'])
        self.assertEqual(compared['outcomes']['before']['classification'], 'not-summarized')
        weeks = [m for m in compared['metrics'] if m['name'] == 'cells']
        self.assertEqual([(m['period'], m['delta']) for m in weeks], [('2024-W01', 0), ('2025-W01', 7)])
        with self.assertRaises(RevisionError) as raised:
            compare(before, after, question='compare-years', month=None, years='2024,2025', series_mode='calibrated')
        self.assertEqual(raised.exception.status, 422)


class RevisionHTTPTests(unittest.TestCase):
    def test_save_summary_changes_and_legacy_routes_do_not_start_jobs(self):
        from api import server
        httpd = ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        worker = threading.Thread(target=httpd.serve_forever, daemon=True)
        worker.start()

        def request(method, path, body=None):
            connection = HTTPConnection('127.0.0.1', httpd.server_port, timeout=5)
            try:
                connection.request(method, path, body=json.dumps(body) if body is not None else None)
                response = connection.getresponse()
                return response.status, json.loads(response.read())
            finally:
                connection.close()

        try:
            with tempfile.TemporaryDirectory() as folder, patch.object(server, 'CACHE', Path(folder)), \
                    patch.object(server.POOL, 'submit') as submit, patch.object(server, 'pinned_sources', side_effect=AssertionError('no archive')):
                jobs = Path(folder) / 'jobs'
                jobs.mkdir()
                old = result()
                old['analysis_version'] = 'nasa-temporal-v3'
                for identifier, value in [('a' * 32, old), ('b' * 32, result())]:
                    (jobs / (identifier + '.json')).write_text(json.dumps(value))
                self.assertEqual(request('POST', f'/api/v1/analyses/{"a" * 32}/save', {})[0], 200)
                self.assertEqual(request('POST', f'/api/v1/analyses/{"b" * 32}/save', {})[0], 200)
                self.assertEqual(request('GET', f'/api/v1/analyses/{"a" * 32}/snapshot')[1]['retention'], 'saved')
                status, comparison = request('GET', f'/api/v1/analyses/{"b" * 32}/changes?before={"a" * 32}&platform=NOAA-20&month=2025-04')
                self.assertEqual(status, 200)
                self.assertEqual(comparison['status'], 'limited')
                self.assertEqual(request('POST', f'/api/v1/analyses/{"a" * 32}/save', {'result': 'forged'})[0], 400)
                self.assertEqual(request('GET', f'/api/v1/analyses/{"c" * 32}/snapshot')[0], 404)
                for cached in jobs.glob('*.json'):
                    cached.unlink()
                self.assertEqual(request('GET', f'/api/v1/analyses/{"b" * 32}')[0], 200)
                self.assertEqual(request('GET', f'/api/v1/analyses/{"a" * 32}')[0], 409)
                self.assertEqual(request('GET', f'/api/v1/analyses/{"b" * 32}/study-assessment?platform=NOAA-20&month=2025-04')[0], 200)
                submit.assert_not_called()
        finally:
            httpd.shutdown()
            httpd.server_close()
            worker.join()


if __name__ == '__main__':
    unittest.main()
