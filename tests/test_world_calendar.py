"""Global raw-calendar comparisons must use identical calendar dates."""
import calendar
from contextlib import contextmanager
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from api import world_calendar


def records(years=(2022, 2023, 2024, 2025), month=4, value=lambda y, d: 10,
            skip=lambda y, d: False, nrt=lambda y, d: 0, sp=lambda y, d: True):
    return [[f'{year}-{month:02}-{day:02}', 'Terra', value(year, day), nrt(year, day), sp(year, day)]
            for year in years for day in range(1, calendar.monthrange(year, month)[1] + 1)
            if not skip(year, day)]


def target(data, month='2025-04', through='2025-05-01T00:00:00Z'):
    return next(row for row in world_calendar.monthly_rows([data], min(r[0] for r in data), through)
                if row['month'] == month and row['platform'] == 'Terra')


class WorldCalendarTests(unittest.TestCase):
    def test_missing_target_peak_is_also_excluded_from_every_reference(self):
        data = records(value=lambda y, d: 2000 if d == 15 else 10,
                       skip=lambda y, d: y == 2025 and d == 15)
        row = target(data)
        self.assertEqual(row['points'], 290)
        self.assertEqual(row['anomaly_pct'], 0)
        self.assertNotIn(15, row['comparison_day_numbers'])
        self.assertEqual(row['baseline_year_ids'], [2022, 2023, 2024])

    def test_missing_or_preliminary_reference_date_excludes_that_year(self):
        variants = [dict(skip=lambda y, d: y == 2023 and d == 15),
                    dict(nrt=lambda y, d: int(y == 2023 and d == 15)),
                    dict(sp=lambda y, d: not (y == 2023 and d == 15))]
        for variant in variants:
            with self.subTest(variant=variant):
                row = target(records(**variant))
                self.assertEqual(row['baseline_year_ids'], [2022, 2024])
                self.assertEqual(row['comparison_status'], 'insufficient_baseline')
                self.assertIsNone(row['anomaly_pct'])

    def test_reference_dates_outside_target_mask_do_not_bias_comparison(self):
        data = records(value=lambda y, d: 2000 if d == 15 else 10,
                       skip=lambda y, d: y == 2025 and d == 15,
                       nrt=lambda y, d: int(y == 2023 and d == 15))
        self.assertEqual(target(data)['anomaly_pct'], 0)

    def test_last_incomplete_utc_day_cannot_enter_a_reference_mask(self):
        data = records(years=(2021, 2022, 2023, 2024))
        row = target(data, '2021-04', '2024-04-30T12:00:00Z')
        self.assertEqual(row['baseline_year_ids'], [2022, 2023])
        self.assertIsNone(row['anomaly_pct'])

    def test_february_uses_same_dates_and_never_invents_february_29(self):
        data = records(month=2, value=lambda y, d: 2000 if d == 29 else
                       {2022: 1, 2023: 3, 2024: 2, 2025: 2}[y])
        self.assertEqual(target(data, '2025-02', '2025-03-01T00:00:00Z')['anomaly_pct'], 0)
        row = target(records(years=(2020, 2022, 2023, 2024), month=2),
                     '2020-02', '2025-03-01T00:00:00Z')
        self.assertEqual(row['baseline_year_ids'], [2024])
        self.assertIsNone(row['anomaly_pct'])

    def test_unknown_zero_preliminary_partial_and_self_reference_are_distinct(self):
        self.assertEqual(target(records(value=lambda y, d: 0 if y == 2025 else 10))['anomaly_pct'], -100)
        for data, through in [
            (records(skip=lambda y, d: y == 2025), '2025-05-01T00:00:00Z'),
            (records(nrt=lambda y, d: int(y == 2025 and d == 15)), '2025-05-01T00:00:00Z'),
            (records(sp=lambda y, d: not (y == 2025 and d == 15)), '2025-05-01T00:00:00Z'),
            (records(), '2025-04-30T12:00:00Z'),
        ]:
            with self.subTest(through=through):
                self.assertIsNone(target(data, through=through)['anomaly_pct'])
        self.assertIsNone(target(records(), '2024-04')['anomaly_pct'])

    def test_method_upgrade_reuses_existing_daily_cache_without_parquet_scan(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            data = root / 'data'
            data.mkdir()
            cache = root / 'cache'
            directory = cache / 'world-calendar'
            directory.mkdir(parents=True)
            asset = dict(kind='observations', rows=1, path='archive', fd='archive', sha256='archive',
                         start='2022-01-01T00:00:00Z', end='2025-05-01T00:00:00Z')
            state = dict(status='ready', updated_at='snapshot', assets={'archive': asset})

            def write(path, value):
                path.write_text(json.dumps(value))

            @contextmanager
            def pin(_):
                yield state, [asset]

            write(data / 'manifest.json', state)
            old_revision = hashlib.sha256(b'1:archive').hexdigest()
            write(directory / 'published.json', {'revision': old_revision, 'monthly': []})
            write(directory / 'days-1-archive.json', records())
            with patch.object(world_calendar, 'read_days', side_effect=AssertionError('Unexpected raw scan')) as scan:
                world_calendar.refresh(data, cache, pin, write)
                scan.assert_not_called()
            result = json.loads((directory / 'published.json').read_text())
            self.assertEqual(result['method_version'], world_calendar.VERSION)
            self.assertNotEqual(result['revision'], old_revision)
            self.assertEqual(next(r for r in result['monthly'] if r['month'] == '2025-04'
                                  and r['platform'] == 'Terra')['anomaly_pct'], 0)
            self.assertTrue((directory / 'days-1-archive.json').exists())
