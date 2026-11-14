#!/usr/bin/env python3
"""Build exploratory fire-factor matrices from public SKO data."""

from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
import io
import json
import math
import shutil
from urllib.parse import urlencode
from urllib.request import urlopen
from zipfile import ZipFile

import numpy as np
from pyproj import Transformer
import rasterio
from rasterio.features import geometry_mask
from rasterio.transform import from_origin
from rasterio.warp import reproject
from scipy.spatial import cKDTree
from scipy.stats import rankdata
from shapely import transform
from shapely.geometry import box, shape

from export_sko_weather import ENDPOINT
from fetch_firms import PROJECT_ROOT, load_region


WEB = PROJECT_ROOT / "web/data"
CACHE = PROJECT_ROOT / "data/cache/sko-correlations"
PROJECT = Transformer.from_crs("EPSG:4326", "EPSG:6933", always_xy=True)
UNPROJECT = Transformer.from_crs("EPSG:6933", "EPSG:4326", always_xy=True)
GRID = 25_000
SAMPLE = 500
SENSORS = {"aqua": 0, "noaa20": 2}
WEATHER_FIELDS = ("relative_humidity_2m_mean", "soil_moisture_0_to_7cm_mean", "precipitation_sum")
WORLD_COVER = "https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map"
DEM = "https://copernicus-dem-90m.s3.eu-central-1.amazonaws.com"


def download(path, url):
    if not path.exists():
        temporary = path.with_suffix(".part")
        with urlopen(url, timeout=60) as response, temporary.open("wb") as stream:
            shutil.copyfileobj(response, stream)
        temporary.replace(path)
    return path


def read_api(name, endpoint, query):
    path = download(CACHE / f"{name}.json", f"{endpoint}?{urlencode(query)}")
    return json.loads(path.read_text(encoding="utf-8"))


def dates_between(start, end):
    return [(start + timedelta(days=i)).isoformat() for i in range((end - start).days + 1)]


def weather_and_river(year, points):
    first, last = date(year, 4, 1), date(year, 10, 31)
    start = first - timedelta(days=7)
    dates = dates_between(start, last)
    locations = read_api(f"era5-extra-{year}", ENDPOINT, {
        "latitude": ",".join(str(p[0]) for p in points),
        "longitude": ",".join(str(p[1]) for p in points),
        "start_date": dates[0], "end_date": dates[-1],
        "models": "era5", "timezone": "GMT", "daily": ",".join(WEATHER_FIELDS),
        "cell_selection": "nearest", "elevation": ",".join(["nan"] * len(points)),
    })
    if len(locations) != len(points):
        raise ValueError(f"{year}: weather coverage differs from the map")
    for location, (lat, lon) in zip(locations, points):
        if (location["daily"]["time"] != dates or location["utc_offset_seconds"] != 0
                or abs(location["latitude"] - lat) > .13 or abs(location["longitude"] - lon) > .13
                or tuple(location["daily_units"][f] for f in WEATHER_FIELDS) != ("%", "m³/m³", "mm")):
            raise ValueError(f"{year}: unexpected weather dates, coordinates or units")
    # Equal weight per sampled location, matching the set used for the map overlays.
    fields = np.mean([[loc["daily"][f] for f in WEATHER_FIELDS] for loc in locations], axis=0)
    if fields.shape != (3, len(dates)) or not np.isfinite(fields).all():
        raise ValueError(f"{year}: missing daily weather data")

    river = read_api(f"glofas-ishim-{year}", "https://flood-api.open-meteo.com/v1/flood", {
        "latitude": 54.87, "longitude": 69.09, "daily": "river_discharge",
        "start_date": first.isoformat(), "end_date": last.isoformat(),
    })
    if (river["daily"]["time"] != dates[7:] or river["utc_offset_seconds"] != 0
            or abs(river["latitude"] - 54.875) > .026 or abs(river["longitude"] - 69.075) > .026
            or river["daily_units"]["river_discharge"] != "m³/s"):
        raise ValueError(f"{year}: unexpected river dates, coordinates or units")
    flow = river["daily"]["river_discharge"]
    # Missing river values remain missing for pairwise correlations.
    return {day: [fields[0, i], fields[1, i], fields[2, i-7:i].sum(), flow[i-7]]
            for i, day in enumerate(dates[7:], start=7)}


