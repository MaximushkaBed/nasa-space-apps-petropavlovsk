#!/usr/bin/env python3
"""Extract FIRMS observations and evaluate a MODIS-equivalent index for SKO."""

import argparse
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
import csv
from datetime import date, datetime, timedelta
import hashlib
import json
import math
from pathlib import Path
import statistics

import duckdb
from pyproj import Transformer

from fetch_firms import PROJECT_ROOT, geometry_bbox, load_region


CATALOG = "https://data.source.coop/portolan-mirrors/firms-catalog/detections"
FIT_YEARS = range(2020, 2024)
TEST_YEARS = range(2024, 2026)
YEARS = (*FIT_YEARS, *TEST_YEARS)
MONTHS = range(4, 11)
REFERENCE = "Aqua"
VIIRS = ("Suomi-NPP", "NOAA-20")
SENSORS = (REFERENCE, *VIIRS)
GRID_SIZES = (1000, 2000, 5000)
PRIMARY_GRID = 2000
OUTAGES = PROJECT_ROOT / "docs/sko-validation/outages.csv"
QUERY = """
WITH nearby AS MATERIALIZED (
    SELECT acq_datetime, satellite, quality, version, type, daynight,
           confidence_pct, lower(confidence) AS confidence,
           ST_X(geometry) AS longitude, ST_Y(geometry) AS latitude
    FROM read_parquet(?)
    WHERE ST_Intersects_Extent(geometry, ST_MakeEnvelope(?, ?, ?, ?))
)
SELECT DISTINCT acq_datetime, satellite, quality, version, type, daynight,
                confidence_pct, confidence, longitude, latitude
FROM nearby
WHERE satellite IN ('Aqua', 'Suomi-NPP', 'NOAA-20')
  AND ST_Covers(ST_GeomFromGeoJSON(?), ST_Point(longitude, latitude))
ORDER BY acq_datetime, satellite, longitude, latitude, quality, version, type,
         daynight, confidence_pct, confidence
"""


def extract_year(year, geometry, cache_dir, extension_dir):
    path = cache_dir / f"{year}.csv"
    if path.exists():
        return year, path

    config = {"threads": 3, "extension_directory": str(extension_dir)}
    with duckdb.connect(config=config) as connection:
        connection.load_extension("httpfs")
        connection.load_extension("spatial")
        url = f"{CATALOG}/year={year}/detections.parquet"
        bbox = [float(value) for value in geometry_bbox(geometry).split(",")]
        cursor = connection.execute(QUERY, [url, *bbox, json.dumps(geometry)])
        columns = [column[0] for column in cursor.description]
        rows = cursor.fetchall()
        if not rows or {row[1] for row in rows} != set(SENSORS):
            raise ValueError(f"Missing a platform for {year}; inspect the archive partition.")

    write_csv(path, columns, rows)
    print(f"{year}: extracted {len(rows)} rows inside SKO", flush=True)
    return year, path


def write_csv(path, columns, rows):
    temporary = path.with_suffix(".tmp")
    with temporary.open("w", newline="", encoding="utf-8") as stream:
        writer = csv.writer(stream, lineterminator="\n")
        writer.writerow(columns)
        writer.writerows(rows)
    temporary.replace(path)


def load_outages():
    excluded = set()
    with OUTAGES.open(newline="", encoding="utf-8") as stream:
        for row in csv.DictReader(stream):
            day = date.fromisoformat(row["start_utc"])
            end = date.fromisoformat(row["end_utc_inclusive"])
            while day <= end:
                if day.year in YEARS and day.month in MONTHS:
                    excluded.add(day)
                day += timedelta(days=1)
    return excluded


def load_observations(paths):
    strata = defaultdict(int)
    observations = set()
    project = Transformer.from_crs("EPSG:4326", "EPSG:6933", always_xy=True)
    for year, path in sorted(paths):
        with path.open(newline="", encoding="utf-8") as stream:
            for row in csv.DictReader(stream):
                day = date.fromisoformat(row["acq_datetime"][:10])
                platform = row["satellite"]
                if day.year != year:
                    raise ValueError(f"Observation outside archive year {year}: {day}")
                if day.month not in MONTHS:
                    continue
                strata[(year, platform, row["quality"], row["version"], row["type"])] += 1
                if row["quality"] != "sp" or row["type"] != "0":
                    continue
                if platform == REFERENCE:
                    confident = int(row["confidence_pct"]) >= 30
                else:
                    confident = row["confidence"] in {"n", "h", "nominal", "high"}
                if confident:
                    x, y = project.transform(float(row["longitude"]), float(row["latitude"]))
                    observations.add((row["acq_datetime"], day, platform, row["daynight"], x, y))
    expected = {(year, platform) for year in YEARS for platform in SENSORS}
    if {(day.year, platform) for _, day, platform, _, _, _ in observations} != expected:
        raise ValueError("Missing eligible observations for a platform and season.")
    return observations, strata


