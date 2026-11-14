import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from scripts import watch_github as monitor


class WatchGithubTests(unittest.TestCase):
    def test_sync_reports_conflicting_local_edits_without_resetting(self):
        def git(*arguments):
            if arguments[0] == "symbolic-ref":
                return Mock(returncode=0, stdout="main\n")
            if arguments == ("rev-parse", "HEAD"):
                return Mock(returncode=0, stdout="old\n")
            if arguments[0] == "rev-parse":
                return Mock(returncode=0, stdout="new\n")
            if arguments[0] == "merge":
                self.assertIn("--ff-only", arguments)
                return Mock(returncode=1, stdout="")
            return Mock(returncode=0, stdout="")
        with tempfile.TemporaryDirectory() as directory, patch.object(monitor, "git_command", side_effect=git) as run:
            result = monitor.synchronize_checkout("new", Path(directory))
        self.assertEqual(result["status"], "local_changes_need_merge")
        self.assertEqual(result["local_sha"], "old")
        self.assertFalse(any(call.args[0] in ("reset", "checkout", "push", "stash") for call in run.call_args_list))

    def test_sync_saves_new_research_diff(self):
        def git(*arguments):
            if arguments[0] == "symbolic-ref":
                return Mock(returncode=0, stdout="main\n")
            if arguments[0] == "rev-parse":
                return Mock(returncode=0, stdout="new\n")
            if arguments[:2] == ("diff", "--name-only"):
                return Mock(returncode=0, stdout="docs/research.md\0app.py\0")
            if arguments[0] == "diff":
                return Mock(returncode=0, stdout="+Oksana research finding\n")
            return Mock(returncode=0, stdout="new Oksana: research update\n")
        with tempfile.TemporaryDirectory() as directory, patch.object(monitor, "git_command", side_effect=git):
            root = Path(directory)
            result = monitor.synchronize_checkout("old", root)
            self.assertEqual(result["research_files"], ["docs/research.md"])
            self.assertIn("Oksana research finding", (root / "latest-research.md").read_text())

    def test_branch_changes_and_deletion_are_recorded(self):
        before = {"branches": {"main": {"sha": "old"}, "feature": {"sha": "x"}}}
        after = {"branches": {"main": {"sha": "new"}, "other": {"sha": "y"}}}
        changes = monitor.differences(before, after)
        self.assertEqual({(item["id"], item["change"]) for item in changes},
                         {("main", "updated"), ("feature", "removed"), ("other", "added")})

    def test_event_feed_retention_is_not_reported_as_deletion(self):
        self.assertEqual(monitor.differences({"events": {"old": {}}}, {"events": {}}), [])

    def test_comment_edit_detected_without_storing_comment_body(self):
        before = monitor.record({"id": 1, "body": "old private comment"})
        after = monitor.record({"id": 1, "body": "edited private comment"})
        self.assertNotEqual(before, after)
        self.assertNotIn("body", before)
        self.assertNotIn("private comment", json.dumps(after))

    def test_github_commands_are_explicitly_read_only(self):
        with patch.object(monitor.subprocess, "run", return_value=Mock(returncode=0, stdout="[]")) as run:
            self.assertEqual(monitor.github_json("repos/owner/repo/issues", paginate=True), [[]])
        self.assertEqual(run.call_args.args[0][:4], ["gh", "api", "--method", "GET"])
        self.assertNotIn("--slurp", run.call_args.args[0])

    def test_paginated_responses_work_with_older_github_cli(self):
        response = Mock(returncode=0, stdout='[{"id":1}]\n[{"id":2}]\n')
        with patch.object(monitor.subprocess, "run", return_value=response):
            self.assertEqual(monitor.github_json("repos/owner/repo/issues", paginate=True),
                             [[{"id": 1}], [{"id": 2}]])

    def test_baseline_is_quiet_and_subsequent_change_is_logged(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(monitor, "snapshot") as snapshot:
            snapshot.side_effect = [{"branches": {"main": {"sha": "one"}}},
                                    {"branches": {"main": {"sha": "two"}}}]
            root = Path(directory)
            self.assertEqual(monitor.check_once("owner/repo", root), 0)
            self.assertFalse((root / "changes.jsonl").exists())
            self.assertEqual(monitor.check_once("owner/repo", root), 1)
            event = json.loads((root / "changes.jsonl").read_text())
            self.assertEqual(event["changes"][0]["after"]["sha"], "two")

    def test_failed_check_does_not_advance_baseline(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(monitor, "snapshot") as snapshot:
            root = Path(directory)
            snapshot.return_value = {"branches": {}}
            monitor.check_once("owner/repo", root)
            before = (root / "state.json").read_bytes()
            snapshot.side_effect = monitor.MonitorError("Temporary failure")
            with self.assertRaises(monitor.MonitorError):
                monitor.check_once("owner/repo", root)
            self.assertEqual((root / "state.json").read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
