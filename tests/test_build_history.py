import csv
from datetime import date
from pathlib import Path
import tempfile
import unittest

from scripts import build_history as history
from scripts import fetch_firms as firms


class HistoryTests(unittest.TestCase):
    def test_plan_prefers_sp_and_appends_nrt_without_overlapping_dates(self):
        available = {"MODIS_SP": {"min_date": "2000-11-01", "max_date": "2026-08-31"},
                     "MODIS_NRT": {"min_date": "2026-08-01", "max_date": "2026-11-14"}}
        jobs = history.plan(available, {}, date(2026, 8, 29), date(2026, 9, 4))
        self.assertEqual([(job["source"], job["start"], job["end"]) for job in jobs],
                         [("MODIS_SP", "2026-08-29", "2026-08-31"),
                          ("MODIS_NRT", "2026-09-01", "2026-09-04")])

    def test_plan_uses_bulk_archives_and_clips_to_launch_and_stop_dates(self):
        available = {"VIIRS_SNPP_SP": {"min_date": "2012-01-20", "max_date": "2012-12-31"},
                     "VIIRS_SNPP_NRT": {"min_date": "2013-01-01", "max_date": "2013-01-02"}}
        catalog = history.annual_catalog("viirs-snpp_2012_Kazakhstan.csv,100,2025-01-01\n")
        jobs = history.plan(available, catalog, date(2000, 1, 1), date(2014, 1, 1))
        self.assertEqual(jobs[0]["method"], "annual_country_csv")
        self.assertEqual(jobs[0]["start"], "2012-01-20")
        self.assertEqual(jobs[-1]["end"], "2013-01-02")

    def test_rows_are_filtered_by_date_and_actual_polygon(self):
        geometry = {"type": "Polygon", "coordinates": [[[0, 0], [4, 0], [0, 4], [0, 0]]]}
        rows = [{"longitude": "1", "latitude": "1", "acq_date": "2024-07-01"},
                {"longitude": "3", "latitude": "3", "acq_date": "2024-07-01"},
                {"longitude": "1", "latitude": "1", "acq_date": "2023-07-01"}]
        self.assertEqual(history.select_rows(rows, "0,0,4,4", geometry, date(2024, 7, 1), date(2024, 7, 2)), rows[:1])

    def test_summary_preserves_zero_queries_partial_months_and_source_versions(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "chunk.csv"
            columns = ["latitude", "longitude", "acq_date", "acq_time", "satellite", "version", "type"]
            firms.write_csv(path, columns, [{"latitude": "54.8", "longitude": "69.1", "acq_date": "2024-07-01",
                                            "acq_time": "1045", "satellite": "Terra", "version": "6.2", "type": "0"}])
            results = [{"job": {"source": "MODIS_SP", "start": "2024-07-01", "end": "2024-07-02"},
                        "file": str(path), "columns": columns}]
            result = history.summarize(results, {}, date(2024, 7, 1), date(2024, 7, 2), root / "output")
            month = result["months"][0]
            self.assertEqual(month["detections"], 1)
            self.assertEqual(month["query_days"], 2)
            self.assertTrue(month["partial_month"])
            self.assertEqual(result["versions"]["MODIS_SP"], {"6.2": 1})
            self.assertEqual(result["totals_by_platform"], {"Terra": 1})
            with (root / "output/observations.csv").open() as handle:
                self.assertEqual(next(csv.DictReader(handle))["processing"], "SP")


if __name__ == "__main__":
    unittest.main()
