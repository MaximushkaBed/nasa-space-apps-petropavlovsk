"""Build a resumable MODIS/VIIRS history for an administrative region."""

import argparse
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
import csv
from datetime import date, datetime, timedelta, timezone
import hashlib
import io
import json
from pathlib import Path
import re
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

from scripts import fetch_firms as firms


BASE = "https://firms.modaps.eosdis.nasa.gov"
FAMILIES = ("MODIS", "VIIRS_SNPP", "VIIRS_NOAA20", "VIIRS_NOAA21")
PRODUCTS = {"modis": "MODIS", "viirs-snpp": "VIIRS_SNPP",
            "viirs-jpss1": "VIIRS_NOAA20", "viirs-noaa20": "VIIRS_NOAA20",
            "viirs-jpss2": "VIIRS_NOAA21", "viirs-noaa21": "VIIRS_NOAA21"}


def read_text(url):
    try:
        request = Request(url, headers={"User-Agent": "NASA-Space-Apps-Petropavlovsk/0.1"})
        with urlopen(request, timeout=60) as response:
            return response.read().decode("utf-8-sig")
    except HTTPError as error:
        raise firms.FirmsError(f"NASA metadata request failed: HTTP {error.code}.") from None
    except (URLError, TimeoutError, ConnectionError, UnicodeDecodeError):
        raise firms.FirmsError("Cannot read NASA metadata; retry when the service is available.") from None


def availability(map_key):
    text = read_text(f"{BASE}/api/data_availability/csv/{quote(map_key, safe='')}/ALL")
    reader = csv.DictReader(io.StringIO(text))
    if not {"data_id", "min_date", "max_date"}.issubset(reader.fieldnames or []):
        raise firms.FirmsError("Invalid data-availability response; check the MAP_KEY.")
    result = {}
    for row in reader:
        if row["data_id"] in firms.SOURCES:
            try:
                date.fromisoformat(row["min_date"])
                date.fromisoformat(row["max_date"])
            except ValueError:
                raise firms.FirmsError("NASA returned an invalid availability date.") from None
            result[row["data_id"]] = {"min_date": row["min_date"], "max_date": row["max_date"]}
    if not result:
        raise firms.FirmsError("No MODIS/VIIRS product availability returned.")
    return result


def annual_catalog(text):
    result = {}
    pattern = re.compile(r"(.+)_(\d{4})_Kazakhstan\.csv$")
    for row in csv.reader(io.StringIO(text)):
        if len(row) != 3:
            continue
        match = pattern.fullmatch(row[0])
        if not match or match[1] not in PRODUCTS:
            continue
        product, year = match[1], int(match[2])
        source = PRODUCTS[product] + "_SP"
        result[(source, year)] = {
            "url": f"{BASE}/data/country/{product}/{year}/{row[0]}",
            "published_size": int(row[1]), "published_updated_at": row[2],
        }
    return result


def plan(available, catalog, start, end):
    jobs = []
    for family in FAMILIES:
        standard = available.get(family + "_SP")
        if standard:
            first = max(start, date.fromisoformat(standard["min_date"]))
            last = min(end, date.fromisoformat(standard["max_date"]))
            for year in range(first.year, last.year + 1):
                left, right = max(first, date(year, 1, 1)), min(last, date(year, 12, 31))
                if left > right:
                    continue
                source = family + "_SP"
                bulk = catalog.get((source, year))
                if bulk:
                    jobs.append({"source": source, "start": str(left), "end": str(right),
                                 "method": "annual_country_csv", **bulk})
                else:
                    for day, count in firms.date_windows(left, right):
                        jobs.append({"source": source, "start": str(day),
                                     "end": str(day + timedelta(days=count - 1)), "method": "area_api"})
        near_real_time = available.get(family + "_NRT")
        if near_real_time:
            first = max(start, date.fromisoformat(near_real_time["min_date"]))
            if standard:
                first = max(first, date.fromisoformat(standard["max_date"]) + timedelta(days=1))
            last = min(end, date.fromisoformat(near_real_time["max_date"]))
            for day, count in firms.date_windows(first, last):
                jobs.append({"source": family + "_NRT", "start": str(day),
                             "end": str(day + timedelta(days=count - 1)), "method": "area_api"})
    return jobs


def select_rows(reader, bbox, geometry, start, end):
    west, south, east, north = map(float, bbox.split(","))
    result = []
    for row in reader:
        try:
            longitude, latitude = float(row["longitude"]), float(row["latitude"])
            observed = date.fromisoformat(row["acq_date"])
        except (ValueError, TypeError, KeyError):
            raise firms.FirmsError("Invalid coordinates/date in a NASA observation.") from None
        if (start <= observed <= end and west <= longitude <= east and south <= latitude <= north
                and firms.contains_point(geometry, longitude, latitude)):
            result.append(row)
    return result


