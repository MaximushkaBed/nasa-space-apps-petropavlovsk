"""Serve FIRMS observations and period maps from the local Parquet archive."""

import gzip
import json
import math
import os
import struct
from collections import OrderedDict, defaultdict
from datetime import date, timedelta
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
from pathlib import Path
from threading import BoundedSemaphore, Event, Lock, Timer
from urllib.parse import parse_qs, urlsplit

import duckdb


PLATFORMS = ("Aqua", "Terra", "Suomi NPP", "NOAA-20", "NOAA-21")
PLATFORM_INDEX = {name: index for index, name in enumerate(PLATFORMS)}
PLATFORM_INDEX["Suomi-NPP"] = PLATFORM_INDEX["Suomi NPP"]
POINT = {0: struct.Struct(">Idd"), 1: struct.Struct("<Idd")}
PERIOD_DETAIL_DAYS = 31
VIEWPORT_LIMIT = 25000
VIEWPORT_WIDTH = 20
VIEWPORT_HEIGHT = 15
VIEWPORT_TIMEOUT = 18
WORLD_CELL_DEGREES = 1
SKO_CELL_DEGREES = 0.08
DETECTION_FILTER = """AND (type = 0 OR type IS NULL)
    AND coalesce(lower(confidence), '') NOT IN ('l', 'low')
    AND coalesce(confidence_pct, 100) >= 30"""
PLATFORM_SQL = "CASE satellite " + " ".join(
    f"WHEN '{name}' THEN {index}" for name, index in PLATFORM_INDEX.items()
) + " ELSE -1 END"


class InvalidPeriod(ValueError):
    """Invalid user-supplied dates, satellite selection or viewport."""


def archive_range(root, catalog=None):
    if catalog is None:
        catalog = json.loads((root / "catalog.json").read_text(encoding="utf-8"))
    archives = [item for item in catalog["assets"] if item["kind"] == "observations" and item["rows"]]
    tail = catalog.get("live_tail")
    if tail and tail["rows"]:
        archives.append(tail)
    if not archives:
        raise ValueError("No FIRMS observation files in the catalog")
    return {
        "first": min(item["start"][:10] for item in archives),
        "last": max(item["end"][:10] for item in archives),
        "updatedAt": catalog["updated_at"],
        "through": max(item["end"] for item in archives),
        "platforms": PLATFORMS,
        "periodDetailDays": PERIOD_DETAIL_DAYS,
        "viewportMaxWidth": VIEWPORT_WIDTH,
        "viewportMaxHeight": VIEWPORT_HEIGHT,
    }


def pack_points(rows, *, exact=False):
    for geometry, satellite, *details in rows:
        if not geometry or len(geometry) != 21 or geometry[0] not in POINT:
            continue
        kind, lon, lat = POINT[geometry[0]].unpack_from(geometry, 1)
        if kind == 1 and math.isfinite(lon) and math.isfinite(lat) and abs(lon) <= 180 and abs(lat) <= 90:
            x, y = (lon, lat) if exact else (round(lon, 5), round(lat, 5))
            yield [x, y, PLATFORM_INDEX.get(satellite, -1), *details]


def dates_between(start, end):
    return [start + timedelta(days=offset) for offset in range((end - start).days + 1)]


def missing_intervals(dates, available):
    intervals = []
    previous = None
    for day in dates:
        if day in available:
            continue
        if previous and day == previous + timedelta(days=1):
            intervals[-1]["end"] = day.isoformat()
        else:
            intervals.append({"start": day.isoformat(), "end": day.isoformat()})
        previous = day
    return intervals


def parse_date(value):
    day = date.fromisoformat(value)
    if value != day.isoformat():
        raise ValueError("expected YYYY-MM-DD")
    return day


