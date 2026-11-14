"""Serve one UTC day of FIRMS observations from the local Parquet archive."""

import gzip
import json
import math
import os
import struct
from collections import OrderedDict
from datetime import date
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, HTTPServer
from io import BytesIO
from pathlib import Path
from urllib.parse import urlsplit

import duckdb


PLATFORMS = ("Aqua", "Terra", "Suomi NPP", "NOAA-20", "NOAA-21")
PLATFORM_INDEX = {name: index for index, name in enumerate(PLATFORMS)}
PLATFORM_INDEX["Suomi-NPP"] = PLATFORM_INDEX["Suomi NPP"]
POINT = {0: struct.Struct(">Idd"), 1: struct.Struct("<Idd")}


def archive_range(root):
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
    }


def pack_points(rows):
    for geometry, satellite in rows:
        if not geometry or len(geometry) != 21 or geometry[0] not in POINT:
            continue
        kind, lon, lat = POINT[geometry[0]].unpack_from(geometry, 1)
        if kind == 1 and math.isfinite(lon) and math.isfinite(lat) and abs(lon) <= 180 and abs(lat) <= 90:
            yield [round(lon, 5), round(lat, 5), PLATFORM_INDEX.get(satellite, -1)]


class FireArchive:
    def __init__(self, root):
        self.root = root
        self.connection = duckdb.connect(config={"threads": 1, "memory_limit": "192MB"})
        self.cache = OrderedDict()

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
            """SELECT ST_AsWKB(geometry), satellite
               FROM read_parquet(?, hive_partitioning=false)
               WHERE acq_date = ? AND (type = 0 OR type IS NULL)
                 AND coalesce(lower(confidence), '') NOT IN ('l', 'low')
                 AND coalesce(confidence_pct, 100) >= 30""",
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


class Handler(BaseHTTPRequestHandler):
    def respond(self, status, body, compressed=False):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "public, max-age=60" if status == HTTPStatus.OK else "no-store")
        self.send_header("Vary", "Accept-Encoding")
        if compressed and "gzip" in self.headers.get("Accept-Encoding", ""):
            self.send_header("Content-Encoding", "gzip")
        elif compressed:
            body = gzip.decompress(body)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlsplit(self.path).path
        try:
            if path == "/api/fires/range":
                self.respond(HTTPStatus.OK, json.dumps(archive_range(self.server.archive.root)).encode())
                return
            if path.startswith("/api/fires/"):
                encoded = path.removeprefix("/api/fires/")
                try:
                    day = date.fromisoformat(encoded)
                    if encoded != day.isoformat():
                        raise ValueError("Expected YYYY-MM-DD")
                except ValueError:
                    self.respond(HTTPStatus.BAD_REQUEST, b'{"error":"expected YYYY-MM-DD"}')
                    return
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
    server = HTTPServer(("0.0.0.0", 8081), Handler)
    server.archive = FireArchive(Path(os.environ.get("FIRMS_DATA_DIR", "/data")))
    server.serve_forever()
