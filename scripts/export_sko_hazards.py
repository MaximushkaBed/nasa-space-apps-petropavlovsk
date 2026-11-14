#!/usr/bin/env python3
"""Export dated global EONET reports and a regional GFM flood pilot."""

from calendar import monthrange
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json
import math
from urllib.parse import urlencode

import numpy as np
from pyproj import Transformer
import rasterio
from rasterio.enums import Resampling
from rasterio.features import geometry_mask, shapes
from rasterio.transform import from_origin
from rasterio.warp import reproject
from shapely import transform
from shapely.geometry import mapping, shape

from export_sko_correlations import download
from fetch_firms import PROJECT_ROOT, load_region


CACHE = PROJECT_ROOT / "data/cache/sko-hazards"
OUT = PROJECT_ROOT / "web/data/hazards"
STAC = "https://stac.eodc.eu/api/v1/search"
EONET = "https://eonet.gsfc.nasa.gov/api/v3/events"
CATEGORIES = ("floods", "volcanoes", "severeStorms", "landslides", "earthquakes",
              "drought", "dustHaze", "snow", "seaLakeIce", "waterColor")
USGS = "https://earthquake.usgs.gov/fdsnws/event/1/query"
FLOOD_YEARS = (2024, 2025)
FLOOD_GRID = 500
PROJECT = Transformer.from_crs("EPSG:4326", "EPSG:6933", always_xy=True)
UNPROJECT = Transformer.from_crs("EPSG:6933", "EPSG:4326", always_xy=True)


def save(path, payload):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":"),
                                    allow_nan=False) + "\n", encoding="utf-8")
    temporary.replace(path)


def load(name, url):
    return json.loads(download(CACHE / name, url).read_text(encoding="utf-8"))


def period_end(month):
    year, number = map(int, month.split("-"))
    return f"{month}-{monthrange(year, number)[1]:02}"


def export_eonet(months):
    query = urlencode({"status": "all", "start": months[0]+"-01", "end": period_end(months[-1]),
                       "category": ",".join(CATEGORIES), "limit": 3000})
    events = load("eonet.json", f"{EONET}?{query}")["events"]
    if len(events) >= 3000:
        raise ValueError("EONET request hit its limit")
    by_month = {month: [] for month in months}
    counts = defaultdict(int)
    for event in events:
        for item in event["geometry"]:
            day = item["date"][:10]
            month = day[:7]
            if month not in by_month:
                continue
            for category in event["categories"]:
                category_id = category["id"]
                if category_id not in CATEGORIES:
                    continue
                by_month[month].append({
                    "type": "Feature", "geometry": {k: item[k] for k in ("type", "coordinates")},
                    "properties": {"date": day, "category": category_id, "id": event["id"],
                                   "name": event["title"], "sourceUrl": event["link"]},
                })
                counts[category_id] += 1
    event_dir = OUT / "eonet"
    event_dir.mkdir(parents=True, exist_ok=True)
    for month, features in by_month.items():
        save(event_dir / f"{month}.geojson", {"type": "FeatureCollection", "features": features})
    print(f"EONET observations: {dict(counts)}", flush=True)


def export_earthquakes(months):
    query = urlencode({"format": "geojson", "starttime": months[0]+"-01",
                       "endtime": period_end(months[-1])+"T23:59:59.999Z", "minmagnitude": 5.5,
                       "eventtype": "earthquake", "limit": 15000})
    payload = load("usgs.json", f"{USGS}?{query}")
    if len(payload["features"]) >= 15000:
        raise ValueError("USGS request hit its limit")
    by_month = {month: [] for month in months}
    for item in payload["features"]:
        props = item["properties"]
        day = datetime.fromtimestamp(props["time"] / 1000, timezone.utc).date().isoformat()
        if day[:7] not in by_month:
            continue
        by_month[day[:7]].append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": item["geometry"]["coordinates"][:2]},
            "properties": {"date": day, "id": item["id"], "name": props["title"],
                           "sourceUrl": props["url"]},
        })
    directory = OUT / "usgs"
    directory.mkdir(parents=True, exist_ok=True)
    for month, features in by_month.items():
        save(directory / f"{month}.geojson", {"type": "FeatureCollection", "features": features})
    print(f"USGS earthquakes: {sum(map(len, by_month.values()))}", flush=True)