def parse_viewport(value):
    try:
        west, south, east, north = map(float, value.split(","))
    except ValueError as error:
        raise InvalidPeriod("Expected a bbox in west,south,east,north order") from error
    if not all(math.isfinite(degree) for degree in (west, south, east, north)):
        raise InvalidPeriod("Expected finite viewport coordinates")
    if not (-180 <= west <= 180 and -180 <= east <= 180 and -90 <= south < north <= 90):
        raise InvalidPeriod("Viewport is out of bounds")
    width = (east - west) % 360
    if not 0 < width <= VIEWPORT_WIDTH + 1e-9 or north - south > VIEWPORT_HEIGHT + 1e-9:
        raise InvalidPeriod(f"Viewport must be no larger than {VIEWPORT_WIDTH} by {VIEWPORT_HEIGHT} degrees")
    return west, south, east, north


def parse_period_query(query, viewport=False):
    required = {"start", "end"} | ({"bbox"} if viewport else set())
    args = parse_qs(query, keep_blank_values=True, max_num_fields=len(required) + 1)
    if not required <= args.keys() <= required | {"satellite"} or any(len(value) != 1 for value in args.values()):
        fields = ", ".join(sorted(required))
        raise InvalidPeriod(f"Expected single values for {fields} and an optional satellite index")
    platform = args.get("satellite", [""])[0]
    if platform and platform not in {str(index) for index in range(len(PLATFORMS))}:
        raise InvalidPeriod("Invalid satellite index")
    start, end = parse_date(args["start"][0]), parse_date(args["end"][0])
    return start, end, int(platform) if platform else None, parse_viewport(args["bbox"][0]) if viewport else None


def viewport_rectangles(bbox):
    west, south, east, north = bbox
    intervals = [(west, east)] if west <= east else [(west, 180), (-180, east)]
    for left, right in intervals:
        yield struct.pack("<BIII10d", 1, 3, 1, 5, left, south, right, south, right, north, left, north, left, south)


def observation_sources(root, catalog, start, end):
    for item in catalog["assets"]:
        if item["kind"] != "observations" or not item["rows"]:
            continue
        first, last = parse_date(item["start"][:10]), parse_date(item["end"][:10])
        path = root / "observations" / f"year={first.year}" / "detections.parquet"
        if first <= end and start <= last and path.is_file():
            yield path, first, last
    tail = catalog.get("live_tail")
    path = root / "derived/live-tail.parquet"
    if tail and tail["rows"] and path.is_file():
        first, last = parse_date(tail["start"][:10]), parse_date(tail["end"][:10])
        if first <= end and start <= last:
            yield path, first, last


def add_to_grid(cells, lon, lat, platform, weight, regional, degrees):
    key = math.floor(lon / degrees), math.floor(lat / degrees), platform, regional
    cell = cells[key]
    cell[0] += lon * weight
    cell[1] += lat * weight
    cell[2] += weight


def grid_points(cells):
    for (_, _, platform, regional), (lon, lat, weight) in cells.items():
        yield [round(lon / weight, 5), round(lat / weight, 5), platform, weight, regional]


class RegionalBoundary:
    def __init__(self, path):
        geometry = json.loads(path.read_text(encoding="utf-8"))["geometry"]
        self.polygons = [geometry["coordinates"]] if geometry["type"] == "Polygon" else geometry["coordinates"]
        coordinates = [point for polygon in self.polygons for ring in polygon for point in ring]
        lons, lats = zip(*coordinates)
        self.bounds = min(lons), min(lats), max(lons), max(lats)
        self.polygons = [[self.prepare_ring(ring) for ring in polygon] for polygon in self.polygons]

    @staticmethod
    def prepare_ring(ring):
        # Only edges crossing the point's latitude can change its parity.
        buckets = {}
        for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
            if y1 == y2:
                continue
            edge = x1, y1, y2, (x2 - x1) / (y2 - y1)
            for band in range(math.floor(min(y1, y2) * 8), math.floor(max(y1, y2) * 8) + 1):
                buckets.setdefault(band, []).append(edge)
        return buckets

    def contains(self, lon, lat):
        west, south, east, north = self.bounds
        if not (west <= lon <= east and south <= lat <= north):
            return False
        band = math.floor(lat * 8)

        def in_ring(buckets):
            return sum((y1 > lat) != (y2 > lat) and lon < x1 + slope * (lat - y1)
                       for x1, y1, y2, slope in buckets.get(band, ())) % 2

        return any(in_ring(outer) and not any(in_ring(hole) for hole in holes)
                   for outer, *holes in self.polygons)


