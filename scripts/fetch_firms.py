#!/usr/bin/env python3
"""Download NASA FIRMS hotspot CSVs without third-party dependencies."""

import argparse
import csv
from datetime import date, timedelta
import io
import json
import math
import os
from pathlib import Path
import shlex
import sys
import tempfile
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen


PROJECT_ROOT = Path(__file__).resolve().parents[1]
API_URL = "https://firms.modaps.eosdis.nasa.gov/api/area/csv"
SOURCES = (
    "MODIS_SP", "MODIS_NRT",
    "VIIRS_SNPP_SP", "VIIRS_SNPP_NRT",
    "VIIRS_NOAA20_SP", "VIIRS_NOAA20_NRT",
    "VIIRS_NOAA21_SP", "VIIRS_NOAA21_NRT",
)
REGIONS = {"sko": PROJECT_ROOT / "data/boundaries/north-kazakhstan.geojson"}


class FirmsError(Exception):
    """A download or configuration error safe to show without the API key."""


def parse_bbox(value):
    try:
        coordinates = [float(part) for part in value.split(",")]
        west, south, east, north = coordinates
    except ValueError:
        raise argparse.ArgumentTypeError("Use west,south,east,north.") from None
    if not (
        all(math.isfinite(number) for number in coordinates)
        and -180 <= west < east <= 180
        and -90 <= south < north <= 90
    ):
        raise argparse.ArgumentTypeError(
            "Coordinates must satisfy -180 <= west < east <= 180 "
            "and -90 <= south < north <= 90."
        )
    return ",".join(format(number, ".15g") for number in coordinates)


def parse_date(value):
    try:
        return date.fromisoformat(value)
    except ValueError:
        raise argparse.ArgumentTypeError("Use a valid date: YYYY-MM-DD.") from None


def load_region(name):
    try:
        feature = json.loads(REGIONS[name].read_text(encoding="utf-8"))
        geometry = feature["geometry"]
        geometry_polygons(geometry)
        return geometry
    except (KeyError, TypeError, json.JSONDecodeError):
        raise FirmsError(f"Invalid boundary file for region {name}.") from None


def geometry_polygons(geometry):
    if geometry["type"] == "Polygon":
        return [geometry["coordinates"]]
    if geometry["type"] == "MultiPolygon":
        return geometry["coordinates"]
    raise FirmsError("Region geometry must be a Polygon or MultiPolygon.")


def geometry_bbox(geometry):
    points = [
        point for polygon in geometry_polygons(geometry)
        for ring in polygon for point in ring
    ]
    return parse_bbox(
        f"{min(point[0] for point in points)},{min(point[1] for point in points)},"
        f"{max(point[0] for point in points)},{max(point[1] for point in points)}"
    )


def ring_location(longitude, latitude, ring):
    """Return 0 outside, 1 inside, or 2 on the boundary of a closed ring."""
    inside = False
    for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
        cross = (longitude - x1) * (y2 - y1) - (latitude - y1) * (x2 - x1)
        if (
            math.isclose(cross, 0.0, abs_tol=1e-10)
            and min(x1, x2) <= longitude <= max(x1, x2)
            and min(y1, y2) <= latitude <= max(y1, y2)
        ):
            return 2
        if (y1 > latitude) != (y2 > latitude):
            intersection = x1 + (latitude - y1) * (x2 - x1) / (y2 - y1)
            if longitude < intersection:
                inside = not inside
    return int(inside)


def contains_point(geometry, longitude, latitude):
    """Include polygon boundaries, exclude hole interiors, and support islands."""
    for polygon in geometry_polygons(geometry):
        outer = ring_location(longitude, latitude, polygon[0])
        if outer == 0:
            continue
        if outer == 2:
            return True
        holes = [ring_location(longitude, latitude, ring) for ring in polygon[1:]]
        if 2 in holes or 1 not in holes:
            return True
    return False


def filter_region(rows, geometry):
    result = []
    for row in rows:
        try:
            longitude, latitude = float(row["longitude"]), float(row["latitude"])
        except (ValueError, TypeError):
            raise FirmsError("FIRMS returned invalid observation coordinates.") from None
        if not (math.isfinite(longitude) and math.isfinite(latitude)):
            raise FirmsError("FIRMS returned invalid observation coordinates.")
        if contains_point(geometry, longitude, latitude):
            result.append(row)
    return result