def flood_items(year, region):
    bbox = ",".join(map(str, region.bounds))
    interval = f"{year}-04-01T00:00:00Z/{year}-10-31T23:59:59Z"
    query = urlencode({"collections": "GFM", "bbox": bbox, "datetime": interval, "limit": 100})
    url = f"{STAC}?{query}"
    page = 0
    while url:
        result = load(f"gfm-{year}-{page}.json", url)
        yield from (feature for feature in result["features"]
                    if shape(feature["geometry"]).intersects(region))
        url = next((link["href"] for link in result["links"] if link["rel"] == "next"), None)
        page += 1


def read_scene(item, grid, dimensions):
    assets = item["assets"]
    folder = CACHE / item["id"]
    folder.mkdir(exist_ok=True)
    warped = []
    for asset, resampling in (("ensemble_flood_extent", Resampling.max),
                              ("exclusion_mask", Resampling.nearest)):
        path = download(folder / f"{asset}.tif", assets[asset]["href"])
        result = np.full(dimensions, 255, dtype="uint8")
        with rasterio.open(path) as src:
            reproject(rasterio.band(src, 1), result, dst_transform=grid, dst_crs="EPSG:6933",
                      src_nodata=255, dst_nodata=255, resampling=resampling)
        warped.append(result)
    flood, exclusion = warped
    # Max preserves small flooded areas visually. The metric is grid occupancy, not water area.
    # A documented flood pixel can coexist with an excluded point elsewhere in its larger cell.
    return (flood == 1), ((flood == 0) & (exclusion == 0)) | (flood == 1)


def export_flood(months, pool):
    region = shape(load_region("sko"))
    projected = transform(region, PROJECT.transform, interleaved=False)
    west, south, east, north = projected.bounds
    x0, x1, y0, y1 = (math.floor(west/FLOOD_GRID), math.ceil(east/FLOOD_GRID),
                      math.floor(south/FLOOD_GRID), math.ceil(north/FLOOD_GRID))
    grid = from_origin(x0*FLOOD_GRID, y1*FLOOD_GRID, FLOOD_GRID, FLOOD_GRID)
    dims = (y1-y0, x1-x0)
    inside = geometry_mask([projected], dims, grid, invert=True)
    by_month = {month: [] for month in months if int(month[:4]) in FLOOD_YEARS}
    daily = {}
    for year in FLOOD_YEARS:
        items = sorted(flood_items(year, region), key=lambda item: item["properties"]["datetime"])
        by_day = defaultdict(list)
        for item in items:
            by_day[item["properties"]["datetime"][:10]].append(item)
        for day, scenes in by_day.items():
            seen = np.zeros(dims, dtype=bool)
            water = np.zeros(dims, dtype=bool)
            for flooded, valid in pool.map(lambda item: read_scene(item, grid, dims), scenes):
                water |= flooded
                seen |= valid
            water &= inside
            seen &= inside
            if not seen.any():
                continue
            flooded_pct = 100 * np.count_nonzero(water) / np.count_nonzero(seen)
            observed_pct = 100 * np.count_nonzero(seen) / np.count_nonzero(inside)
            daily[day] = [round(flooded_pct, 5), round(observed_pct, 3)]
            if water.any():
                geoms = [shape(g) for g, _ in shapes(water.astype("uint8"), mask=water, transform=grid)]
                geometries = [mapping(transform(geom.simplify(100), UNPROJECT.transform, interleaved=False))
                              for geom in geoms]
                by_month[day[:7]].append({
                    "type": "Feature", "geometry": {"type": "GeometryCollection", "geometries": geometries},
                    "properties": {"date": day, "name": "Затопление по Sentinel-1",
                                   "value": round(flooded_pct, 2), "coverage": round(observed_pct, 1)},
                })
        print(f"GFM {year}: {len(items)} scenes on {len(by_day)} days", flush=True)
    if not any(by_month.values()):
        raise ValueError("No mapped floodwater in the regional pilot")
    flood_dir = OUT / "gfm"
    flood_dir.mkdir(parents=True, exist_ok=True)
    for month, features in by_month.items():
        metadata = {d: v for d, v in daily.items() if d.startswith(month)}
        save(flood_dir / f"{month}.geojson",
             {"type": "FeatureCollection", "features": features, "observations": metadata})
    save(flood_dir / "daily.json", daily)


def main():
    CACHE.mkdir(parents=True, exist_ok=True)
    calendar = json.loads((PROJECT_ROOT / "web/data/calendar.json").read_text(encoding="utf-8"))
    months = sorted({row["month"] for row in calendar["months"]})
    with ThreadPoolExecutor(max_workers=5) as pool:
        global_export = pool.submit(export_eonet, months)
        earthquake_export = pool.submit(export_earthquakes, months)
        export_flood(months, pool)
        global_export.result()
        earthquake_export.result()


if __name__ == "__main__":
    main()
