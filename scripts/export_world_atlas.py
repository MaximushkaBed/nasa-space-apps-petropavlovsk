"""Package a completed world calendar and its matching matrix from the analysis API."""

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


def bundle(analysis, matrix):
    calendar, factors = analysis["result"], matrix["result"]
    if (calendar["config"]["preset"] != "world" or calendar["config"]["grid_km"] != 250
            or factors["analysis_id"] != analysis["id"]
            or any(calendar[key] != factors[key] for key in ("config", "snapshot_at", "extract_id"))):
        raise ValueError("The calendar and matrix must use the same world archive, geometry, and dates")
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
    parser.add_argument("--output", type=Path, default=Path("web/data/world-atlas.json"))
    args = parser.parse_args()
    base = args.base_url.rstrip("/")
    data = bundle(completed(base, "analyses", args.analysis_id), completed(base, "matrices", args.matrix_id))
    encoded = (json.dumps(data, ensure_ascii=False, allow_nan=False, indent=1) + "\n").encode()
    temporary = args.output.with_suffix(".json.tmp")
    temporary.write_bytes(encoded)
    temporary.replace(args.output)
    compressed = args.output.with_suffix(".json.gz")
    temporary = compressed.with_suffix(".gz.tmp")
    temporary.write_bytes(gzip.compress(encoded, mtime=0))
    temporary.replace(compressed)
