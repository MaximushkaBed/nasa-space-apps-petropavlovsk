"""Find an Overture locality polygon matching a geocoded city."""

from functools import lru_cache
import json
import math
from pathlib import Path
import re
from threading import BoundedSemaphore


PARTS = json.loads(Path(__file__).with_name('place_boundary_parts.json').read_text(encoding='utf-8'))['parts']
LOOKUP_LIMIT = BoundedSemaphore(2)


class BoundaryUnavailable(RuntimeError):
    pass


def export_shape(con, wkb):
    for tolerance in (0, .00002, .0001, .0005, .002):
        result = con.execute("""
            WITH original AS (SELECT ST_GeomFromWKB(?) AS geom),
            simplified AS (SELECT CASE WHEN ? = 0 THEN geom
                ELSE ST_SimplifyPreserveTopology(geom, ?) END AS geom FROM original)
            SELECT ST_AsGeoJSON(geom) FROM simplified
            WHERE ST_NPoints(geom) <= 18000 AND ST_IsValid(geom) AND NOT ST_IsEmpty(geom)
            """, [wkb, tolerance, tolerance]).fetchone()
        if result:
            geometry = json.loads(result[0])
            if geometry['type'] in ('Polygon', 'MultiPolygon') and len(result[0]) < 350_000:
                return geometry
    raise BoundaryUnavailable('The available boundary could not be exported as a valid polygon.')


def find_boundary(args, connection):
    country = args.get('country', [''])[0].upper()
    name = ' '.join(args.get('name', [''])[0].split())
    language = args.get('lang', ['en'])[0]
    lon = float(args.get('lon', ['nan'])[0])
    lat = float(args.get('lat', ['nan'])[0])
    if (not re.fullmatch('[A-Z]{2}', country) or len(name) > 160 or not any(map(str.isalnum, name))
            or not all(map(math.isfinite, (lat, lon))) or not -85 < lat < 85 or not -180 <= lon <= 180):
        raise ValueError('Укажите название, страну и координаты города.')
    return lookup(country, name, language if language in ('ru', 'en', 'kk') else 'en',
                  round(lon, 6), round(lat, 6), connection)


@lru_cache(maxsize=128)
def lookup(country, name, language, lon, lat, connection):
    if not LOOKUP_LIMIT.acquire(blocking=False):
        raise BoundaryUnavailable('City boundary lookup is busy.')
    try:
        paths = [url for (west, south, east, north), url in PARTS
                 if west <= lon <= east and south <= lat <= north]
        if not paths:
            return None
        with connection(memory='192MB') as con:
            con.execute("LOAD httpfs; SET enable_http_metadata_cache=true; SET http_timeout=7; SET http_retries=1")
            row = con.execute("""
                SELECT ST_AsWKB(geometry) FROM read_parquet(?)
                WHERE country=? AND subtype='locality' AND is_land
                  AND bbox.xmin<=? AND bbox.xmax>=? AND bbox.ymin<=? AND bbox.ymax>=?
                  AND (names.primary=? OR map_extract_value(names.common, ?)=?)
                  AND ST_Covers(geometry, ST_Point(?,?))
                ORDER BY is_territorial DESC NULLS LAST, ST_Area(geometry), id LIMIT 1
                """, [paths, country, lon, lon, lat, lat, name, language, name, lon, lat]).fetchone()
            if row:
                return export_shape(con, row[0])
            con.execute(r"""CREATE TEMP MACRO city_name(value) AS
                trim(regexp_replace(lower(strip_accents(value)), '[^\p{L}\p{N}]+', ' ', 'g'))""")
            matching_ids = con.execute("""
                SELECT id FROM read_parquet(?)
                WHERE country=? AND subtype IN ('locality','localadmin') AND is_land
                  AND bbox.xmin<=? AND bbox.xmax>=? AND bbox.ymin<=? AND bbox.ymax>=?
                  AND list_contains(list_transform(list_concat([names.primary], map_values(names.common),
                        list_transform(names.rules, lambda entry: entry.value)), lambda name: city_name(name)), city_name(?))
                """, [paths, country, lon, lon, lat, lat, name]).fetchall()
            if not matching_ids:
                return None
            row = con.execute("""
                SELECT ST_AsWKB(geometry) FROM read_parquet(?)
                WHERE id IN (SELECT unnest(?))
                  AND bbox.xmin<=? AND bbox.xmax>=? AND bbox.ymin<=? AND bbox.ymax>=?
                  AND ST_Covers(geometry, ST_Point(?,?))
                ORDER BY subtype='locality' DESC, is_territorial DESC NULLS LAST, ST_Area(geometry), id LIMIT 1
                """, [paths, [match[0] for match in matching_ids], lon, lon, lat, lat, lon, lat]).fetchone()
            return export_shape(con, row[0]) if row else None
    except BoundaryUnavailable:
        raise
    except Exception as error:
        raise BoundaryUnavailable('Could not read the city boundary catalogue.') from error
    finally:
        LOOKUP_LIMIT.release()