def read_map_key(env_file):
    value = os.environ.get("FIRMS_MAP_KEY")
    if value is None and env_file.is_file():
        for line in env_file.read_text(encoding="utf-8-sig").splitlines():
            name, separator, raw_value = line.partition("=")
            if separator and name.strip() == "FIRMS_MAP_KEY":
                try:
                    parts = shlex.split(raw_value, comments=True)
                except ValueError:
                    raise FirmsError("Invalid FIRMS_MAP_KEY entry in .env.") from None
                value = parts[0] if len(parts) == 1 else ""
                break
    if not value or not value.strip():
        raise FirmsError(
            "Set FIRMS_MAP_KEY in the environment or the project's .env file. "
            "Get a free key at https://firms.modaps.eosdis.nasa.gov/api/map_key/"
        )
    return value.strip()


def date_windows(start, end):
    """Yield inclusive, non-overlapping windows within FIRMS' five-day limit."""
    current = start
    while current <= end:
        days = min(5, (end - current).days + 1)
        yield current, days
        if (end - current).days < days:
            break
        current += timedelta(days=days)


def fetch_csv(map_key, source, bbox, start, days):
    url = (
        f"{API_URL}/{quote(map_key, safe='')}/{source}/{bbox}"
        f"/{days}/{start.isoformat()}"
    )
    request = Request(url, headers={"User-Agent": "NASA-Space-Apps-Petropavlovsk/0.1"})
    try:
        with urlopen(request, timeout=60) as response:
            payload = response.read().decode("utf-8-sig")
    except HTTPError as error:
        raise FirmsError(
            f"FIRMS returned HTTP {error.code} for {source}, {start}. "
            "Check your MAP_KEY, data availability, and API quota."
        ) from None
    except (URLError, TimeoutError, ConnectionError):
        raise FirmsError("Cannot reach FIRMS. Check the network and retry.") from None
    except UnicodeDecodeError:
        raise FirmsError("FIRMS returned a response that is not UTF-8 CSV.") from None

    try:
        reader = csv.DictReader(io.StringIO(payload), strict=True)
        columns = reader.fieldnames or []
        if not {"latitude", "longitude", "acq_date", "acq_time"}.issubset(columns):
            raise FirmsError(
                "FIRMS did not return a hotspot CSV. "
                "Check your MAP_KEY and the selected source/date availability."
            )
        rows = list(reader)
        if len(set(columns)) != len(columns) or any(
            None in row or None in row.values() for row in rows
        ):
            raise FirmsError("FIRMS returned a malformed hotspot CSV.")
        return columns, rows
    except csv.Error:
        raise FirmsError("FIRMS returned a malformed hotspot CSV.") from None


def write_csv(path, columns, rows):
    """Replace a completed export atomically; never leave a partial CSV."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", newline="", dir=path.parent,
            suffix=".csv", delete=False,
        ) as handle:
            temporary = Path(handle.name)
            writer = csv.DictWriter(handle, fieldnames=columns)
            writer.writeheader()
            writer.writerows(rows)
        temporary.replace(path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    area = parser.add_mutually_exclusive_group(required=True)
    area.add_argument("--bbox", type=parse_bbox, help="west,south,east,north")
    area.add_argument("--region", choices=REGIONS, help="Administrative boundary: sko = North Kazakhstan")
    parser.add_argument("--start", required=True, type=parse_date, help="First date, inclusive")
    parser.add_argument("--end", required=True, type=parse_date, help="Last date, inclusive")
    parser.add_argument(
        "--sources", nargs="+", choices=SOURCES, default=["MODIS_SP", "VIIRS_SNPP_SP"],
    )
    parser.add_argument("--output-dir", type=Path)
    args = parser.parse_args(argv)
    if args.start > args.end:
        parser.error("--start must be on or before --end.")

    try:
        map_key = read_map_key(PROJECT_ROOT / ".env")
        geometry = load_region(args.region) if args.region else None
        bbox = geometry_bbox(geometry) if geometry else args.bbox
        output_dir = args.output_dir or PROJECT_ROOT / "data/raw/firms"
        if args.region and args.output_dir is None:
            output_dir /= args.region
        for source in dict.fromkeys(args.sources):
            columns = None
            observations = []
            for start, days in date_windows(args.start, args.end):
                header, rows = fetch_csv(map_key, source, bbox, start, days)
                if columns is not None and header != columns:
                    raise FirmsError(f"CSV columns changed between requests for {source}.")
                columns = header
                observations.extend(rows)
            downloaded_count = len(observations)
            if geometry:
                observations = filter_region(observations, geometry)
            path = output_dir / f"{source}_{args.start}_{args.end}.csv"
            write_csv(path, columns, observations)
            print(f"{source}: {len(observations)} observations saved to {path}")
            if geometry:
                print(f"  Excluded {downloaded_count - len(observations)} observations outside {args.region}.")
    except (FirmsError, OSError) as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
