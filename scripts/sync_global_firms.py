"""Keep a persistent worldwide FIRMS GeoParquet mirror on the shared server.

Source metadata are retained, but actual Parquet footers determine row counts and
coverage. No regional calibration is applied. Requires requirements-global.txt.
"""

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
import time
from urllib.parse import urljoin, urlparse
from urllib.request import Request, urlopen

UPSTREAM = "https://data.source.coop/portolan-mirrors/firms-catalog/"


def now():
    return datetime.now(timezone.utc).isoformat()


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
        temporary = Path(handle.name)
    temporary.chmod(0o644)
    temporary.replace(path)


def source_json(url):
    validate_source(url)
    with urlopen(url, timeout=60) as response:
        return json.load(response)


def validate_source(url):
    parsed = urlparse(url)
    if parsed.scheme != "https" or parsed.hostname != "data.source.coop":
        raise ValueError("Unexpected source host in the upstream catalog")


def make_plan(collection, items, live=True):
    jobs = []
    for item in sorted(items, key=lambda value: value["id"]):
        year = int(item["id"])
        base = f"{UPSTREAM}detections/year={year}/{year}.json"
        for key in ("data", "aggregate-r5", "aggregate-r8"):
            asset = item["assets"].get(key)
            if asset is None:
                if key == "data":
                    raise ValueError(f"Missing observations for {year}")
                continue  # Aggregates are optional, including in the current year.
            kind = "observations" if key == "data" else "aggregate"
            filename = "detections.parquet" if key == "data" else key + ".parquet"
            jobs.append({"path": f"{kind}/year={year}/{filename}", "kind": kind, "year": year,
                         "source_url": urljoin(base, asset["href"]),
                         "declared_size": asset.get("file:size"),
                         "declared_rows": item["properties"].get("table:row_count") if key == "data" else None})
    for key in ("aggregate-r5", "aggregate-r8", "aggregate-r10"):
        if asset := collection.get("assets", {}).get(key):
            jobs.append({"path": f"aggregate/alltime-{key.rsplit('-', 1)[1]}.parquet", "kind": "aggregate",
                         "year": None, "source_url": urljoin(UPSTREAM + "detections/collection.json", asset["href"])})
    if live and items:
        year = max(int(item["id"]) for item in items)
        jobs.append({"path": f"live/year={year}/live.parquet", "kind": "live", "year": year,
                     "source_url": f"{UPSTREAM}detections/year={year}/live.parquet"})
    for job in jobs:
        validate_source(job["source_url"])
    return jobs


def head_source(url):
    validate_source(url)
    with urlopen(Request(url, method="HEAD"), timeout=60) as response:
        return {"size": int(response.headers["Content-Length"]), "etag": response.headers.get("ETag"),
                "last_modified": response.headers.get("Last-Modified")}


def connection():
    import duckdb
    con = duckdb.connect()
    con.execute("SET threads=1")
    con.execute("SET memory_limit='512MB'")
    con.execute("SET enable_progress_bar=false")
    return con


def parquet_info(path, kind):
    con = connection()
    try:
        rows, groups = con.execute("SELECT num_rows,num_row_groups FROM parquet_file_metadata(?)", [str(path)]).fetchone()
        columns = con.execute("DESCRIBE SELECT * FROM read_parquet(?, hive_partitioning=false)", [str(path)]).fetchall()
        names = {row[0] for row in columns}
        result = {"rows": rows, "row_groups": groups,
                  "columns": [{"name": row[0], "type": row[1]} for row in columns]}
        if kind in ("observations", "live"):
            if not {"acq_datetime", "sensor", "satellite", "quality", "geometry", "version"}.issubset(names):
                raise ValueError("Unexpected observation schema")
            first, last = con.execute(
                "SELECT min(try_cast(stats_min_value AS TIMESTAMP)),max(try_cast(stats_max_value AS TIMESTAMP)) "
                "FROM parquet_metadata(?) WHERE path_in_schema='acq_datetime'", [str(path)]).fetchone()
            if rows and (first is None or last is None):
                raise ValueError("Missing actual temporal coverage in Parquet footer")
            result.update(start=first.isoformat() + "Z" if first else None,
                          end=last.isoformat() + "Z" if last else None)
        else:
            result["sensor_date_crosstab"] = False
        return result
    finally:
        con.close()


