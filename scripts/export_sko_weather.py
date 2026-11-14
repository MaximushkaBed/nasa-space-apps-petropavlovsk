#!/usr/bin/env python3
"""Save daily ERA5 weather samples for the fire atlas via Open-Meteo."""

from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
import json
import math
from urllib.parse import urlencode
from urllib.request import urlopen

from fetch_firms import PROJECT_ROOT, contains_point, load_region


FIELDS = ("temperature_2m_max", "wind_speed_10m_mean",
          "wind_direction_10m_dominant", "precipitation_sum", "cloud_cover_mean")
UNITS = ("°C", "m/s", "°", "mm", "%")
ENDPOINT = "https://archive-api.open-meteo.com/v1/archive"


def fetch_season(year, points):
    start, stop = date(year, 4, 1), date(year, 10, 31)
    dates = [(start + timedelta(days=offset)).isoformat()
             for offset in range((stop - start).days + 1)]
    query = urlencode({
        "latitude": ",".join(str(lat) for lat, _ in points),
        "longitude": ",".join(str(lon) for _, lon in points),
        "start_date": start.isoformat(), "end_date": stop.isoformat(),
        "models": "era5", "timezone": "GMT", "daily": ",".join(FIELDS),
        "wind_speed_unit": "ms", "cell_selection": "nearest",
        "elevation": ",".join("nan" for _ in points),
    })
    with urlopen(f"{ENDPOINT}?{query}", timeout=35) as response:
        locations = json.load(response)
    if not isinstance(locations, list) or len(locations) != len(points):
        raise ValueError(f"{year}: missing locations in weather response")
    for location, (lat, lon) in zip(locations, points):
        data = location["daily"]
        if (abs(location["latitude"] - lat) > .13 or abs(location["longitude"] - lon) > .13
                or location["utc_offset_seconds"] != 0 or data["time"] != dates
                or any(location["daily_units"][field] != unit or len(data[field]) != len(dates)
                       for field, unit in zip(FIELDS, UNITS))):
            raise ValueError(f"{year}: unexpected ERA5 coordinates, dates or units")
        if any(not isinstance(value, (int, float)) or not math.isfinite(value)
               for field in FIELDS for value in data[field]):
            raise ValueError(f"{year}: missing or invalid daily weather values")
    print(f"{year}: {len(dates)} days, {len(points)} locations", flush=True)
    return {day: [[location["daily"][field][offset] for field in FIELDS]
                  for location in locations] for offset, day in enumerate(dates)}


def main():
    boundary = load_region("sko")
    points = [(y / 4, x / 4) for y in range(210, 223, 3) for x in range(265, 297, 4)
              if contains_point(boundary, x / 4, y / 4)]
    with ThreadPoolExecutor(max_workers=3) as pool:
        seasons = list(pool.map(lambda year: fetch_season(year, points), range(2020, 2026)))
    days = {day: weather for season in seasons for day, weather in season.items()}
    path = PROJECT_ROOT / "web/data/weather.json"
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps({"model": "ERA5", "fields": FIELDS, "points": points, "days": days},
                                    separators=(",", ":"), allow_nan=False) + "\n", encoding="utf-8")
    temporary.replace(path)


if __name__ == "__main__":
    main()