class FireArchive:
    def __init__(self, root):
        self.root = root
        self.connection = duckdb.connect(config={"threads": 1, "memory_limit": "192MB"})
        self.cache = OrderedDict()
        self.period_cache = OrderedDict()
        self.viewport_cache = OrderedDict()
        self.standard_lock = Lock()
        self.viewport_lock = Lock()
        self.boundary = RegionalBoundary(Path(__file__).resolve().parents[1] / "web/data/region.geojson")

    def frame(self, day):
        year = self.root / "observations" / f"year={day.year}" / "detections.parquet"
        tail = self.root / "derived" / "live-tail.parquet"
        catalog = archive_range(self.root)
        if not catalog["first"] <= day.isoformat() <= catalog["last"]:
            return None
        paths = [year] if year.is_file() else []
        if day.year == int(catalog["last"][:4]) and tail.is_file():
            paths.append(tail)
        if not paths:
            return None
        key = (day, tuple(path.stat().st_mtime_ns for path in paths))
        if key in self.cache:
            self.cache.move_to_end(key)
            return self.cache[key]

        cursor = self.connection.execute(
            f"""SELECT ST_AsWKB(geometry), satellite
               FROM read_parquet(?, hive_partitioning=false)
               WHERE acq_date = ? {DETECTION_FILTER}""",
            [[str(path) for path in paths], day],
        )
        buffer = BytesIO()
        with gzip.GzipFile(fileobj=buffer, mode="wb", compresslevel=4, mtime=0) as output:
            output.write(f'{{"date":"{day.isoformat()}","points":['.encode())
            first = True
            while rows := cursor.fetchmany(25000):
                points = list(pack_points(rows))
                if points:
                    if not first:
                        output.write(b",")
                    output.write(json.dumps(points, separators=(",", ":")).encode()[1:-1])
                    first = False
            output.write(b"]}")
        body = buffer.getvalue()
        self.cache[key] = body
        if len(self.cache) > 12:
            self.cache.popitem(last=False)
        return body

    def viewport(self, start, end, bbox, platform=None):
        catalog_path = self.root / "catalog.json"
        catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
        limits = archive_range(self.root, catalog)
        if start > end or not limits["first"] <= start.isoformat() <= end.isoformat() <= limits["last"]:
            raise InvalidPeriod("Period is outside the FIRMS archive")
        dates = dates_between(start, end)
        filtered = len(dates) <= PERIOD_DETAIL_DAYS
        if not filtered and platform is not None:
            raise InvalidPeriod(f"Satellite filtering is available for at most {PERIOD_DETAIL_DAYS} days")
        sources = list(observation_sources(self.root, catalog, start, end))
        if not sources:
            return None
        available = {day for day in dates if any(first <= day <= last for _, first, last in sources)}
        response = {
            "start": start.isoformat(), "end": end.isoformat(), "bbox": bbox,
            "method": "filtered" if filtered else "archive", "limit": VIEWPORT_LIMIT,
            "coveredStart": min(available).isoformat(), "coveredEnd": max(available).isoformat(),
            "missing": missing_intervals(dates, available), "points": [],
        }

        def compress():
            return gzip.compress(json.dumps(response, separators=(",", ":")).encode(), compresslevel=4, mtime=0)

        key = (start, end, bbox, platform, tuple((path, path.stat().st_mtime_ns) for path, _, _ in sources))
        if not self.viewport_lock.acquire(blocking=False):
            response.update(status="too_slow", reason="busy")
            return compress()
        try:
            if key in self.viewport_cache:
                self.viewport_cache.move_to_end(key)
                return self.viewport_cache[key]
            rectangles = list(viewport_rectangles(bbox))
            extent = " OR ".join("ST_Intersects_Extent(geometry, ST_GeomFromWKB(?))" for _ in rectangles)
            matching_names = [name for name, index in PLATFORM_INDEX.items() if index == platform]
            satellite = "AND satellite IN (SELECT unnest(?::VARCHAR[]))" if platform is not None else ""
            quality = DETECTION_FILTER if filtered else ""
            params = [[str(path) for path, _, _ in sources], start, end, *rectangles]
            if platform is not None:
                params.append(matching_names)
            with duckdb.connect(config={"threads": 1, "memory_limit": "64MB",
                                        "max_temp_directory_size": "0MB", "preserve_insertion_order": False}) as con:
                expired = Event()

                def interrupt():
                    expired.set()
                    con.interrupt()

                timer = Timer(VIEWPORT_TIMEOUT, interrupt)
                timer.start()
                try:
                    rows = con.execute(f"""WITH observations AS (
                        SELECT * FROM read_parquet(?, hive_partitioning=false, union_by_name=true)
                        UNION ALL BY NAME SELECT NULL::TIMESTAMP AS acq_datetime WHERE false
                    )
                    SELECT ST_AsWKB(geometry), satellite, 1,
                           coalesce(strftime(acq_datetime, '%Y-%m-%dT%H:%M:%SZ'), acq_date::VARCHAR)
                    FROM observations
                    WHERE acq_date BETWEEN ? AND ? AND ({extent}) {quality} {satellite}
                    LIMIT {VIEWPORT_LIMIT + 1}""", params).fetchall()
                except duckdb.InterruptException:
                    if not expired.is_set():
                        raise
                    response.update(status="too_slow", reason="deadline")
                    return compress()
                finally:
                    timer.cancel()
                    timer.join()
            if len(rows) > VIEWPORT_LIMIT:
                response["status"] = "too_dense"
            else:
                response.update(status="ok", points=list(pack_points(rows, exact=True)))
            body = compress()
            self.viewport_cache[key] = body
            if len(self.viewport_cache) > 16:
                self.viewport_cache.popitem(last=False)
            return body
        finally:
            self.viewport_lock.release()

    def observation_bins(self, paths, start, end, platform, filtered):
        if not paths:
            return []
        quality = DETECTION_FILTER if filtered else ""
        platform_column = PLATFORM_SQL if filtered else "-1"
        west, south, east, north = self.boundary.bounds
        rows = self.connection.execute(f"""
            WITH coordinates AS (
                SELECT TRY_CAST((ST_AsGeoJSON(geometry)::JSON -> 'coordinates') AS DOUBLE[2]) AS point,
                       {platform_column} AS platform
                FROM read_parquet(?, hive_partitioning=false)
                WHERE acq_date BETWEEN ? AND ? {quality}
            ), valid AS (
                SELECT round(point[1], 5) AS lon, round(point[2], 5) AS lat, platform,
                       lon BETWEEN {west} AND {east} AND lat BETWEEN {south} AND {north} AS near_sko
                FROM coordinates
                WHERE point[1] BETWEEN -180 AND 180 AND point[2] BETWEEN -90 AND 90
                  AND (CAST(? AS INTEGER) IS NULL OR platform = ?)
            ), cells AS (
                SELECT lon, lat, platform, near_sko,
                       CASE WHEN near_sko THEN lon ELSE floor(lon / {WORLD_CELL_DEGREES}) END AS x,
                       CASE WHEN near_sko THEN lat ELSE floor(lat / {WORLD_CELL_DEGREES}) END AS y
                FROM valid
            )
            SELECT round(avg(lon), 5), round(avg(lat), 5), platform, count(*), near_sko
            FROM cells
            GROUP BY platform, near_sko, x, y
        """, [[str(path) for path in paths], start, end, platform, platform]).fetchall()
        regional_bins = defaultdict(lambda: [0, 0, 0])
        points = []
        for lon, lat, platform, weight, near_sko in rows:
            if not near_sko:
                points.append([lon, lat, platform, weight, False])
                continue
            regional = self.boundary.contains(lon, lat)
            add_to_grid(regional_bins, lon, lat, platform, weight, regional, SKO_CELL_DEGREES)
        points.extend(grid_points(regional_bins))
        return points

    def publisher_bins(self, dates, tail):
        covered = set()
        points = defaultdict(lambda: [0, 0, 0])
        dates_by_year = defaultdict(list)
        for day in dates:
            dates_by_year[day.year].append(day)
        # The whole-archive snapshot can lag the annual files. Select daily
        # counts from each annual file and append the anti-joined live tail.
        for year, year_dates in dates_by_year.items():
            directory = self.root / "aggregate" / f"year={year}"
            candidates = (directory / f"aggregate-r{resolution}.parquet" for resolution in (5, 8))
            path = next((candidate for candidate in candidates if candidate.is_file()), None)
            if path is None:
                continue
            columns = {name for name, in self.connection.execute(
                "SELECT name FROM parquet_schema(?) WHERE regexp_full_match(name, 'count_[0-9]{8}')", [str(path)]).fetchall()}
            supported = {day: f"count_{day:%Y%m%d}" for day in year_dates if f"count_{day:%Y%m%d}" in columns}
            covered.update(supported)
            if not supported:
                continue
            amount = "count" if set(supported.values()) == columns else " + ".join(f"coalesce({col}, 0)" for col in supported.values())
            rows = self.connection.execute(f"""
                SELECT (bbox.xmin + bbox.xmax) / 2, (bbox.ymin + bbox.ymax) / 2, {amount} AS weight
                FROM read_parquet(?, hive_partitioning=false) WHERE weight > 0
            """, [str(path)])
            while chunk := rows.fetchmany(10000):
                for lon, lat, count in chunk:
                    lon = (lon + 180) % 360 - 180
                    regional = self.boundary.contains(lon, lat)
                    add_to_grid(points, lon, lat, -1, count, regional, WORLD_CELL_DEGREES)
        if tail is not None:
            path, tail_start, tail_end = tail
            # An overlapping tail cannot fill gaps in the underlying snapshot.
            base_day = max(covered, default=dates[0] - timedelta(days=1))
            covered.update(day for day in dates if max(base_day + timedelta(days=1), tail_start) <= day <= tail_end)
            for lon, lat, platform, weight, regional in self.observation_bins([path], dates[0], dates[-1], None, filtered=False):
                add_to_grid(points, lon, lat, platform, weight, regional, WORLD_CELL_DEGREES)
        return list(grid_points(points)), covered

    def period(self, start, end, platform=None):
        catalog_path = self.root / "catalog.json"
        catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
        limits = archive_range(self.root, catalog)
        if start > end or not limits["first"] <= start.isoformat() <= end.isoformat() <= limits["last"]:
            raise InvalidPeriod("Period is outside the FIRMS archive")
        dates = dates_between(start, end)
        filtered = len(dates) <= PERIOD_DETAIL_DAYS
        if not filtered and platform is not None:
            raise InvalidPeriod(f"Satellite filtering is available for at most {PERIOD_DETAIL_DAYS} days")
        key = (start, end, platform, catalog_path.stat().st_mtime_ns)
        if key in self.period_cache:
            self.period_cache.move_to_end(key)
            return self.period_cache[key]

        tail = None
        tail_path = self.root / "derived/live-tail.parquet"
        if (item := catalog.get("live_tail")) and item["rows"] and tail_path.is_file():
            tail_start = parse_date(item["start"][:10])
            tail_end = parse_date(item["end"][:10])
            if start <= tail_end and tail_start <= end:
                tail = (tail_path, tail_start, tail_end)

        if filtered:
            sources = list(observation_sources(self.root, catalog, start, end))
            paths = [path for path, _, _ in sources]
            available = {day for day in dates if any(first <= day <= last for _, first, last in sources)}
            rows = self.observation_bins(paths, start, end, platform, filtered=True)
        else:
            rows, available = self.publisher_bins(dates, tail)
        if not available:
            return None

        regional_by_platform = defaultdict(int)
        for _, _, platform, weight, regional in rows:
            if regional:
                regional_by_platform[platform] += weight
        body = gzip.compress(json.dumps({
            "start": start.isoformat(), "end": end.isoformat(),
            "coveredStart": min(available).isoformat(), "coveredEnd": max(available).isoformat(),
            "missing": missing_intervals(dates, available),
            "method": "filtered" if filtered else "publisher", "approximate": True,
            "cellDegrees": WORLD_CELL_DEGREES, "regionalCellDegrees": SKO_CELL_DEGREES if filtered else None,
            "regionalExact": filtered, "regionalCount": sum(regional_by_platform.values()),
            "regionalByPlatform": regional_by_platform,
            "total": sum(row[3] for row in rows), "points": [row[:4] for row in rows],
        }, separators=(",", ":")).encode(), compresslevel=4, mtime=0)
        self.period_cache[key] = body
        if len(self.period_cache) > 8:
            self.period_cache.popitem(last=False)
        return body


