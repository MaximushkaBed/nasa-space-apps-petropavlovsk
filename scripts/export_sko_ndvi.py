"""Sample approximate NDVI from the published NASA GIBS colour ranges."""

from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from io import BytesIO
import json
import math
from pathlib import Path
from statistics import mean
from urllib.request import urlopen
from xml.etree import ElementTree

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "web/data"
CACHE = ROOT / "data/cache/sko-correlations/mod13a1-gibs"
COLORS = "https://gibs.earthdata.nasa.gov/colormaps/v1.3/MODIS_L3_NDVI.xml"
TILES = ("https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/"
         "MODIS_Terra_L3_NDVI_16Day/default/{day}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.png")
ZOOM = 9


def read(url):
    with urlopen(url, timeout=40) as response:
        return response.read()


def samples_by_tile(stations):
    width = 256 * 2**ZOOM
    groups = defaultdict(list)
    for lat, lon in stations:
        px = int((lon + 180) / 360 * width)
        py = int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * width)
        groups[px // 256, py // 256].append((px % 256, py % 256))
    return groups


def run():
    CACHE.mkdir(parents=True, exist_ok=True)
    xml = ElementTree.fromstring(read(COLORS))
    palette = {}
    for entry in xml.findall(".//ColorMapEntry"):
        if entry.get("transparent") == "false":
            rgb = tuple(map(int, entry.get("rgb").split(",")))
            limits = map(float, entry.get("value")[1:-1].split(","))
            palette[rgb] = mean(limits)

    stations = json.loads((WEB / "weather.json").read_text(encoding="utf-8"))["points"]
    groups = samples_by_tile(stations)

    def sample(day):
        values = []
        for (x, y), pixels in groups.items():
            path = CACHE / f"{day}-{x}-{y}.png"
            if not path.exists():
                raw = read(TILES.format(day=day, z=ZOOM, x=x, y=y))
                with Image.open(BytesIO(raw)) as tile:
                    tile.verify()
                path.write_bytes(raw)
            with Image.open(path) as tile:
                rgba = tile.convert("RGBA")
                for pixel in pixels:
                    *rgb, alpha = rgba.getpixel(pixel)
                    if alpha and tuple(rgb) in palette:
                        values.append(palette[tuple(rgb)])
        return day.isoformat(), [round(mean(values), 5), len(values)] if len(values) >= 9 else None

    days = [date(year, 1, 1) + timedelta(days=offset) for year in range(2020, 2026)
            for offset in range(0, 365, 16)
            if 3 <= (date(year, 1, 1) + timedelta(days=offset)).month <= 10]
    with ThreadPoolExecutor(max_workers=10) as pool:
        composites = {day: value for day, value in pool.map(sample, days) if value is not None}
    output = {"source": "Terra MODIS 16-day NDVI via NASA GIBS color bins", "composites": composites}
    (WEB / "sko-ndvi.json").write_text(json.dumps(output, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"{len(composites)} valid composites")


if __name__ == "__main__":
    run()
