import gzip
import json
import struct
import tempfile
import unittest
from datetime import date
from pathlib import Path

import duckdb

from scripts.serve_global_fires import FireArchive, archive_range


class GlobalFireTests(unittest.TestCase):
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
                    "kind": "observations", "rows": 4,
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
            finally:
                archive.connection.close()
