"""Bounded polygon intersection, independent of FIRMS archives and analysis jobs."""
import json

from api.geometry import normalize_geometry

VERSION = 1
MAX_INTERSECTION_WORK = 8_000_000


def _vertices(geometry):
    polygons = [geometry['coordinates']] if geometry['type'] == 'Polygon' else geometry['coordinates']
    return sum(len(ring) for polygon in polygons for ring in polygon)


def _canonical_dateline(geometry):
    polygons = [geometry['coordinates']] if geometry['type'] == 'Polygon' else geometry['coordinates']
    if any(abs(a[0] - b[0]) > 180 for polygon in polygons for ring in polygon for a, b in zip(ring, ring[1:])):
        raise ValueError('Границу через меридиан ±180° нужно передать частями MultiPolygon. Неразделённое кольцо неоднозначно; пересечение не выполнено.')


def clip_geometry(parent, geometry, connection):
    """Return the exact polygonal intersection in the existing WGS84 convention.

    Rings crossing the date line must be split at ±180° as Polygon/MultiPolygon,
    just like the existing circle normalizer and published boundary catalogue.
    Holes are handled by GEOS; no bounding-box replacement or simplification is
    used. An unchanged child retains its original normalized coordinate ordering.
    """
    parent, _ = normalize_geometry(parent, connection)
    geometry, bbox = normalize_geometry(geometry, connection)
    _canonical_dateline(parent)
    _canonical_dateline(geometry)
    if _vertices(parent) * _vertices(geometry) > MAX_INTERSECTION_WORK:
        raise ValueError('Слишком сложное пересечение границ. Выберите меньшую часть или используйте меньше вершин.')
    con = connection(memory='96MB')
    try:
        covered, output, empty = con.execute("""
            WITH inputs AS (
                SELECT ST_GeomFromGeoJSON(?) AS parent, ST_GeomFromGeoJSON(?) AS child
            ), intersection AS (
                SELECT ST_CoveredBy(child, parent) AS covered,
                       ST_CollectionExtract(ST_Intersection(parent, child), 3) AS clipped
                FROM inputs
            )
            SELECT covered, ST_AsGeoJSON(clipped), ST_IsEmpty(clipped) FROM intersection
        """, [json.dumps(parent), json.dumps(geometry)]).fetchone()
    finally:
        con.close()
    if empty:
        raise ValueError('Выделенная часть находится вне выбранной территории или только касается её границы. Выделите область внутри.')
    if covered:
        return dict(version=VERSION, geometry=geometry, bbox=bbox, clipped=False)
    clipped = json.loads(output)
    if clipped.get('type') not in ('Polygon', 'MultiPolygon'):
        raise ValueError('Пересечение не образует область. Выделите часть внутри выбранной территории.')
    clipped, bbox = normalize_geometry(clipped, connection)
    return dict(version=VERSION, geometry=clipped, bbox=bbox, clipped=True)
