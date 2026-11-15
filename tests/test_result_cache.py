"""Result cache regressions: real HTTP, source pinning, synthetic calculations.

No test reads the production archive or requests remote scientific sources.
"""
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
import copy
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from api import server, matrix
from api.result_cache import analysis_key, spatial_key, scientific_config


class Queue:
    def __init__(self):
        self.pending = deque()
        self.calls = 0

    def submit(self, function, *args):
        self.calls += 1
        self.pending.append((function, args))

    def drain(self):
        while self.pending:
            function, args = self.pending.popleft()
            function(*args)


class ResultIdentityTests(unittest.TestCase):
    def test_only_display_fields_source_order_and_irrelevant_snapshot_time_are_ignored(self):
        config = dict(preset='custom', bbox=[0, 0, 1, 1], start='2020-01-01', end='2021-12-31',
                      baseline_start=2020, baseline_end=2020, grid_km=10, quality='sp', daynight='all')
        sources = [dict(path=f'observations/year={year}/detections.parquet', year=year, sha256=str(year))
                   for year in (2020, 2021)]
        def key(cfg=config, src=sources, through='2026-11-14', method='v4', shape='exact-shape', outage='outages'):
            return analysis_key(cfg, src, shape, outage, 'extract-v2', method, through)
        expected = key()
        self.assertEqual(expected, key(config | dict(roi_name='New York', roi_source='OSM'), list(reversed(sources))))
        self.assertEqual(expected, key(config | dict(bbox=[0., 0., 1., 1.]), through='2026-11-15'))
        for change in (dict(grid_km=5), dict(quality='all'), dict(daynight='N'), dict(start='2020-02-01'),
                       dict(end='2021-11-30'), dict(baseline_end=2021), dict(bbox=[0, 0, 1, 1.00000000001]),
                       dict(preset='sko')):
            with self.subTest(change=change):
                self.assertNotEqual(expected, key(config | change))
        self.assertNotEqual(expected, key(src=[sources[0] | dict(sha256='new'), sources[1]]))
        self.assertNotEqual(expected, key(method='v5'))
        self.assertNotEqual(expected, key(shape='changed-boundary'))
        self.assertNotEqual(expected, key(outage='changed-outages'))
        self.assertNotEqual(expected, key(through='2021-12-31'))
        self.assertNotEqual(key(through='2021-12-30'), key(through='2021-12-31'))
        self.assertEqual(spatial_key(config, sources, 'shape', 'outage', 'v2'),
                         spatial_key(config | dict(baseline_end=2021, roi_name='Alias'),
                                     list(reversed(sources)), 'shape', 'outage', 'v2'))

    def test_exact_geometry_holes_and_circle_metadata_are_preserved(self):
        geometry = dict(type='Polygon', coordinates=[[[0, 0], [1, 0], [1, 1], [0, 0]],
                                                     [[.1, .1], [.2, .1], [.2, .2], [.1, .1]]])
        config = dict(preset='custom', bbox=[0, 0, 1, 1], geometry=geometry)
        original = scientific_config(config)
        changed = copy.deepcopy(config)
        changed['geometry']['coordinates'][1][1][0] += 1e-12
        self.assertNotEqual(original, scientific_config(changed))
        self.assertEqual(original['geometry']['coordinates'][1][1][0], .2)
        self.assertNotEqual(original, scientific_config(config | dict(circle=dict(center=[.5, .5], radius_km=2))))


class ResultCacheHTTPTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='nasa-result-cache-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.cache, self.data = self.root / 'cache', self.root / 'data'
        self.cache.mkdir(); self.data.mkdir()
        self.source = self.data / 'observations/year=2020/detections.parquet'
        self.source.parent.mkdir(parents=True)
        self.source.write_bytes(b'old-source')
        (self.data / '.sync.lock').touch()
        self.outage_file = self.root / 'docs/sko-validation/outages.csv'
        self.outage_file.parent.mkdir(parents=True)
        self.outage_file.write_text('start_utc,end_utc_inclusive,platform\n')
        self.state = dict(status='ready', producer='synthetic', mirror='synthetic', updated_at='snapshot-one',
                          assets={'observations/year=2020/detections.parquet': dict(kind='observations', year=2020,
                                  path='observations/year=2020/detections.parquet', sha256='1' * 64,
                                  start='2020-01-01T00:00:00Z', end='2020-12-31T23:00:00Z')})
        self.manifest()
        self.config = dict(preset='custom', bbox=[-60, -17, -54, -10], start='2020-01-01', end='2020-12-31',
                           baseline_start=2020, baseline_end=2020, grid_km=10, quality='sp', daynight='all')
        self.analysis_queue, self.matrix_queue = Queue(), Queue()
        self.scanned = []
        self.scope = ExitStack()
        self.addCleanup(self.scope.close)
        for name, value in [('ROOT', self.root), ('DATA', self.data), ('CACHE', self.cache), ('JOBS', {}),
                            ('MATRIX_JOBS', {}), ('ANALYSIS_REQUESTS', {}), ('MATRIX_REQUESTS', {}),
                            ('PRIMED_RESULT_INDEXES', set()), ('ACTIVE_EXTRACTS', server.Counter()),
                            ('POOL', self.analysis_queue), ('MATRIX_POOL', self.matrix_queue),
                            ('extract', self.extract), ('analyze', lambda *args: dict(monthly=[], models={}))]:
            self.scope.enter_context(patch.object(server, name, value))
        self.scope.enter_context(patch.object(matrix, 'build', self.build_matrix))
        class QuietHandler(server.Handler):
            def log_message(self, *args):
                pass
        self.http = ThreadingHTTPServer(('127.0.0.1', 0), QuietHandler)
        threading.Thread(target=self.http.serve_forever, daemon=True).start()
        self.addCleanup(self.close_server)
        self.addCleanup(self.drain)

    def close_server(self):
        self.http.shutdown()
        self.http.server_close()

    def drain(self):
        self.analysis_queue.drain()
        self.matrix_queue.drain()

    def manifest(self):
        (self.data / 'manifest.json').write_text(json.dumps(self.state))

    def extract(self, job, config, sources, key, **kwargs):
        folder = self.cache / 'extracts' / key
        folder.mkdir(parents=True, exist_ok=True)
        cached = server.read_json(folder / 'daily.json')
        if cached and all(server.parquet_ready(folder / f'{s["year"]}.parquet') for s in sources):
            return cached
        self.scanned.append([Path(source['fd']).read_bytes() for source in sources])
        for source in sources:
            (folder / f'{source["year"]}.parquet').write_bytes(b'PAR1' + b'\0' * 4 + b'PAR1')
        result = dict(daily=[], availability=[])
        server.atomic_json(folder / 'daily.json', result)
        return result

    def build_matrix(self, analysis, analysis_id, progress):
        return {key: copy.deepcopy(analysis[key]) for key in ('config', 'extract_id', 'snapshot_at')} | dict(
            analysis_id=analysis_id, version=matrix.VERSION, warnings_sources=[], results={})

    def request(self, path='/api/v1/analyses', body=None, method='POST'):
        connection = HTTPConnection('127.0.0.1', self.http.server_port, timeout=10)
        try:
            connection.request(method, path, json.dumps(self.config if body is None else body),
                               {'Content-Type': 'application/json'})
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def post(self, config=None):
        return self.request(body=self.config if config is None else config)[1]

    def matrix(self, analysis_id):
        return self.request(f'/api/v1/analyses/{analysis_id}/matrix', {})[1]

    def restart(self):
        server.JOBS.clear(); server.MATRIX_JOBS.clear()
        server.ANALYSIS_REQUESTS.clear(); server.MATRIX_REQUESTS.clear()
        server.PRIMED_RESULT_INDEXES.clear()

    def test_concurrent_inflight_completed_and_restart_reuse_one_immutable_result(self):
        with ThreadPoolExecutor(max_workers=4) as requests:
            pending = list(requests.map(lambda _: self.post(), range(4)))
        identifier = pending[0]['id']
        self.assertEqual({r['id'] for r in pending}, {identifier})
        self.assertEqual(self.analysis_queue.calls, 1)
        self.drain()
        original = (self.cache / 'jobs' / (identifier + '.json')).read_bytes()
        self.assertEqual(self.post()['id'], identifier)
        self.assertEqual(self.post(self.config | dict(roi_name='Alias', roi_source='OSM'))['id'], identifier)
        self.restart()
        self.state['updated_at'] = 'irrelevant-manifest-refresh'
        self.manifest()
        self.assertEqual(self.post()['id'], identifier)
        self.assertEqual(self.analysis_queue.calls, 1)
        self.assertEqual((self.cache / 'jobs' / (identifier + '.json')).read_bytes(), original)

    def test_existing_random_ids_and_extracts_are_adopted_without_recalculation(self):
        identifier = self.post()['id']; self.drain()
        matrix_id = self.matrix(identifier)['id']; self.drain()
        original = (self.cache / 'jobs' / (identifier + '.json')).read_bytes()
        shutil.rmtree(self.cache / 'result-index')
        self.restart()
        self.assertEqual(self.post(self.config | dict(roi_name='New name'))['id'], identifier)
        self.assertEqual(self.matrix(identifier)['id'], matrix_id)
        self.assertEqual((self.analysis_queue.calls, self.matrix_queue.calls), (1, 1))
        self.assertEqual((self.cache / 'jobs' / (identifier + '.json')).read_bytes(), original)

    def test_queued_worker_uses_pinned_inode_matching_its_cache_identity(self):
        old = self.post()['id']
        old_arguments = self.analysis_queue.pending[0][1]
        old_fd = old_arguments[2]['archive'][1][0]['fd']
        replacement = self.source.with_suffix('.new')
        replacement.write_bytes(b'new-source'); replacement.replace(self.source)
        self.state['assets'][self.source.relative_to(self.data).as_posix()]['sha256'] = '2' * 64
        self.manifest()
        new = self.post()['id']
        self.assertNotEqual(old, new)
        self.drain()
        self.assertEqual(self.scanned, [[b'old-source'], [b'new-source']])
        self.assertFalse(Path(old_fd).exists())
        for identifier, expected in ((old, '1' * 64), (new, '2' * 64)):
            result = json.loads((self.cache / 'jobs' / (identifier + '.json')).read_text())
            self.assertEqual(result['provenance']['sources'][0]['sha256'], expected)

    def test_failed_submit_closes_source_pins_and_allows_retry(self):
        descriptors = []
        def reject(function, *args):
            descriptors.append(args[2]['archive'][1][0]['fd'])
            raise RuntimeError('synthetic queue failure')
        with patch.object(self.analysis_queue, 'submit', side_effect=reject):
            status, _ = self.request()
        self.assertEqual(status, 503)
        self.assertFalse(Path(descriptors[0]).exists())
        self.assertEqual(server.ANALYSIS_REQUESTS, {})
        self.assertEqual(self.post()['status'], 'queued')

    def test_errors_corrupt_json_and_evicted_or_truncated_extracts_can_be_repaired(self):
        identifier = self.post()['id']
        with patch.object(server, 'extract', side_effect=ValueError('synthetic failure')):
            self.drain()
        retry = self.post()['id']
        self.assertNotEqual(identifier, retry)
        self.drain()
        self.restart()
        (self.cache / 'jobs' / (retry + '.json')).write_text('{broken')
        repaired = self.post()['id']; self.drain()
        self.assertNotEqual(repaired, retry)
        for content in (None, b'truncated-parquet'):
            result = json.loads((self.cache / 'jobs' / (repaired + '.json')).read_text())
            path = self.cache / 'extracts' / result['extract_id'] / '2020.parquet'
            if content is None:
                path.unlink()
            else:
                path.write_bytes(content)
            next_id = self.post()['id']; self.drain()
            self.assertNotEqual(next_id, repaired)
            repaired = next_id
        self.assertEqual(self.post()['id'], repaired)

    def test_scientific_configuration_policy_and_method_changes_invalidate_results(self):
        original = self.post()['id']; self.drain()
        for change in (dict(daynight='D'), dict(quality='all'), dict(grid_km=5), dict(bbox=[-59, -17, -54, -10])):
            with self.subTest(change=change):
                changed = self.post(self.config | change)['id']; self.drain()
                self.assertNotEqual(original, changed)
        with patch.object(server, 'ANALYSIS_VERSION', 'new-scientific-method'):
            changed = self.post()['id']; self.drain()
            self.assertNotEqual(original, changed)
        self.assertEqual(self.post()['id'], original)
        self.outage_file.write_text('start_utc,end_utc_inclusive,platform\n2020-01-01,2020-01-02,Aqua\n')
        self.assertNotEqual(self.post()['id'], original)

    def test_matrix_results_survive_restart_and_partial_sources_retry_after_300_seconds(self):
        analysis_id = self.post()['id']; self.drain()
        first = self.matrix(analysis_id)['id']
        self.assertEqual(self.matrix(analysis_id)['id'], first)
        self.assertEqual(self.matrix_queue.calls, 1)
        self.drain()
        self.restart()
        self.assertEqual(self.matrix(analysis_id)['id'], first)
        path = self.cache / 'matrix/jobs' / (first + '.json')
        result = json.loads(path.read_text()); result['warnings_sources'] = ['missing weather']
        path.write_text(json.dumps(result))
        self.assertEqual(self.matrix(analysis_id)['id'], first)
        os.utime(path, (time.time() - 301, time.time() - 301))
        repaired = self.matrix(analysis_id)['id']; self.drain()
        self.assertNotEqual(first, repaired)
        self.assertEqual(json.loads(path.read_text())['warnings_sources'], ['missing weather'])
        with patch.object(matrix, 'VERSION', 'new-matrix-method'):
            self.assertNotEqual(self.matrix(analysis_id)['id'], repaired)


if __name__ == '__main__':
    unittest.main()
