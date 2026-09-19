"""Real Git subprocess tests in temporary repos; no device access or emulation."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

from acceptance_report import summarize


class ReportGitTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="legion-report-git-")
        self.addCleanup(self.directory.cleanup)
        self.base = Path(self.directory.name)
        self.repo = self.base / "repo"
        self.repo.mkdir()
        self.env = {key: value for key, value in os.environ.items()
                    if not key.startswith("GIT_")}
        self.env.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull,
                        PYTHONDONTWRITEBYTECODE="1")
        self.git("init", "-q")
        self.git("config", "user.name", "Diagnostic Test")
        self.git("config", "user.email", "diagnostic-test@example.invalid")
        source = Path(__file__).parent
        for name in ("run_acceptance_and_commit.sh", "acceptance_report.py"):
            target = self.repo / "fpga/test" / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source / name, target)
        self.git("add", ".")
        self.git("commit", "-qm", "Test harness; not hardware evidence")

    def git(self, *arguments):
        return subprocess.run(["git", *arguments], cwd=self.repo, env=self.env,
                              capture_output=True, text=True, timeout=15, check=True)

    def report(self, name="report.json"):
        # Input to the report parser, not a fabricated measurement from a board.
        rows = [{"stage": f"E{i}", "name": "parser input; not hardware evidence",
                 "status": "PASS", "ok": True} for i in range(1, 7)]
        (self.repo / name).write_text(json.dumps({**summarize(rows), "checks": rows}))
        return name

    def test_parallel_staging_cannot_enter_report_commit(self):
        name = self.report()
        other_path = self.repo / "unrelated.txt"
        other_path.write_text("Independent edit\n")
        entered, release = self.base / "entered", self.base / "release"
        hook = self.repo / ".git/hooks/pre-commit"
        hook.write_text(
            "#!" + sys.executable + "\nimport time\nfrom pathlib import Path\n"
            f"Path({str(entered)!r}).touch()\n"
            "deadline = time.monotonic() + 15\n"
            f"while not Path({str(release)!r}).exists():\n"
            "    if time.monotonic() > deadline: raise SystemExit(1)\n"
            "    time.sleep(0.01)\n")
        hook.chmod(0o755)
        process = subprocess.Popen(
            ["bash", "fpga/test/run_acceptance_and_commit.sh", "--commit-only", name],
            cwd=self.repo, env=self.env, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True)
        try:
            deadline = time.monotonic() + 15
            while not entered.exists():
                self.assertIsNone(process.poll(), "commit stopped before hook")
                self.assertLess(time.monotonic(), deadline, "hook timeout")
                time.sleep(0.01)
            other = subprocess.run(["git", "add", "unrelated.txt"], cwd=self.repo,
                                   env=self.env, capture_output=True, text=True, timeout=10)
            # Git may hold index.lock while committing the selected paths.
            if other.returncode:
                self.assertIn("index.lock", other.stderr)
            release.touch()
            stdout, stderr = process.communicate(timeout=15)
            self.assertEqual(process.returncode, 0, stdout + stderr)
            committed = self.git("diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD").stdout.splitlines()
            self.assertEqual(committed, [name])
            self.assertEqual(other_path.read_text(), "Independent edit\n")
            self.git("add", "unrelated.txt")
            self.assertEqual(self.git("diff", "--cached", "--name-only").stdout.strip(), "unrelated.txt")
        finally:
            release.touch()
            if process.poll() is None:
                process.kill()
                process.communicate()

    def test_report_filename_is_literal_and_shell_safe(self):
        name = self.report("report [1] 'quoted'.json")
        result = subprocess.run(
            ["bash", "fpga/test/run_acceptance_and_commit.sh", "--commit-only", name],
            cwd=self.repo, env=self.env, capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.git("diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD").stdout.strip(), name)


if __name__ == "__main__":
    unittest.main()