def tile_sources(region):
    west, south, east, north = region.bounds
    for name, step in (("cover", 3), ("elevation", 1)):
        for lat in range(math.floor(south / step) * step, math.ceil(north), step):
            for lon in range(math.floor(west / step) * step, math.ceil(east), step):
                if not region.intersects(box(lon, lat, lon + step, lat + step)):
                    continue
                if name == "cover":
                    tile = f"ESA_WorldCover_10m_2021_v200_N{lat:02}E{lon:03}_Map.tif"
                    yield name, tile, f"{WORLD_COVER}/{tile}"
                else:
                    base = f"Copernicus_DSM_COG_30_N{lat:02}_00_E{lon:03}_00_DEM"
                    yield name, f"{base}.tif", f"{DEM}/{base}/{base}.tif"


def load_places(bounds):
    west, south, east, north = bounds
    points = []
    for country in ("KZ", "RU"):
        path = download(CACHE / f"{country}.zip", f"https://download.geonames.org/export/dump/{country}.zip")
        with ZipFile(path) as archive, archive.open(f"{country}.txt") as stream:
            for line in io.TextIOWrapper(stream, encoding="utf-8"):
                row = line.split("\t")
                if row[6] != "P" or row[7] in {"PPLX", "PPLH", "PPLQ", "PPLW", "PPLL"}:
                    continue
                lat, lon = float(row[4]), float(row[5])
                if west-1 <= lon <= east+1 and south-1 <= lat <= north+1:
                    points.append((lon, lat))
    if not points:
        raise ValueError("No places in the GeoNames extracts")
    return np.asarray(points)


def to_sphere(points):
    lon, lat = np.radians(points).T
    return np.column_stack([np.cos(lat)*np.cos(lon), np.cos(lat)*np.sin(lon), np.sin(lat)])


def spatial_units(region, pool):
    projected = transform(region, PROJECT.transform, interleaved=False)
    left, bottom, right, top = projected.bounds
    x0, x1 = math.floor(left / GRID), math.ceil(right / GRID)
    y0, y1 = math.floor(bottom / GRID), math.ceil(top / GRID)
    block = GRID // SAMPLE
    dimensions = ((y1-y0)*block, (x1-x0)*block)
    transform_grid = from_origin(x0*GRID, y1*GRID, SAMPLE, SAMPLE)
    in_region = geometry_mask([projected], dimensions, transform_grid, invert=True)
    rasters = {"cover": np.full(dimensions, np.nan, dtype="float32"),
               "elevation": np.full(dimensions, np.nan, dtype="float32")}
    sources = list(tile_sources(region))
    paths = list(pool.map(lambda item: download(CACHE / item[1], item[2]), sources))
    for (name, _, _), path in zip(sources, paths):
        with rasterio.open(path) as source:
            reproject(rasterio.band(source, 1), rasters[name], dst_crs="EPSG:6933",
                      dst_transform=transform_grid, dst_nodata=np.nan, init_dest_nodata=False)

    positions, grids, surfaces = [], [], []
    for y in range(y0, y1):
        row = slice((y1-y-1)*block, (y1-y)*block)
        for x in range(x0, x1):
            col = slice((x-x0)*block, (x-x0+1)*block)
            mask = in_region[row, col]
            inside = int(mask.sum())
            if inside < block**2 / 2:
                continue
            positions.append(UNPROJECT.transform((x+.5)*GRID, (y+.5)*GRID))
            grids.append((x, y, inside * (SAMPLE / 1000)**2))
            cover = rasters["cover"][row, col][mask]
            elevation = rasters["elevation"][row, col][mask]
            cover = cover[np.isfinite(cover) & (cover > 0)]
            elevation = elevation[np.isfinite(elevation)]
            if len(cover) < .95 * inside or len(elevation) < .95 * inside:
                raise ValueError(f"Insufficient raster coverage in grid cell {(x, y)}")
            low, high = np.percentile(elevation, [10, 90])
            surfaces.append([np.median(elevation), high-low,
                             *(100 * np.mean(cover == code) for code in (10, 30, 40, 90))])

    tree = cKDTree(to_sphere(load_places(region.bounds)))
    chord, _ = tree.query(to_sphere(positions))
    distances = 2 * 6371.0088 * np.arcsin(chord/2)
    return grids, np.column_stack((distances, surfaces))


