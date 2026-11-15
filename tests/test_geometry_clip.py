import json
import unittest

from api import server
from api.geometry_clip import clip_geometry


def rectangle(w, s, e, n):
    return dict(type='Polygon', coordinates=[[[w, s], [e, s], [e, n], [w, n], [w, s]]])


class GeometryClipTests(unittest.TestCase):
    def test_hole_is_preserved_and_an_unchanged_child_retains_its_coordinates(self):
        parent = rectangle(10, 40, 14, 44)
        parent['coordinates'].append([[11, 41], [11, 42], [12, 42], [12, 41], [11, 41]])
        clipped = clip_geometry(parent, rectangle(9, 39, 15, 45), server.connection)
        self.assertTrue(clipped['clipped'])
        self.assertEqual(clipped['bbox'], [10, 40, 14, 44])
        self.assertEqual(len(clipped['geometry']['coordinates']), 2)
        with server.connection(memory='96MB') as con:
            area, hole = con.execute("SELECT ST_Area(g),ST_Contains(g,ST_Point(11.5,41.5)) FROM (SELECT ST_GeomFromGeoJSON(?) g)",
                                     [json.dumps(clipped['geometry'])]).fetchone()
        self.assertAlmostEqual(area, 15)
        self.assertFalse(hole)
        child = rectangle(12.5, 42.5, 13, 43)
        unchanged = clip_geometry(parent, child, server.connection)
        self.assertFalse(unchanged['clipped'])
        self.assertEqual(unchanged['geometry'], child)

    def test_outside_hole_touch_only_and_invalid_inputs_are_rejected(self):
        parent = rectangle(10, 40, 14, 44)
        parent['coordinates'].append([[11, 41], [11, 42], [12, 42], [12, 41], [11, 41]])
        for child in (rectangle(15, 40, 16, 41), rectangle(14, 40, 15, 41), rectangle(11.2, 41.2, 11.8, 41.8),
                      dict(type='Point', coordinates=[11, 42]), rectangle(-179, 40, 179, 40.5)):
            with self.subTest(child=child), self.assertRaises(ValueError):
                clip_geometry(parent, child, server.connection)

    def test_split_date_line_stays_two_exact_polygons_without_world_spanning_fill(self):
        parent = dict(type='MultiPolygon', coordinates=[rectangle(178, -18, 180, -16)['coordinates'],
                                                       rectangle(-180, -18, -178, -16)['coordinates']])
        child = dict(type='MultiPolygon', coordinates=[rectangle(179, -19, 180, -15)['coordinates'],
                                                      rectangle(-180, -19, -179, -15)['coordinates']])
        clipped = clip_geometry(parent, child, server.connection)
        self.assertTrue(clipped['clipped'])
        self.assertEqual(clipped['geometry']['type'], 'MultiPolygon')
        self.assertEqual(len(clipped['geometry']['coordinates']), 2)
        self.assertEqual(clipped['bbox'], [-180, -18, 180, -16])
        with server.connection(memory='96MB') as con:
            area, middle = con.execute("SELECT ST_Area(g),ST_Contains(g,ST_Point(0,-17)) FROM (SELECT ST_GeomFromGeoJSON(?) g)",
                                       [json.dumps(clipped['geometry'])]).fetchone()
        self.assertAlmostEqual(area, 4)
        self.assertFalse(middle)


if __name__ == '__main__':
    unittest.main()