def download(root, job, previous=None):
    path = root / job["path"]
    path.parent.mkdir(parents=True, exist_ok=True)
    source = head_source(job["source_url"])
    if (previous and path.is_file() and path.stat().st_size == source["size"] == previous.get("size")
            and source["etag"] and source["etag"] == previous.get("upstream_etag")):
        return {**previous, "checked_at": now()}
    if shutil.disk_usage(root).free < source["size"] + 2 * 1024**3:
        raise RuntimeError("Less than 2 GiB would remain after this download")
    part = path.with_suffix(".parquet.part")
    headers = {"User-Agent": "NASA-Space-Apps-Petropavlovsk/1.0"}
    if source["etag"]:
        headers["If-Match"] = source["etag"]
    digest = hashlib.sha256()
    size = 0
    with urlopen(Request(job["source_url"], headers=headers), timeout=120) as response, part.open("wb") as handle:
        if source["etag"] and response.headers.get("ETag") != source["etag"]:
            raise RuntimeError("Source object changed during download")
        while block := response.read(4 * 1024**2):
            handle.write(block)
            digest.update(block)
            size += len(block)
    if size != source["size"]:
        raise RuntimeError("Incomplete source transfer")
    # Validate before replacing a previously usable snapshot.
    details = parquet_info(part, job["kind"])
    part.replace(path)
    return {**job, **details, "size": size, "sha256": digest.hexdigest(),
            "upstream_etag": source["etag"], "upstream_last_modified": source["last_modified"],
            "downloaded_at": now(), "checked_at": now()}


def retry_download(root, job, previous):
    for attempt in range(3):
        try:
            return download(root, job, previous)
        except Exception:
            if attempt == 2:
                raise
            time.sleep(2 ** attempt)


def build_live_tail(root, assets):
    """Keep only rolling detections absent from the yearly base; never sum overlaps.

    No spatial extension needed: DuckDB 2 supports native GEOMETRY equality.
    Publisher's detection identity is (sensor, acquisition time, geometry).
    """
    live = next((item for item in assets.values() if item["kind"] == "live"), None)
    if not live:
        return None
    base = assets.get(f"observations/year={live['year']}/detections.parquet")
    if not base:
        return None
    path = root / "derived/live-tail.parquet"
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".parquet.part")
    con = connection()
    try:
        con.execute("SET temp_directory=?", [str(root / "temporary")])
        # Filter the base to the rolling interval before the anti join.
        query = """COPY (
            WITH recent AS (
              SELECT * FROM read_parquet(?, hive_partitioning=false)
              QUALIFY row_number() OVER (
                PARTITION BY sensor, acq_datetime, geometry ORDER BY quality='SP' DESC, version DESC
              )=1
            )
            SELECT l.* FROM recent l ANTI JOIN
              (SELECT sensor,acq_datetime,geometry FROM read_parquet(?, hive_partitioning=false) WHERE acq_datetime>=?::TIMESTAMP) b
            ON l.sensor=b.sensor AND l.acq_datetime=b.acq_datetime AND l.geometry=b.geometry
        ) TO ? (FORMAT PARQUET, COMPRESSION ZSTD)"""
        con.execute(query, [str(root / live["path"]), str(root / base["path"]), live["start"], str(temporary)])
    finally:
        con.close()
    details = parquet_info(temporary, "observations")
    with temporary.open("rb") as handle:
        digest = hashlib.file_digest(handle, "sha256").hexdigest()
    temporary.replace(path)
    return {"path": str(path.relative_to(root)), "kind": "live_tail", **details,
            "size": path.stat().st_size, "sha256": digest, "created_at": now(),
            "base_sha256": base["sha256"], "live_sha256": live["sha256"],
            "identity": ["sensor", "acq_datetime", "geometry"]}


