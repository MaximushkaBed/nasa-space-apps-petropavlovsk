"""Incremental global FIRMS calendar. Historical Parquet files are scanned once per revision."""

import calendar
from collections import defaultdict
from datetime import date
import hashlib
import json
from statistics import median
import time

import duckdb

from api.analysis import PLATFORMS, month_keys

VERSION = 2
DAY_CACHE_VERSION = 1  # Aggregation changes must not rescan the source Parquets.
CHECK_SECONDS = 60


def read_days(path):
    with duckdb.connect(config={"threads": 1, "memory_limit": "128MB"}) as con:
        return con.execute("""
            WITH observations AS (
                SELECT acq_datetime::DATE AS day,
                       CASE satellite WHEN 'Suomi NPP' THEN 'Suomi-NPP' ELSE satellite END AS platform,
                       lower(quality) = 'sp' AS standard,
                       (type = 0 OR type IS NULL)
                           AND coalesce(lower(confidence), '') NOT IN ('l', 'low')
                           AND coalesce(confidence_pct, 100) >= 30 AS accepted
                FROM read_parquet(?, hive_partitioning=false)
            )
            SELECT day::VARCHAR, platform,
                   count(*) FILTER (WHERE accepted),
                   count(*) FILTER (WHERE accepted AND standard IS NOT TRUE),
                   bool_or(standard)
            FROM observations WHERE platform IN (SELECT unnest(?::VARCHAR[]))
            GROUP BY 1,2 ORDER BY 1,2
        """, [str(path), list(PLATFORMS)]).fetchall()


def monthly_rows(datasets, first, through):
    days = {}
    for dataset in datasets:
        for day, platform, detections, nrt, standard in dataset:
            old_points, old_nrt, old_standard = days.get((day, platform), (0, 0, False))
            days[day, platform] = (old_points + detections, old_nrt + nrt, old_standard or standard)
    last = through[:10]
    month_days = defaultdict(dict)
    for (day, platform), counts in days.items():
        if first <= day <= last:
            month_days[day[:7], platform][int(day[8:])] = counts

    rows = []
    indexed = {}
    for month in month_keys(date.fromisoformat(first), date.fromisoformat(last)):
        year, number = map(int, month.split("-"))
        expected = calendar.monthrange(year, number)[1]
        partial = first > f"{month}-01" or last <= f"{month}-{expected:02}"
        for platform in PLATFORMS:
            observed = month_days[month, platform]
            n = len(observed)
            count = sum(obs[0] for obs in observed.values())
            nrt = sum(obs[1] for obs in observed.values())
            provisional = nrt > 0 or any(not standard for _, _, standard in observed.values())
            row = dict(month=month, platform=platform, points=count if n else None, eligible_days=n,
                       nrt_points=nrt, preliminary=provisional, partial=partial, anomaly_pct=None,
                       comparison_day_numbers=sorted(observed), baseline_year_ids=[], baseline_years=0,
                       comparison_status='insufficient_target_days')
            rows.append(row)
            indexed[year, number, platform] = observed
    for row in rows:
        year, month = map(int, row["month"].split("-"))
        if row['partial']:
            row['comparison_status']='partial_period'
            continue
        if row['preliminary']:
            row['comparison_status']='preliminary_data'
            continue
        if row["eligible_days"] < calendar.monthrange(year, month)[1] * .9:
            continue
        mask=row['comparison_day_numbers']
        comparable=[]
        for ref_year in range(2022,2025):
            if ref_year==year:continue
            reference=indexed.get((ref_year,month,row['platform']),{})
            # Missing reference dates are unknown, never implicit zeroes. Extra
            # historical dates (including Feb29) are outside the target mask.
            if not all(day in reference and reference[day][2] and reference[day][1]==0
                       and f'{ref_year}-{month:02}-{day:02}' < last for day in mask):continue
            comparable.append(sum(reference[day][0] for day in mask)/len(mask))
            row['baseline_year_ids'].append(ref_year)
        row['baseline_years']=len(comparable)
        row['comparison_status']='insufficient_baseline'
        if len(comparable)>=3:
            usual=median(comparable)
            row['comparison_status']='ok' if usual>0 else 'zero_baseline'
            if usual>0:row['anomaly_pct']=100*(row['points']/len(mask)/usual-1)
    return rows


def refresh(data, cache, pin, write, *, incremental=False):
    """Publish a complete snapshot atomically, holding stable source inodes during each refresh."""
    directory = cache / "world-calendar"
    destination = directory / "published.json"
    manifest = json.loads((data / "manifest.json").read_text())
    if manifest["status"] != "ready":
        return
    assets = [asset for asset in manifest["assets"].values() if asset["kind"] == "observations" and asset["rows"]]
    if not assets:
        return
    initial = min(asset["start"][:10] for asset in assets)
    latest = max(asset["end"][:10] for asset in assets)
    if (tail := manifest.get("live_tail")) and tail.get("rows"):
        latest = max(latest, tail["end"][:10])
    with pin({"start": initial, "end": latest}) as (state, sources):
        sources = [asset for asset in sources if asset["rows"] and asset.get("start") and asset.get("end")]
        if not sources:
            return
        keys = sorted({asset["sha256"] for asset in sources})
        fingerprint = hashlib.sha256(f"{VERSION}:{DAY_CACHE_VERSION}:{','.join(keys)}".encode()).hexdigest()
        if destination.exists() and json.loads(destination.read_bytes()).get("revision") == fingerprint:
            return
        used = set()
        datasets = []
        built = False
        for asset in sources:
            entry = directory / f"days-{DAY_CACHE_VERSION}-{asset['sha256']}.json"
            if entry not in used:
                if not entry.exists():
                    if incremental and built:
                        return True
                    write(entry, read_days(asset["fd"]))
                    built = True
                    print(f"World FIRMS calendar indexed {asset['path']}", flush=True)
                datasets.append(json.loads(entry.read_bytes()))
                used.add(entry)
        first = min(asset["start"][:10] for asset in sources)
        through = max(asset["end"] for asset in sources)
        write(destination, {
            "revision": fingerprint, "method_version": VERSION, "start": first, "end": through[:10], "through": through,
            "snapshot_at": state["updated_at"], "monthly": monthly_rows(datasets, first, through),
        })
        print(f"World FIRMS calendar published {first} .. {through}", flush=True)
        for path in directory.glob("days-*.json"):
            if path not in used:
                path.unlink(missing_ok=True)


def run(data, cache, pin, write):
    while True:
        try:
            if refresh(data, cache, pin, write, incremental=True):
                time.sleep(2)
                continue
        except (OSError, ValueError, KeyError, duckdb.Error) as error:
            print(f"World FIRMS calendar: {error}", flush=True)
        time.sleep(CHECK_SECONDS)
