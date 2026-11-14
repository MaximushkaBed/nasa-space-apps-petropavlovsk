#!/usr/bin/env python3
"""Build browser-ready aggregates for the SKO calendar from validation inputs."""

import argparse
from collections import defaultdict
import csv
import json
import math
from pathlib import Path
from statistics import median

from pyproj import Transformer

from validate_sko_harmonization import (
    PRIMARY_GRID, PROJECT_ROOT, SENSORS, YEARS, load_observations, load_outages,
)


def write_json(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")


def export_calendar(cache_dir, output_dir):
    validation = PROJECT_ROOT / "docs/sko-validation"
    metrics = json.loads((validation / "metrics.json").read_text(encoding="utf-8"))
    factors = {"Aqua": 1, **{row["platform"]: row["factor"] for row in metrics["scenarios"]
                             if row["grid_m"] == PRIMARY_GRID and row["light"] == "all"}}
    with (validation / "monthly.csv").open(newline="", encoding="utf-8") as stream:
        months = list(csv.DictReader(stream))

    rates = {
        month: median(int(row["aqua_cell_days"]) / int(row["included_days"])
                      for row in months if row["split"] == "fit" and int(row["month"][5:7]) == month)
        for month in metrics["months"]
    }
    observations, _ = load_observations([(year, cache_dir / f"{year}.csv") for year in YEARS])
    excluded = load_outages()
    if sorted(day.isoformat() for day in excluded) != metrics["excluded_dates"]:
        raise ValueError("The outage list changed. Run validation again before exporting.")

    grids = defaultdict(lambda: defaultdict(lambda: defaultdict(set)))
    for _, day, platform, _, x, y in observations:
        if day in excluded:
            continue
        index = (math.floor(x / PRIMARY_GRID), math.floor(y / PRIMARY_GRID))
        grids[day.strftime("%Y-%m")][index][platform].add(day.day)

    output_dir.mkdir(parents=True, exist_ok=True)
    unproject = Transformer.from_crs("EPSG:6933", "EPSG:4326", always_xy=True)
    calendar = []
    prefixes = ("aqua", "suomi", "noaa20")
    for row in months:
        key = row["month"]
        cells = []
        totals = [0] * len(SENSORS)
        for (ix, iy), sensors in sorted(grids[key].items()):
            counts = [len(sensors[platform]) for platform in SENSORS]
            # The equal-area cylindrical projection keeps cell edges at constant lat/lon.
            west, south = unproject.transform(ix * PRIMARY_GRID, iy * PRIMARY_GRID)
            east, north = unproject.transform((ix + 1) * PRIMARY_GRID, (iy + 1) * PRIMARY_GRID)
            cells.append([*(round(v, 6) for v in (west, south, east, north)), *counts])
            totals = [total + count for total, count in zip(totals, counts)]
        published = [int(row[f"{prefix}_cell_days"]) for prefix in prefixes]
        if totals != published:
            raise ValueError(f"{key}: map sums {totals} differ from validation totals {published}")

        included = int(row["included_days"])
        # Use the reference during the baseline and the validated VIIRS
        # continuation on the held-out seasons, even when a count is zero.
        series_source = SENSORS.index("Aqua" if row["split"] == "fit" else "NOAA-20")
        calendar.append({"month": key, "split": row["split"], "source": series_source, "days": included,
                         "excluded": int(row["excluded_days"]), "raw": published,
                         "points": [int(row[f"{prefix}_points"]) for prefix in prefixes],
                         "norm": round(rates[int(key[5:7])] * included, 8)})
        write_json(output_dir / f"{key}.json", cells)

    write_json(output_dir / "calendar.json", {"region": "Северо-Казахстанская область", "gridKm": 2,
                                              "zone": "UTC", "baseline": metrics["fit_years"],
                                              "factors": [factors[platform] for platform in SENSORS],
                                              "months": calendar})


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache-dir", type=Path, default=PROJECT_ROOT / "data/cache/sko-validation")
    parser.add_argument("--output-dir", type=Path, default=PROJECT_ROOT / "web/data")
    args = parser.parse_args()
    export_calendar(args.cache_dir, args.output_dir)
