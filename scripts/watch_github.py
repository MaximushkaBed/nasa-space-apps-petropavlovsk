#!/usr/bin/env python3
"""Read GitHub activity and record changes locally; never modify the repository."""

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import fcntl
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_REPO = "MaximushkaBed/nasa-space-apps-petropavlovsk"
ENDPOINTS = {
    "branches": "git/matching-refs/heads/",
    "tags": "git/matching-refs/tags/",
    "issues": "issues?state=all&sort=updated&per_page=100",
    "pull_requests": "pulls?state=all&sort=updated&per_page=100",
    "issue_comments": "issues/comments?per_page=100",
    "review_comments": "pulls/comments?per_page=100",
    "commit_comments": "comments?per_page=100",
    "releases": "releases?per_page=100",
    "actions": "actions/runs?per_page=100",
    "events": "events?per_page=100",
}


class MonitorError(Exception):
    pass


def github_json(path, paginate=False):
    command = ["gh", "api", "--method", "GET", path]
    if paginate:
        command.append("--paginate")
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=75)
    except (OSError, subprocess.TimeoutExpired):
        raise MonitorError("Cannot run GitHub CLI; check authentication and connectivity.") from None
    if result.returncode:
        raise MonitorError(f"GitHub read failed for {path.split('?')[0]} (exit {result.returncode}).")
    try:
        if not paginate:
            return json.loads(result.stdout)
        decoder = json.JSONDecoder()
        remaining = result.stdout.lstrip()
        pages = []
        while remaining:
            page, position = decoder.raw_decode(remaining)
            pages.append(page)
            remaining = remaining[position:].lstrip()
        return pages
    except json.JSONDecodeError:
        raise MonitorError("GitHub CLI returned invalid JSON.") from None


def record(item):
    """Keep reviewable metadata; hash comment bodies rather than copying them."""
    fields = (
        "id", "number", "ref", "title", "name", "state", "draft", "updated_at",
        "created_at", "published_at", "submitted_at", "merged_at", "html_url",
        "sha", "commit_id", "tag_name", "target_commitish", "prerelease",
        "status", "conclusion", "head_sha", "run_attempt", "type", "locked",
    )
    value = {key: item[key] for key in fields if key in item}
    for key in ("head", "base"):
        if key in item:
            value[key] = {field: item[key].get(field) for field in ("ref", "sha")}
    if "object" in item:
        value["object"] = {field: item["object"].get(field) for field in ("sha", "type")}
    if "labels" in item:
        value["labels"] = sorted(label["name"] for label in item["labels"])
    if "assignees" in item:
        value["assignees"] = sorted(user["login"] for user in item["assignees"])
    if "requested_reviewers" in item:
        value["requested_reviewers"] = sorted(user["login"] for user in item["requested_reviewers"])
    if "body" in item:
        value["body_sha256"] = hashlib.sha256((item["body"] or "").encode()).hexdigest()
    return value


def fetch_category(repo, category, endpoint):
    pages = github_json(f"repos/{repo}/{endpoint}", paginate=True)
    items = []
    for page in pages:
        items.extend(page["workflow_runs"] if category == "actions" else page)
    return category, {str(item.get("ref", item.get("id"))): record(item) for item in items}


def snapshot(repo):
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = [pool.submit(fetch_category, repo, name, path) for name, path in ENDPOINTS.items()]
        result = dict(future.result() for future in futures)
    repository = github_json(f"repos/{repo}")
    result["repository"] = {repo: {key: repository.get(key) for key in (
        "description", "visibility", "default_branch", "archived", "disabled",
        "has_issues", "has_wiki", "allow_forking", "homepage",
    )}}
    reviews = {}
    for pull_request in result["pull_requests"].values():
        number = pull_request["number"]
        pages = github_json(f"repos/{repo}/pulls/{number}/reviews?per_page=100", paginate=True)
        for page in pages:
            for review in page:
                reviews[str(review["id"])] = record(review)
    result["reviews"] = reviews
    return result


def differences(previous, current):
    changes = []
    for category, items in current.items():
        old_items = previous.get(category, {})
        for identifier, item in items.items():
            if identifier not in old_items:
                changes.append({"category": category, "change": "added", "id": identifier, "after": item})
            elif item != old_items[identifier]:
                changes.append({"category": category, "change": "updated", "id": identifier,
                                "before": old_items[identifier], "after": item})
        # GitHub's recent-events feed drops old entries as it ages. This is not deletion.
        if category != "events":
            for identifier in old_items.keys() - items.keys():
                changes.append({"category": category, "change": "removed", "id": identifier,
                                "before": old_items[identifier]})
    return changes