def download_job(job, key, bbox, geometry, boundary_hash, cache_dir, refresh=False):
    fingerprint = json.dumps({**job, "bbox": bbox, "boundary_sha256": boundary_hash}, sort_keys=True)
    identifier = hashlib.sha256(fingerprint.encode()).hexdigest()
    path = cache_dir / f"{identifier}.csv"
    meta_path = cache_dir / f"{identifier}.json"
    mutable = job["source"].endswith("_NRT") and date.fromisoformat(job["end"]) >= date.today() - timedelta(days=7)
    if not refresh and not mutable and path.exists() and meta_path.exists():
        metadata = json.loads(meta_path.read_text())
        if hashlib.sha256(path.read_bytes()).hexdigest() == metadata["sha256"]:
            return metadata
    start, end = date.fromisoformat(job["start"]), date.fromisoformat(job["end"])
    for attempt in range(3):
        try:
            if job["method"] == "annual_country_csv":
                request = Request(job["url"], headers={"User-Agent": "NASA-Space-Apps-Petropavlovsk/0.1"})
                with urlopen(request, timeout=60) as response:
                    reader = csv.DictReader(io.TextIOWrapper(response, encoding="utf-8-sig"), strict=True)
                    columns = reader.fieldnames or []
                    if not {"latitude", "longitude", "acq_date", "acq_time"}.issubset(columns):
                        raise firms.FirmsError("NASA annual file is not a hotspot CSV.")
                    rows = select_rows(reader, bbox, geometry, start, end)
            else:
                columns, observations = firms.fetch_csv(key, job["source"], bbox, start, (end - start).days + 1)
                rows = select_rows(observations, bbox, geometry, start, end)
            firms.write_csv(path, columns, rows)
            metadata = {"job": job, "file": str(path), "count": len(rows), "columns": columns,
                        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                        "retrieved_at": datetime.now(timezone.utc).isoformat()}
            meta_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n")
            return metadata
        except (firms.FirmsError, HTTPError, URLError, TimeoutError, ConnectionError, csv.Error):
            if attempt == 2:
                raise firms.FirmsError(f"Download failed: {job['source']} {start}..{end}; completed cache is preserved.") from None
            time.sleep(2 ** attempt)


def platform(source, satellite):
    family = source.rsplit("_", 1)[0]
    if family != "MODIS":
        return {"VIIRS_SNPP": "Suomi-NPP", "VIIRS_NOAA20": "NOAA-20", "VIIRS_NOAA21": "NOAA-21"}[family]
    return {"T": "Terra", "A": "Aqua", "Terra": "Terra", "Aqua": "Aqua"}.get(satellite, satellite)