def date_range(year):
    day = date(year, MONTHS.start, 1)
    end = date(year, MONTHS.stop, 1)
    while day < end:
        yield day
        day += timedelta(days=1)


def summarize(observations, grid_size, excluded, light="all"):
    cells = defaultdict(set)
    points = defaultdict(int)
    for _, day, platform, daynight, x, y in observations:
        if light == "all" or daynight == light:
            points[day, platform] += 1
            cells[day, platform].add((math.floor(x / grid_size), math.floor(y / grid_size)))

    months = defaultdict(lambda: defaultdict(int))
    weeks = defaultdict(lambda: defaultdict(int))
    for year in YEARS:
        for offset, day in enumerate(date_range(year)):
            if day in excluded:
                continue
            month = months[year, day.month]
            week = weeks[year, offset // 7 + 1]
            month["eligible_days"] += 1
            for platform in SENSORS:
                count = len(cells[day, platform])
                month[f"{platform}_points"] += points[day, platform]
                month[platform] += count
                week[platform] += count
            for platform in VIIRS:
                left, right = cells[day, REFERENCE], cells[day, platform]
                month[f"{platform}_intersection"] += len(left & right)
                month[f"{platform}_union"] += len(left | right)
    return months, weeks


def score(pairs, factor):
    predicted = [(target, factor * observed) for target, observed in pairs]
    errors = [estimate - target for target, estimate in predicted]
    target_total = sum(target for target, _ in predicted)
    return {
        "periods": len(errors),
        "mae": statistics.mean(abs(error) for error in errors),
        "bias_pct": 100 * sum(errors) / target_total if target_total else None,
    }


def scores_by_period(groups, platform, factor, years, suffix=""):
    pairs = [(row[REFERENCE + suffix], row[platform + suffix])
             for (year, _), row in sorted(groups.items()) if year in years]
    return score(pairs, 1), score(pairs, factor)


def top_weeks(weeks, platform, year, limit=5):
    active = [(week, row[platform]) for (season, week), row in weeks.items()
              if season == year and row[platform] > 0]
    # Use the earlier week to break ties consistently across platforms.
    return [week for week, _ in sorted(active, key=lambda item: (-item[1], item[0]))[:limit]]


def evaluate(observations, excluded):
    scenarios = []
    primary_months = None
    for size, light in [(size, "all") for size in GRID_SIZES] + [(PRIMARY_GRID, "D"), (PRIMARY_GRID, "N")]:
        months, weeks = summarize(observations, size, excluded, light)
        if size == PRIMARY_GRID and light == "all":
            primary_months = months
        for platform in VIIRS:
            fit_rows = [row for (year, _), row in months.items() if year in FIT_YEARS]
            fit_target = sum(row[REFERENCE] for row in fit_rows)
            fit_viirs = sum(row[platform] for row in fit_rows)
            factor = fit_target / fit_viirs
            monthly_raw, monthly_adjusted = scores_by_period(months, platform, factor, TEST_YEARS)
            weekly_raw, weekly_adjusted = scores_by_period(weeks, platform, factor, TEST_YEARS)
            point_counts, _ = scores_by_period(months, platform, 1, TEST_YEARS, "_points")
            test_rows = [row for (year, _), row in months.items() if year in TEST_YEARS]
            other_fit_rows = [row for (year, _), row in months.items()
                              if year in FIT_YEARS and year != 2022]
            factor_without_2022 = (sum(row[REFERENCE] for row in other_fit_rows)
                                   / sum(row[platform] for row in other_fit_rows))
            scenarios.append({
                "grid_m": size, "light": light, "platform": platform,
                "factor": factor, "fit_aqua_cell_days": fit_target, "fit_viirs_cell_days": fit_viirs,
                "test_monthly_points": point_counts,
                "test_monthly_raw": monthly_raw, "test_monthly_adjusted": monthly_adjusted,
                "factor_without_2022": factor_without_2022,
                "test_monthly_adjusted_without_2022": scores_by_period(
                    months, platform, factor_without_2022, TEST_YEARS
                )[1],
                "test_weekly_raw": weekly_raw, "test_weekly_adjusted": weekly_adjusted,
                "test_intersection": sum(row[f"{platform}_intersection"] for row in test_rows),
                "test_union": sum(row[f"{platform}_union"] for row in test_rows),
                "by_year": {
                    year: {
                        "aqua_cell_days": sum(row[REFERENCE] for (y, _), row in months.items() if y == year),
                        "viirs_cell_days": sum(row[platform] for (y, _), row in months.items() if y == year),
                        "aqua_points": sum(row[f"{REFERENCE}_points"] for (y, _), row in months.items() if y == year),
                        "viirs_points": sum(row[f"{platform}_points"] for (y, _), row in months.items() if y == year),
                        "raw": scores_by_period(months, platform, factor, (year,))[0],
                        "adjusted": scores_by_period(months, platform, factor, (year,))[1],
                        "aqua_top_weeks": top_weeks(weeks, REFERENCE, year),
                        "viirs_top_weeks": top_weeks(weeks, platform, year),
                    }
                    for year in YEARS
                },
            })
    return scenarios, primary_months


def seasonal_baseline(months):
    """Aqua median cell-days per included day for each calendar month."""
    median_rates = {
        month: statistics.median(row[REFERENCE] / row["eligible_days"]
                                 for (year, m), row in months.items() if year in FIT_YEARS and m == month)
        for month in MONTHS
    }
    pairs = [(row[REFERENCE], median_rates[month] * row["eligible_days"])
             for (year, month), row in months.items() if year in TEST_YEARS]
    return score(pairs, 1)


def coincident_detections(observations, excluded, time_window=60):
    """Compare positive cell-days from the same UTC day, light and near pass time."""
    times = defaultdict(lambda: defaultdict(set))
    for timestamp, day, platform, light, x, y in observations:
        if day.year not in TEST_YEARS or day in excluded:
            continue
        moment = datetime.fromisoformat(timestamp)
        cell = (math.floor(x / PRIMARY_GRID), math.floor(y / PRIMARY_GRID))
        times[day, cell][platform].add((light, 60 * moment.hour + moment.minute))

    stats = {}
    for platform in VIIRS:
        shared_days = sum(REFERENCE in passes and platform in passes for passes in times.values())
        near_days = sum(
            any(a_light == v_light and abs(a_minute - v_minute) <= time_window
                for a_light, a_minute in passes.get(REFERENCE, ())
                for v_light, v_minute in passes.get(platform, ()))
            for passes in times.values()
        )
        stats[platform] = {"shared_cell_days": shared_days, "within_window_cell_days": near_days}
    return {"grid_m": PRIMARY_GRID, "time_window_minutes": time_window, "platforms": stats}


def save_results(output_dir, scenarios, months, strata, excluded, coincident, paths):
    output_dir.mkdir(parents=True, exist_ok=True)
    factors = {row["platform"]: row["factor"] for row in scenarios
               if row["grid_m"] == PRIMARY_GRID and row["light"] == "all"}
    columns = ["month", "split", "included_days", "excluded_days", "aqua_points", "suomi_points", "noaa20_points",
               "aqua_cell_days", "suomi_cell_days", "noaa20_cell_days",
               "suomi_adjusted_cell_days", "noaa20_adjusted_cell_days",
               "aqua_suomi_shared_cell_days", "aqua_noaa20_shared_cell_days"]
    rows = (
        [f"{year}-{month:02}", "fit" if year in FIT_YEARS else "test",
         values["eligible_days"], sum(day.year == year and day.month == month for day in excluded),
         *(values[f"{satellite}_points"] for satellite in SENSORS),
         *(values[satellite] for satellite in SENSORS),
         *(round(values[satellite] * factors[satellite], 6) for satellite in VIIRS),
         *(values[f"{satellite}_intersection"] for satellite in VIIRS)]
        for (year, month), values in sorted(months.items())
    )
    write_csv(output_dir / "monthly.csv", columns, rows)
    payload = {"fit_years": list(FIT_YEARS), "test_years": list(TEST_YEARS),
               "months": list(MONTHS), "scenarios": scenarios, "coincident_detections": coincident,
               "test_monthly_aqua_seasonal_baseline_2km": seasonal_baseline(months),
               "excluded_dates": sorted(day.isoformat() for day in excluded),
               "extract_sha256": {year: hashlib.sha256(path.read_bytes()).hexdigest() for year, path in paths},
               "input_counts": [{"year": y, "platform": satellite, "quality": quality,
                                 "version": version, "type": fire_type, "rows": count}
                                for (y, satellite, quality, version, fire_type), count in sorted(strata.items())]}
    (output_dir / "metrics.json").write_text(json.dumps(payload, indent=2, allow_nan=False) + "\n", encoding="utf-8")


def plot_test_seasons(output_dir, scenarios, months):
    import matplotlib.pyplot as plt
    from matplotlib.ticker import MaxNLocator

    factors = {row["platform"]: row["factor"] for row in scenarios
               if row["grid_m"] == PRIMARY_GRID and row["light"] == "all"}
    plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 10, "axes.spines.top": False,
                         "axes.spines.right": False, "axes.spines.left": False,
                         "axes.spines.bottom": False, "text.color": "#172a3a"})
    fig, axes = plt.subplots(1, 2, figsize=(10, 4.4))
    fig.subplots_adjust(left=.09, right=.98, top=.71, bottom=.24, wspace=.22)
    fig.text(.09, .95, "Активность в СКО после пересчёта VIIRS к шкале Aqua",
             fontsize=15.5, weight="bold", va="top")
    fig.text(.09, .865, "Сетка 2 км · ячейко-дни · масштабы панелей различаются", color="#405366")
    series = [(REFERENCE, "Aqua / MODIS", "#172a3a", "o", "-"),
              (VIIRS[0], "Suomi NPP / VIIRS", "#24756a", "s", "--"),
              (VIIRS[1], "NOAA-20 / VIIRS", "#ac4e30", "^", ":")]
    for ax, year in zip(axes, TEST_YEARS):
        for platform, label, color, marker, style in series:
            values = [months[year, month][platform] * factors.get(platform, 1) for month in MONTHS]
            ax.plot(list(MONTHS), values, label=label, color=color, marker=marker,
                    linestyle=style, linewidth=1.9, markersize=4.5)
        ax.set_title(str(year), loc="left", weight="bold", pad=12)
        ax.set_xticks(list(MONTHS), ["Апр", "Май", "Июн", "Июл", "Авг", "Сен", "Окт"])
        ax.set_ylim(bottom=0)
        ax.yaxis.set_major_locator(MaxNLocator(integer=True, nbins=5))
        ax.tick_params(axis="both", length=0, pad=5, colors="#405366")
        ax.set_axisbelow(True)
        ax.grid(axis="y", color="#dfe6eb", linewidth=.8)
    handles, labels = axes[0].get_legend_handles_labels()
    fig.legend(handles, labels, loc="lower left", bbox_to_anchor=(.083, .105), frameon=False, ncol=3)
    fig.text(.09, .065, "NASA FIRMS SP через Portolan · коэффициенты рассчитаны по 2020–2023 годам",
             color="#405366", fontsize=8.5)
    fig.savefig(output_dir / "test-seasons.png", dpi=180, facecolor="white")
    plt.close(fig)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache-dir", type=Path, default=PROJECT_ROOT / "data/cache/sko-validation")
    parser.add_argument("--output-dir", type=Path, default=PROJECT_ROOT / "docs/sko-validation")
    parser.add_argument("--workers", type=int, choices=range(1, 5), default=3)
    parser.add_argument("--plot", action="store_true", help="write the stand-alone chart (requires matplotlib)")
    args = parser.parse_args()
    args.cache_dir.mkdir(parents=True, exist_ok=True)
    extension_dir = (args.cache_dir / "extensions").resolve()
    if not all((args.cache_dir / f"{year}.csv").exists() for year in YEARS):
        with duckdb.connect(config={"extension_directory": str(extension_dir)}) as connection:
            for extension in ("httpfs", "spatial"):
                connection.install_extension(extension)
    geometry = load_region("sko")
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        paths = list(pool.map(lambda year: extract_year(year, geometry, args.cache_dir, extension_dir), YEARS))
    observations, strata = load_observations(paths)
    excluded = load_outages()
    scenarios, months = evaluate(observations, excluded)
    coincident = coincident_detections(observations, excluded)
    save_results(args.output_dir, scenarios, months, strata, excluded, coincident, paths)
    if args.plot:
        plot_test_seasons(args.output_dir, scenarios, months)
    included_count = sum(day not in excluded for _, day, _, _, _, _ in observations)
    print(f"Analyzed {included_count} eligible detections; results in {args.output_dir}")


if __name__ == "__main__":
    main()
