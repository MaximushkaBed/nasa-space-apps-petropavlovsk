"""Package a completed atlas calendar and its matching matrix from the analysis API."""

import argparse
import gzip
import json
from pathlib import Path
import re
from urllib.request import urlopen


def completed(base, path, identifier):
    if not re.fullmatch(r"[0-9a-f]{32}", identifier):
        raise ValueError(f"Invalid job ID: {identifier}")
    with urlopen(f"{base}/api/v1/{path}/{identifier}", timeout=45) as response:
        job = json.load(response)
    if job.get("status") != "done":
        raise ValueError(f"{path}/{identifier} is not complete")
    return job


def bundle(analysis, matrix, preset="world"):
    calendar, factors = analysis["result"], matrix["result"]
    grid_km = {"world": 250, "sko": 10}[preset]
    if (calendar["config"]["preset"] != preset or calendar["config"]["grid_km"] != grid_km
            or factors["analysis_id"] != analysis["id"]
            or any(calendar[key] != factors[key] for key in ("config", "snapshot_at", "extract_id"))):
        raise ValueError("The calendar and matrix must use the same archive snapshot, area and settings")
    calendar_keys = ("config", "extract_id", "snapshot_at", "calculated_at", "monthly")
    row_keys = ("month", "platform", "eligible_days", "cells", "points", "anomaly_pct")
    reduced = {key: calendar[key] for key in calendar_keys}
    reduced["monthly"] = [{key: row[key] for key in row_keys} for row in calendar["monthly"]]
    return {
        "analysis": {"id": analysis["id"], "result": reduced},
        "matrix": {"id": matrix["id"], "result": factors},
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="https://nasa.aican.cloud")
    parser.add_argument("--analysis-id", required=True)
    parser.add_argument("--matrix-id", required=True)
    parser.add_argument("--preset", choices=("world", "sko"), default="world")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    base = args.base_url.rstrip("/")
    data = bundle(completed(base, "analyses", args.analysis_id), completed(base, "matrices", args.matrix_id), args.preset)
    encoded = (json.dumps(data, ensure_ascii=False, allow_nan=False, indent=1) + "\n").encode()
    output = args.output or Path("web/data/world-atlas.json" if args.preset == "world" else "web/data/sko-study.json")
    temporary = output.with_suffix(".json.tmp")
    temporary.write_bytes(encoded)
    temporary.replace(output)
    compressed = output.with_suffix(".json.gz")
    temporary = compressed.with_suffix(".gz.tmp")
    temporary.write_bytes(gzip.compress(encoded, mtime=0))
    temporary.replace(compressed)