def public_catalog(state):
    fields = ("path", "kind", "year", "rows", "size", "sha256", "start", "end", "source_url")
    records = [{key: item[key] for key in fields if key in item}
               for item in state["assets"].values()]
    tail = state.get("live_tail")
    return {"scope": "world", "status": state["status"], "updated_at": state["updated_at"],
            "producer": state["producer"], "mirror": state["mirror"], "license": state["license"],
            "base_rows": state["observation_rows"], "incremental_rows": tail["rows"] if tail else None,
            "base_bytes": state["downloaded_bytes"], "notes": state["notes"], "errors": state["errors"],
            "assets": sorted(records, key=lambda item: item["path"]),
            "live_tail": {key: tail[key] for key in fields if key in tail} if tail else None}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=Path(os.environ.get("SPACEAPPS_DATA_DIR", "data/raw/firms/global")))
    parser.add_argument("--workers", type=int, choices=(1, 2), default=2)
    parser.add_argument("--years", type=int, nargs="+", help="Optional small smoke-test subset")
    args = parser.parse_args(argv)
    root = args.data_dir.resolve()
    root.mkdir(parents=True, exist_ok=True)
    with (root / ".sync.lock").open("w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print("A data sync is already running", flush=True)
            return 0
        return sync(root, args)


def sync(root, args):
    state_path = root / "manifest.json"
    previous = json.loads(state_path.read_text()) if state_path.exists() else {}
    collection_url = UPSTREAM + "detections/collection.json"
    collection = source_json(collection_url)
    atomic_json(root / "metadata/collection.json", collection)
    items = []
    for link in collection["links"]:
        if link["rel"] != "item":
            continue
        # STAC items are tiny; do not fetch raw data to inspect coverage.
        item = source_json(urljoin(collection_url, link["href"]))
        if args.years and int(item["id"]) not in args.years:
            continue
        items.append(item)
        atomic_json(root / f"metadata/{item['id']}.json", item)
    jobs = make_plan(collection, items, live=not args.years)
    state = {"status": "syncing", "scope": "world", "started_at": now(), "plan": jobs,
             "producer": "NASA LANCE FIRMS / ESDIS", "mirror": "Portolan / Source Cooperative",
             "upstream_catalog": UPSTREAM + "catalog.json", "license": "CC0-1.0",
             "assets": {}, "errors": [], "notes": [
                 "Detections are not individual fires or burned area; no global calibration applied.",
                 "STAC counts can lag actual files. Actual rows/coverage are read from Parquet footers.",
                 "Mirror NOAA-21 begins 2024-01-17; NASA SP begins 2023-03-01. Earlier data need separate backfill.",
                 "Aggregate files lack sensor-by-date cross-tabs. Use raw files for sensor-specific history.",
                 "Query yearly observations plus derived/live-tail.parquet, never plus unfiltered live.",
                 "NRT is preliminary; missing detections do not prove zero fire or clear-sky coverage."]}
    atomic_json(state_path, state)
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        pending = {pool.submit(retry_download, root, job, previous.get("assets", {}).get(job["path"])): job for job in jobs}
        for future in as_completed(pending):
            job = pending[future]
            try:
                state["assets"][job["path"]] = future.result()
                print(f"Verified {len(state['assets'])}/{len(jobs)}: {job['path']}", flush=True)
            except Exception as error:
                state["errors"].append({"path": job["path"], "error": str(error)})
                print(f"Failed {job['path']}: {error}", flush=True)
            state["updated_at"] = now()
            atomic_json(state_path, state)
    try:
        state["live_tail"] = build_live_tail(root, state["assets"])
    except Exception as error:
        state["errors"].append({"path": "derived/live-tail.parquet", "error": str(error)})
    state["status"] = "incomplete" if state["errors"] else "ready"
    state["updated_at"] = now()
    state["observation_rows"] = sum(item["rows"] for item in state["assets"].values() if item["kind"] == "observations")
    state["downloaded_bytes"] = sum(item["size"] for item in state["assets"].values())
    atomic_json(state_path, state)
    atomic_json(root / "catalog.json", public_catalog(state))
    print(f"Global sync {state['status']}: {state['observation_rows']:,} base rows", flush=True)
    return 1 if state["errors"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
