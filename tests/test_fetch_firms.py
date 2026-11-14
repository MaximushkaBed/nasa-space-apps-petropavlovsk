import argparse
from contextlib import redirect_stderr, redirect_stdout
import csv
from datetime import date
import io
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

from scripts import fetch_firms as firms


HEADER = "latitude,longitude,acq_date,acq_time,satellite\n"
OBSERVATION = "54.9,69.2,2024-07-01,1045,Terra\n"


class FetchFirmsTests(unittest.TestCase):
    def test_date_windows_cover_inclusive_period_without_overlap(self):
        self.assertEqual(
            list(firms.date_windows(date(2024, 7, 1), date(2024, 7, 12))),
            [(date(2024, 7, 1), 5), (date(2024, 7, 6), 5), (date(2024, 7, 11), 2)],
        )
        self.assertEqual(list(firms.date_windows(date.max, date.max)), [(date.max, 1)])

    def test_bbox_rejects_invalid_ranges_and_nonfinite_coordinates(self):
        for value in ("1,2,3", "nan,2,3,4", "1,2,inf,4", "3,2,1,4", "1,4,3,2", "-181,2,3,4"):
            with self.subTest(value=value), self.assertRaises(argparse.ArgumentTypeError):
                firms.parse_bbox(value)
        self.assertEqual(firms.parse_bbox("68,54,71,56"), "68,54,71,56")

    def test_key_can_come_from_env_file_and_environment_takes_precedence(self):
        with tempfile.TemporaryDirectory() as directory:
            env_file = Path(directory) / ".env"
            env_file.write_text('FIRMS_MAP_KEY="file-key" # local only\n')
            with patch.dict(os.environ, {}, clear=True):
                self.assertEqual(firms.read_map_key(env_file), "file-key")
            with patch.dict(os.environ, {"FIRMS_MAP_KEY": "environment-key"}):
                self.assertEqual(firms.read_map_key(env_file), "environment-key")

    def test_missing_key_fails_before_request(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(firms.FirmsError, "Set FIRMS_MAP_KEY"):
                firms.read_map_key(Path(directory) / ".env")

    def test_invalid_key_response_is_not_treated_as_zero_observations(self):
        with patch.object(firms, "urlopen") as request:
            request.return_value.__enter__.return_value.read.return_value = b"Invalid MAP_KEY."
            with self.assertRaisesRegex(firms.FirmsError, "did not return a hotspot CSV"):
                firms.fetch_csv("secret", "MODIS_SP", "68,54,71,56", date(2024, 7, 1), 1)

    def test_header_only_response_is_a_valid_empty_result(self):
        with patch.object(firms, "urlopen") as request:
            request.return_value.__enter__.return_value.read.return_value = HEADER.encode()
            columns, rows = firms.fetch_csv("secret", "MODIS_SP", "68,54,71,56", date(2024, 7, 1), 1)
            self.assertIn("acq_time", columns)
            self.assertEqual(rows, [])

    def test_http_errors_do_not_expose_key_in_url(self):
        error = HTTPError("https://example.test/private-key", 403, "Forbidden", {}, None)
        with patch.object(firms, "urlopen", side_effect=error):
            with self.assertRaises(firms.FirmsError) as raised:
                firms.fetch_csv("private-key", "MODIS_SP", "68,54,71,56", date(2024, 7, 1), 1)
        self.assertIn("HTTP 403", str(raised.exception))
        self.assertNotIn("private-key", str(raised.exception))

    def test_cli_downloads_each_source_in_five_day_chunks(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(firms, "urlopen") as request:
            request.return_value.__enter__.return_value.read.return_value = (HEADER + OBSERVATION).encode()
            with patch.dict(os.environ, {"FIRMS_MAP_KEY": "test-key"}), redirect_stdout(io.StringIO()):
                result = firms.main([
                    "--bbox", "68,54,71,56", "--start", "2024-07-01", "--end", "2024-07-07",
                    "--output-dir", directory,
                ])
            self.assertEqual(result, 0)
            self.assertEqual(request.call_count, 4)
            urls = [call.args[0].full_url for call in request.call_args_list]
            self.assertTrue(urls[0].endswith("/MODIS_SP/68,54,71,56/5/2024-07-01"))
            self.assertTrue(urls[1].endswith("/MODIS_SP/68,54,71,56/2/2024-07-06"))
            self.assertIn("/VIIRS_SNPP_SP/", urls[2])
            for source in ("MODIS_SP", "VIIRS_SNPP_SP"):
                path = Path(directory) / f"{source}_2024-07-01_2024-07-07.csv"
                with path.open(newline="") as handle:
                    rows = list(csv.DictReader(handle))
                self.assertEqual(len(rows), 2)
                self.assertEqual(rows[0]["acq_time"], "1045")

    def test_failure_does_not_replace_existing_export_with_partial_data(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "MODIS_SP_2024-07-01_2024-07-07.csv"
            path.write_text("existing completed export\n")
            with patch.dict(os.environ, {"FIRMS_MAP_KEY": "test-key"}), patch.object(
                firms, "fetch_csv", side_effect=[
                    (HEADER.strip().split(","), []), firms.FirmsError("Network failure"),
                ],
            ), redirect_stderr(io.StringIO()):
                result = firms.main([
                    "--bbox", "68,54,71,56", "--start", "2024-07-01", "--end", "2024-07-07",
                    "--sources", "MODIS_SP", "--output-dir", directory,
                ])
            self.assertEqual(result, 1)
            self.assertEqual(path.read_text(), "existing completed export\n")


if __name__ == "__main__":
    unittest.main()