def summarize(results, available, start, end, output):
    output.mkdir(parents=True, exist_ok=True)
    columns = sorted({column for result in results for column in result["columns"]})
    daily = defaultdict(Counter)
    covered = defaultdict(set)
    totals, versions, platforms = Counter(), defaultdict(Counter), Counter()
    seen = set()
    master = output / "observations.csv"
    with master.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=["source", "family", "processing", "platform"] + columns)
        writer.writeheader()
        for result in sorted(results, key=lambda item: (item["job"]["source"], item["job"]["start"])):
            job = result["job"]
            source = job["source"]
            family, processing = source.rsplit("_", 1)
            left, right = date.fromisoformat(job["start"]), date.fromisoformat(job["end"])
            covered[family].update(left + timedelta(days=offset) for offset in range((right - left).days + 1))
            with Path(result["file"]).open(newline="") as records:
                for row in csv.DictReader(records):
                    unique = (source, tuple(sorted(row.items())))
                    if unique in seen:
                        continue
                    seen.add(unique)
                    label = platform(source, row.get("satellite", ""))
                    writer.writerow({"source": source, "family": family, "processing": processing,
                                     "platform": label, **row})
                    metrics = daily[(family, row["acq_date"])]
                    metrics["detections"] += 1
                    metrics[processing] += 1
                    metrics["type_0"] += row.get("type") == "0"
                    metrics["type_unknown"] += row.get("type", "") == ""
                    totals[source] += 1
                    versions[source][row.get("version", "unknown")] += 1
                    platforms[label] += 1
    months = []
    cursor = date(start.year, start.month, 1)
    while cursor <= end:
        following = date(cursor.year + (cursor.month == 12), cursor.month % 12 + 1, 1)
        right = following - timedelta(days=1)
        days = [cursor + timedelta(days=offset) for offset in range((following - cursor).days)]
        for family in FAMILIES:
            queried = [day for day in days if day in covered[family]]
            if not queried:
                continue
            metrics = Counter()
            for day in queried:
                metrics.update(daily[(family, str(day))])
            months.append({"family": family, "month": cursor.strftime("%Y-%m"),
                           "detections": metrics["detections"], "standard": metrics["SP"],
                           "near_real_time": metrics["NRT"], "type_0": metrics["type_0"],
                           "type_unknown": metrics["type_unknown"], "query_days": len(queried),
                           "calendar_days": len(days), "partial_month": len(queried) != len(days),
                           "days_with_detections": sum(daily[(family, str(day))]["detections"] > 0 for day in queried)})
        cursor = following
    annual = defaultdict(Counter)
    for row in months:
        key = (row["family"], row["month"][:4])
        annual[key].update({field: row[field] for field in (
            "detections", "standard", "near_real_time", "type_0", "type_unknown", "query_days", "days_with_detections",
        )})
    yearly = [{"family": family, "year": year, **metrics,
               "partial_year": metrics["query_days"] != (date(int(year) + 1, 1, 1) - date(int(year), 1, 1)).days}
              for (family, year), metrics in sorted(annual.items())]
    summary = {"region": "North Kazakhstan Region / СКО", "requested_start": str(start), "requested_end": str(end),
               "created_at": datetime.now(timezone.utc).isoformat(), "availability": available,
               "totals_by_source": dict(totals), "versions": {key: dict(value) for key, value in versions.items()},
               "totals_by_platform": dict(platforms), "months": months, "years": yearly,
               "notes": ["Counts are satellite detections of thermal anomalies, not distinct fires or burned area.",
                         "Series are raw and not harmonized; do not sum sensors to infer a historical trend.",
                         "SP is preferred; NRT is appended only after the SP availability end date for that sensor.",
                         "Successful data queries do not establish clear-sky sensor coverage; zero detections is not proof of no fire.",
                         "Original collection/version and type fields are preserved; type classifications can differ by version.",
                         "The boundary is the geoBoundaries North Kazakhstan feature with reference year 2017.",
                         "Observation dates are UTC; the current day, month and year may be incomplete."]}
    (output / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
    for name, rows in (("monthly.csv", months), ("yearly.csv", yearly)):
        firms.write_csv(output / name, list(rows[0]), rows)
    return summary


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--region", choices=firms.REGIONS, default="sko")
    parser.add_argument("--start", type=firms.parse_date, default=date(2000, 11, 1))
    parser.add_argument("--end", type=firms.parse_date, default=datetime.now(timezone.utc).date())
    parser.add_argument("--workers", type=int, choices=range(1, 5), default=4)
    parser.add_argument("--refresh", action="store_true")
    args = parser.parse_args(argv)
    if args.start > args.end:
        parser.error("--start must be on or before --end")
    output = firms.PROJECT_ROOT / "data/raw/firms" / args.region / "history"
    cache = firms.PROJECT_ROOT / "data/cache/firms-history" / args.region
    output.mkdir(parents=True, exist_ok=True)
    cache.mkdir(parents=True, exist_ok=True)
    try:
        key = firms.read_map_key(firms.PROJECT_ROOT / ".env")
        geometry = firms.load_region(args.region)
        bbox = firms.geometry_bbox(geometry)
        boundary_hash = hashlib.sha256(firms.REGIONS[args.region].read_bytes()).hexdigest()
        available = availability(key)
        catalog = annual_catalog(read_text(f"{BASE}/data/country/yearly_summary_files.txt"))
        jobs = plan(available, catalog, args.start, args.end)
        if not jobs:
            raise firms.FirmsError("No sources are available for the requested dates.")
        print(f"Plan: {len(jobs)} downloads; {sum(job['method'] == 'annual_country_csv' for job in jobs)} annual CSVs; bbox {bbox}", flush=True)
        manifest = {"status": "downloading", "requested_start": str(args.start), "requested_end": str(args.end),
                    "boundary_sha256": boundary_hash, "bbox": bbox, "availability": available,
                    "planned_jobs": len(jobs), "completed": [], "errors": []}
        results = []
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            pending = {pool.submit(download_job, job, key, bbox, geometry, boundary_hash, cache, args.refresh): job for job in jobs}
            for future in as_completed(pending):
                job = pending[future]
                try:
                    result = future.result()
                    results.append(result)
                    manifest["completed"].append(result)
                except firms.FirmsError as error:
                    manifest["errors"].append({"job": job, "error": str(error)})
                    print(str(error), file=sys.stderr, flush=True)
                if (len(results) + len(manifest["errors"])) % 10 == 0:
                    print(f"Completed {len(results)}/{len(jobs)}; errors {len(manifest['errors'])}", flush=True)
                (output / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
        if manifest["errors"]:
            manifest["status"] = "incomplete"
            (output / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
            raise firms.FirmsError("Some downloads failed; rerun to resume from the verified cache.")
        summary = summarize(results, available, args.start, args.end, output)
        manifest["status"] = "complete"
        manifest["completed_at"] = datetime.now(timezone.utc).isoformat()
        (output / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
        print("History complete:", json.dumps(summary["totals_by_source"], ensure_ascii=False), flush=True)
        return 0
    except (firms.FirmsError, OSError) as error:
        print(f"History error: {error}", file=sys.stderr, flush=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())
