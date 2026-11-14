import importlib.util
from pathlib import Path
import tempfile
import unittest

from scripts import sync_global_firms as firms


class GlobalMirrorTests(unittest.TestCase):
    def test_optional_aggregates_do_not_block_world_archive(self):
        item = {'id': '2000', 'properties': {'table:row_count': 100}, 'assets': {
            'data': {'href': './detections.parquet', 'file:size': 1000},
            'aggregate-r5': {'href': './aggregate-r5.parquet'}}}
        jobs = firms.make_plan({'assets': {}}, [item], live=False)
        self.assertEqual(len(jobs), 2)
        self.assertEqual(jobs[0]['kind'], 'observations')
        self.assertEqual(jobs[0]['source_url'], firms.UPSTREAM + 'detections/year=2000/detections.parquet')
        self.assertEqual(jobs[0]['declared_rows'], 100)

    def test_missing_raw_partition_is_an_error(self):
        with self.assertRaisesRegex(ValueError, 'Missing observations'):
            firms.make_plan({}, [{'id': '2000', 'properties': {}, 'assets': {}}])

    def test_unexpected_catalog_host_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'Unexpected source host'):
            firms.make_plan({}, [{'id': '2000', 'properties': {},
                                  'assets': {'data': {'href': 'https://example.com/data.parquet'}}}])

    @unittest.skipUnless(importlib.util.find_spec('duckdb'), 'Install requirements-global.txt for Parquet tests')
    def test_live_tail_deduplicates_against_base_and_prefers_standard(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'observations/year=2026').mkdir(parents=True)
            (root / 'live/year=2026').mkdir(parents=True)
            base = root / 'observations/year=2026/detections.parquet'
            live = root / 'live/year=2026/live.parquet'
            con = firms.connection()
            con.execute("""CREATE TABLE points AS SELECT 'VIIRS_NOAA20' sensor, 'NOAA-20' satellite,
                '2026-11-10 12:00:00'::TIMESTAMP acq_datetime, 'POINT (1 2)'::GEOMETRY geometry,
                'SP' quality, '1' version""")
            con.execute('COPY points TO ? (FORMAT PARQUET)', [str(base)])
            con.execute('INSERT INTO points SELECT sensor,satellite,acq_datetime+INTERVAL 1 DAY,geometry,quality,version FROM points')
            con.execute("INSERT INTO points SELECT sensor,satellite,acq_datetime,geometry,'NRT',version FROM points")
            con.execute('COPY points TO ? (FORMAT PARQUET)', [str(live)])
            con.close()
            assets = {
                str(base.relative_to(root)): {'kind': 'observations', 'path': str(base.relative_to(root)), 'sha256': 'base'},
                str(live.relative_to(root)): {'kind': 'live', 'path': str(live.relative_to(root)), 'year': 2026,
                                             'start': '2026-11-10T12:00:00Z', 'sha256': 'live'}}
            result = firms.build_live_tail(root, assets)
            self.assertEqual(result['rows'], 1)
            self.assertNotIn('year', {column['name'] for column in result['columns']})
            self.assertEqual(result['start'], '2026-11-11T12:00:00Z')
            con = firms.connection()
            self.assertEqual(con.execute('SELECT quality FROM read_parquet(?)', [str(root / result['path'])]).fetchone()[0], 'SP')
            con.close()


if __name__ == '__main__':
    unittest.main()