def atomic_json(path, value):
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as handle:
            temporary = Path(handle.name)
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        temporary.replace(path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def git_command(*arguments):
    try:
        return subprocess.run(["git", *arguments], cwd=ROOT, capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired):
        raise MonitorError("Cannot inspect or synchronize the local Git checkout.") from None


def synchronize_checkout(previous_tip, state_dir):
    branch = git_command("symbolic-ref", "--quiet", "--short", "HEAD")
    if branch.returncode:
        return {"status": "detached_head"}
    branch = branch.stdout.strip()
    local = git_command("rev-parse", "HEAD")
    fetched = git_command("fetch", "--prune", "origin")
    if local.returncode or fetched.returncode:
        raise MonitorError("Git fetch failed; local files were preserved.")
    target = git_command("rev-parse", f"refs/remotes/origin/{branch}")
    if target.returncode:
        return {"status": "no_remote_branch", "branch": branch}
    before, remote = local.stdout.strip(), target.stdout.strip()
    result = {"branch": branch, "local_sha": before, "remote_sha": remote, "status": "up_to_date"}
    if before != remote:
        if git_command("merge-base", "--is-ancestor", before, remote).returncode == 0:
            merge = git_command("merge", "--ff-only", "--no-edit", f"refs/remotes/origin/{branch}")
            result["status"] = "fast_forwarded" if merge.returncode == 0 else "local_changes_need_merge"
            if merge.returncode == 0:
                result["local_sha"] = remote
        elif git_command("merge-base", "--is-ancestor", remote, before).returncode == 0:
            result["status"] = "local_ahead"
        else:
            result["status"] = "branches_need_merge"
    old_tip = previous_tip or before
    if old_tip != remote:
        files = git_command("diff", "--name-only", "-z", old_tip, remote, "--")
        if files.returncode == 0:
            paths = [path for path in files.stdout.split("\0") if path]
            result["changed_files"] = paths
            research = [path for path in paths if Path(path).suffix.lower() in (".md", ".txt", ".rst")]
            if research:
                diff = git_command("diff", "--unified=3", old_tip, remote, "--", *research)
                commits = git_command("log", "--format=%h %an: %s", f"{old_tip}..{remote}")
                if diff.returncode == 0:
                    (state_dir / "latest-research.md").write_text(
                        f"# GitHub research changes\n\nRemote commit: {remote}\n\n"
                        + commits.stdout + "\n```diff\n" + diff.stdout[:60000] + "\n```\n",
                        encoding="utf-8",
                    )
                    result["research_files"] = research
    return result


def check_once(repo, state_dir, notify=False, sync=False):
    state_dir.mkdir(parents=True, exist_ok=True)
    with (state_dir / "monitor.lock").open("w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 0
        path = state_dir / "state.json"
        previous = json.loads(path.read_text()) if path.exists() else None
        if previous is not None and previous["repo"] != repo:
            raise MonitorError("State directory belongs to another repository; choose a different directory.")
        current = snapshot(repo)
        checkout = None
        if sync:
            checkout = synchronize_checkout((previous or {}).get("remote_sha"), state_dir)
            current["checkout"] = {"working_tree": checkout}
        now = datetime.now(timezone.utc).isoformat()
        changes = differences(previous["snapshot"], current) if previous else []
        if changes:
            entry = {"checked_at": now, "repo": repo, "changes": changes}
            with (state_dir / "changes.jsonl").open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(entry, ensure_ascii=False) + "\n")
            if notify and shutil.which("notify-send"):
                categories = ", ".join(sorted({change["category"] for change in changes}))
                try:
                    subprocess.run([
                        "notify-send", "NASA Space Apps — GitHub",
                        f"{len(changes)} changes: {categories}",
                    ], capture_output=True, timeout=10, check=False)
                except (OSError, subprocess.TimeoutExpired):
                    pass  # Desktop availability must not prevent saving the snapshot.
        atomic_json(path, {"repo": repo, "checked_at": now, "snapshot": current,
                           "remote_sha": checkout.get("remote_sha") if checkout else None})
        print(f"{now} {repo}: " + (f"{len(changes)} changes" if previous else "baseline saved"), flush=True)
        return len(changes)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", default=DEFAULT_REPO)
    parser.add_argument("--state-dir", type=Path, default=ROOT / "data/monitor/github")
    parser.add_argument("--notify", action="store_true", help="Notify the local desktop when changes are found")
    parser.add_argument("--sync", action="store_true", help="Fetch origin, inspect research changes, and fast-forward when safe")
    args = parser.parse_args(argv)
    try:
        check_once(args.repo, args.state_dir, args.notify, args.sync)
    except (MonitorError, OSError, ValueError, subprocess.TimeoutExpired) as error:
        print(f"Monitor error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