def pair(a, b, groups):
    if groups is None:
        groups = [np.ones(len(a), dtype=bool)]
    n = 0
    total = 0
    for group in groups:
        valid = group & np.isfinite(a) & np.isfinite(b)
        x, y = a[valid], b[valid]
        if len(x) < 5 or np.ptp(x) == 0 or np.ptp(y) == 0:
            continue
        total += len(x) * np.corrcoef(rankdata(x), rankdata(y))[0, 1]
        n += len(x)
    return [round(float(np.clip(total/n, -1, 1)), 4), n] if n else [None, 0]


def matrix(data, groups=None):
    out = [[None for _ in data] for _ in data]
    for i, a in enumerate(data):
        for j in range(i, len(data)):
            out[i][j] = out[j][i] = pair(a, data[j], groups)
    return out


def main():
    CACHE.mkdir(parents=True, exist_ok=True)
    calendar = json.loads((WEB / "calendar.json").read_text(encoding="utf-8"))
    weather = json.loads((WEB / "weather.json").read_text(encoding="utf-8"))
    months = [item["month"] for item in calendar["months"]]
    years = sorted({int(key[:4]) for key in months})
    with ThreadPoolExecutor(max_workers=5) as pool:
        extras = list(pool.map(lambda year: weather_and_river(year, weather["points"]), years))
        grids, landscape = spatial_units(shape(load_region("sko")), pool)
    extras_by_day = {day: values for season in extras for day, values in season.items()}
    index = {(x, y): i for i, (x, y, _) in enumerate(grids)}
    spatial = {sensor: np.zeros(len(grids)) for sensor in SENSORS}
    daily = {sensor: [] for sensor in SENSORS}
    conditions, date_labels = [], []
    for key in months:
        payload = json.loads((WEB / f"{key}.json").read_text(encoding="utf-8"))
        mapped = []
        for west, south, east, north, *_ in payload["cells"]:
            x, y = PROJECT.transform((west+east)/2, (south+north)/2)
            mapped.append(index.get((math.floor(x/GRID), math.floor(y/GRID))))
        for i, frame in enumerate(payload["frames"], start=1):
            if frame is None:
                continue
            date_label = f"{key}-{i:02}"
            temperature, wind, _, rain = np.mean(weather["days"][date_label], axis=0)
            humidity, soil, prior_rain, flow = extras_by_day[date_label]
            conditions.append([temperature, wind, rain, prior_rain, humidity, soil, flow])
            date_labels.append(key)
            for sensor, slot in SENSORS.items():
                daily[sensor].append(len(frame[slot]))
                for cell in frame[slot]:
                    coarse = mapped[cell]
                    if coarse is not None:
                        spatial[sensor][coarse] += 1
    strata = [np.asarray(date_labels) == key for key in months]
    if len(date_labels) != sum(item["days"] for item in calendar["months"]):
        raise ValueError("Matrix dates differ from the calendar")
    areas = [area for _, _, area in grids]
    output = {"days": len(date_labels), "areas": len(grids), "results": {}}
    for sensor in SENSORS:
        # Preserve ties for equal averages of the reported decimal API values.
        time_data = np.column_stack((daily[sensor], np.round(conditions, 8))).T
        space_data = np.column_stack((spatial[sensor] / areas, landscape)).T
        output["results"][sensor] = {"within": matrix(time_data, strata), "all": matrix(time_data),
                                     "space": matrix(space_data)}
    path = WEB / "correlations.json"
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(output, separators=(",", ":"), allow_nan=False) + "\n", encoding="utf-8")
    temporary.replace(path)
    print(f"{len(date_labels)} days, {len(grids)} grid cells")


if __name__ == "__main__":
    main()
