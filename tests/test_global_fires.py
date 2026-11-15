import gzip
import json
import struct
import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest.mock import patch

import duckdb

from scripts.serve_global_fires import FireArchive, InvalidPeriod, archive_range, parse_period_query, parse_viewport


class GlobalFireTests(unittest.TestCase):
    def test_viewport_validates_dates_bbox_and_satellite(self):
        parsed = parse_period_query("start=2025-04-01&end=2025-04-12&bbox=179,-1,-179,1&satellite=2", viewport=True)
        self.assertEqual(parsed, (date(2025, 4, 1), date(2025, 4, 12), 2, (179, -1, -179, 1)))
        for value in ("0,0,20.1,2", "0,0,3,15.1", "180,0,-180,1", "5,-1,4,1", "nan,0,3,2", "0,1,3,0", "0,0,3"):
            with self.subTest(value=value), self.assertRaises(InvalidPeriod):
                parse_viewport(value)
        with self.assertRaises(InvalidPeriod):
            parse_period_query("start=2025-04-01&end=2025-04-12&bbox=0,0,3,2&satellite=5", viewport=True)

    def test_viewport_returns_original_detections_and_handles_archive_limits(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            base = root / "observations/year=2025/detections.parquet"
            tail = root / "derived/live-tail.parquet"
            base.parent.mkdir(parents=True)
            tail.parent.mkdir()
            (root / "catalog.json").write_text(json.dumps({
                "updated_at": "2025-04-13T06:00:00Z",
                "assets": [{"kind": "observations", "rows": 6, "start": "2025-02-01", "end": "2025-04-12"}],
                "live_tail": {"rows": 1, "start": "2025-04-13", "end": "2025-04-13"},
            }), encoding="utf-8")
            with duckdb.connect() as conn:
                conn.execute("""CREATE TABLE detections (
                    acq_date DATE, acq_datetime TIMESTAMP, satellite VARCHAR, type INTEGER,
                    confidence VARCHAR, confidence_pct INTEGER, geometry GEOMETRY)""")
                rows = [
                    ("2025-04-12", "2025-04-12 12:07:00", "Suomi-NPP", 0, "n", None, 179.7, 0),
                    ("2025-04-12", "2025-04-12 12:18:00", "Suomi-NPP", 0, "n", None, 179.7, 0),
                    ("2025-04-12", "2025-04-12 12:21:00", "Suomi NPP", 0, "h", None, -179.41234567, -0.5),
                    ("2025-04-12", None, "Aqua", 0, None, 25, -179.2, -0.5),
                    ("2025-02-01", None, "Terra", 2, None, 100, 179.4, 0.5),
                    ("2025-04-12", None, "Aqua", 0, None, 95, 175, -0.5),
                    ("2025-04-13", None, "NOAA-21", None, "h", None, -179.8, 0),
                ]
                conn.executemany("INSERT INTO detections VALUES (?, ?, ?, ?, ?, ?, ST_GeomFromWKB(?))",
                                 [(*attributes, struct.pack("<BIdd", 1, 1, lon, lat))
                                  for *attributes, lon, lat in rows])
                conn.execute("COPY (SELECT * FROM detections WHERE acq_date < DATE '2025-04-13') TO ?", [str(base)])
                conn.execute("COPY (SELECT * EXCLUDE(acq_datetime) FROM detections WHERE acq_date = DATE '2025-04-13') TO ?", [str(tail)])

            archive = FireArchive(root)
            try:
                start, end = date(2025, 4, 12), date(2025, 4, 13)
                bounds = parse_viewport("179,-1,-179,1")
                frame = json.loads(gzip.decompress(archive.viewport(start, end, bounds)))
                self.assertEqual(frame["status"], "ok")
                self.assertEqual(frame["method"], "filtered")
                self.assertEqual(frame["missing"], [])
                expected = [[179.7, 0, 2, 1, "2025-04-12T12:07:00Z"],
                            [179.7, 0, 2, 1, "2025-04-12T12:18:00Z"],
                            [-179.41234567, -0.5, 2, 1, "2025-04-12T12:21:00Z"]]
                self.assertCountEqual(frame["points"], [*expected, [-179.8, 0, 4, 1, "2025-04-13"]])
                filtered = json.loads(gzip.decompress(archive.viewport(start, end, bounds, 2)))
                self.assertCountEqual(filtered["points"], expected)
                long = json.loads(gzip.decompress(archive.viewport(date(2025, 2, 1), end, bounds)))
                self.assertEqual(long["method"], "archive")
                self.assertCountEqual(long["points"], [*frame["points"], [-179.2, -0.5, 0, 1, "2025-04-12"],
                                                       [179.4, 0.5, 1, 1, "2025-02-01"]])
                with self.assertRaises(InvalidPeriod):
                    archive.viewport(date(2025, 2, 1), end, bounds, 2)
                with patch("scripts.serve_global_fires.VIEWPORT_LIMIT", 2):
                    dense = json.loads(gzip.decompress(archive.viewport(start, end, (179.1, -1, -179, 1))))
                    self.assertEqual(dense["status"], "too_dense")
                    self.assertEqual(dense["points"], [])
                with archive.viewport_lock:
                    busy = json.loads(gzip.decompress(archive.viewport(start, end, bounds)))
                    self.assertEqual((busy["status"], busy["reason"], busy["points"]), ("too_slow", "busy", []))
                blank = json.loads(gzip.decompress(archive.viewport(start, end, (42, -1, 43, 1))))
                self.assertEqual((blank["status"], blank["points"]), ("ok", []))
            finally:
                archive.connection.close()
    def test_day_filters_and_combines_archive_with_fresh_tail(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            base = root / "observations/year=2025/detections.parquet"
            tail = root / "derived/live-tail.parquet"
            base.parent.mkdir(parents=True)
            tail.parent.mkdir()
            (root / "catalog.json").write_text(json.dumps({
                "updated_at": "2025-04-13T06:00:00Z",
                "assets": [{
                    "kind": "observations", "rows": 6,
                    "start": "2025-04-11T00:00:00Z", "end": "2025-04-12T23:00:00Z",
                }],
                "live_tail": {"rows": 1, "start": "2025-04-13T01:00:00Z", "end": "2025-04-13T01:00:00Z"},
            }), encoding="utf-8")
            with duckdb.connect() as conn:
                conn.execute("""CREATE TABLE detections (
                    acq_date DATE, satellite VARCHAR, type INTEGER, confidence VARCHAR,
                    confidence_pct INTEGER, geometry GEOMETRY)""")
                rows = [
                    ("2025-04-12", "Suomi-NPP", 0, "n", None, -61, 8),
                    ("2025-04-12", "Aqua", 0, None, 25, 72, 53),
                    ("2025-04-12", "Terra", 2, None, 100, 36, 25),
                    ("2025-04-11", "Aqua", 0, None, 95, 120, -31),
                    ("2025-04-13", "NOAA-21", None, "h", None, 113, -20),
                    ("2025-04-11", "Aqua", 0, None, 95, 69, 54),
                    ("2025-04-11", "Aqua", 0, None, 95, 69.001, 54.001),
                ]
                conn.executemany("INSERT INTO detections VALUES (?, ?, ?, ?, ?, ST_GeomFromWKB(?))",
                                 [(*attributes, struct.pack("<BIdd", 1, 1, lon, lat))
                                  for *attributes, lon, lat in rows])
                conn.execute("COPY (SELECT * FROM detections WHERE acq_date < DATE '2025-04-13') TO ?", [str(base)])
                conn.execute("COPY (SELECT * FROM detections WHERE acq_date = DATE '2025-04-13') TO ?", [str(tail)])

            archive = FireArchive(root)
            try:
                self.assertEqual(archive_range(root)["last"], "2025-04-13")
                day = date(2025, 4, 12)
                body = archive.frame(day)
                self.assertEqual(json.loads(gzip.decompress(body)), {"date": "2025-04-12", "points": [[-61, 8, 2]]})
                self.assertIs(archive.frame(day), body)
                self.assertEqual(json.loads(gzip.decompress(archive.frame(date(2025, 4, 13))))["points"], [[113, -20, 4]])
                self.assertIsNone(archive.frame(date(2025, 4, 14)))

                period = archive.period(date(2025, 4, 11), date(2025, 4, 13), 0)
                frame = json.loads(gzip.decompress(period))
                self.assertIs(archive.period(date(2025, 4, 11), date(2025, 4, 13), 0), period)
                self.assertEqual(frame["missing"], [])
                self.assertEqual(frame["method"], "filtered")
                self.assertEqual(frame["total"], 3)
                self.assertEqual(frame["regionalCount"], 2)
                self.assertEqual(frame["regionalByPlatform"], {"0": 2})
                self.assertTrue(frame["regionalExact"])
                self.assertCountEqual(frame["points"], [[120, -31, 0, 1], [69.0005, 54.0005, 0, 2]])
            finally:
                archive.connection.close()

    def test_long_period_selects_annual_daily_columns_and_appends_live_tail(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            old = root / "aggregate/year=2024/aggregate-r8.parquet"
            new = root / "aggregate/year=2025/aggregate-r5.parquet"
            fine = root / "aggregate/year=2025/aggregate-r8.parquet"
            tail = root / "derived/live-tail.parquet"
            for path in (old, new, tail):
                path.parent.mkdir(parents=True)
            (root / "catalog.json").write_text(json.dumps({
                "updated_at": "2025-02-01T06:00:00Z",
                "assets": [{
                    "kind": "observations", "rows": 100,
                    "start": "2024-12-24T00:00:00Z", "end": "2025-01-30T23:00:00Z",
                }],
                "live_tail": {"rows": 1, "start": "2025-01-30T23:00:00Z", "end": "2025-02-01T01:00:00Z"},
            }), encoding="utf-8")
            with duckdb.connect() as conn:
                conn.execute("""COPY (SELECT 111 AS count, 100 AS count_20241224,
                                      11 AS count_20241225,
                                      {'xmin':68.9,'xmax':69.1,'ymin':53.9,'ymax':54.1} AS bbox) TO ?""", [str(old)])
                conn.execute("""COPY (SELECT 50 AS count, 20 AS count_20250129,
                                      30 AS count_20250130,
                                      {'xmin':119.9,'xmax':120.1,'ymin':15.9,'ymax':16.1} AS bbox) TO ?""", [str(new)])
                conn.execute("""COPY (SELECT n AS count, n AS count_20250129,
                                      {'xmin':lon,'xmax':lon,'ymin':lat,'ymax':lat} AS bbox
                                      FROM (VALUES (7, 119.8, 15.9), (13, 120.25, 16.72)) AS cells(n, lon, lat)) TO ?""",
                             [str(fine)])
                conn.execute("""COPY (SELECT DATE '2025-02-01' AS acq_date,
                                      ST_GeomFromWKB(?) AS geometry) TO ?""",
                             [struct.pack("<BIdd", 1, 1, 69, 54), str(tail)])

            archive = FireArchive(root)
            try:
                start, end = date(2024, 12, 25), date(2025, 2, 1)
                frame = json.loads(gzip.decompress(archive.period(start, end)))
                self.assertEqual(frame["method"], "publisher")
                self.assertEqual(frame["coveredEnd"], "2025-02-01")
                self.assertEqual(frame["missing"], [{"start": "2024-12-26", "end": "2025-01-28"}])
                self.assertEqual(frame["total"], 62)
                self.assertEqual(frame["regionalCount"], 12)
                self.assertFalse(frame["regionalExact"])
                self.assertEqual(frame["cellDegrees"], .5)
                self.assertCountEqual(frame["points"], [[120, 16, -1, 30], [69, 54, -1, 12],
                                                        [119.8, 15.9, -1, 7], [120.25, 16.72, -1, 13]])
                with self.assertRaises(InvalidPeriod):
                    archive.period(start, end, 0)
            finally:
                archive.connection.close()