class FiresHTTPServer(ThreadingHTTPServer):
    # A viewport request may scan the archive while normal map requests continue.
    # Bound simultaneous HTTP workers independently of the two query locks.
    slots = BoundedSemaphore(8)

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            try:
                request.setblocking(False)
                request.send(b"HTTP/1.0 503 Service Unavailable\r\nConnection: close\r\n"
                             b"Retry-After: 1\r\nContent-Length: 0\r\n\r\n")
            except OSError:
                pass
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()


class Handler(BaseHTTPRequestHandler):
    timeout = 20

    def respond(self, status, body, compressed=False, cache=True):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "public, max-age=60" if cache and status == HTTPStatus.OK else "no-store")
        self.send_header("Vary", "Accept-Encoding")
        if compressed and "gzip" in self.headers.get("Accept-Encoding", ""):
            self.send_header("Content-Encoding", "gzip")
        elif compressed:
            body = gzip.decompress(body)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urlsplit(self.path)
        path = url.path
        try:
            if path == "/api/fires/range":
                self.respond(HTTPStatus.OK, json.dumps(archive_range(self.server.archive.root)).encode())
                return
            if path in ("/api/fires/period", "/api/fires/viewport"):
                viewport = path.endswith("/viewport")
                try:
                    start, end, platform, bounds = parse_period_query(url.query, viewport)
                except ValueError as error:
                    self.respond(HTTPStatus.BAD_REQUEST, json.dumps({"error": str(error)}).encode())
                    return
                try:
                    if viewport:
                        frame = self.server.archive.viewport(start, end, bounds, platform)
                    else:
                        with self.server.archive.standard_lock:
                            frame = self.server.archive.period(start, end, platform)
                except InvalidPeriod as error:
                    self.respond(HTTPStatus.BAD_REQUEST, json.dumps({"error": str(error)}).encode())
                    return
                if frame is not None:
                    self.respond(HTTPStatus.OK, frame, compressed=True, cache=not viewport)
                else:
                    self.respond(HTTPStatus.NOT_FOUND, b'{"error":"archive period unavailable"}')
                return
            if path.startswith("/api/fires/"):
                encoded = path.removeprefix("/api/fires/")
                try:
                    day = parse_date(encoded)
                except ValueError:
                    self.respond(HTTPStatus.BAD_REQUEST, b'{"error":"expected YYYY-MM-DD"}')
                    return
                with self.server.archive.standard_lock:
                    frame = self.server.archive.frame(day)
                if frame is not None:
                    self.respond(HTTPStatus.OK, frame, compressed=True)
                    return
        except (BrokenPipeError, ConnectionResetError):
            return
        except (OSError, ValueError, KeyError, duckdb.Error) as error:
            self.log_error("%s", error)
            self.respond(HTTPStatus.SERVICE_UNAVAILABLE, b'{"error":"FIRMS archive unavailable"}')
            return
        self.respond(HTTPStatus.NOT_FOUND, b'{"error":"archive date unavailable"}')


if __name__ == "__main__":
    server = FiresHTTPServer(("0.0.0.0", 8081), Handler)
    server.archive = FireArchive(Path(os.environ.get("FIRMS_DATA_DIR", "/data")))
    server.serve_forever()
