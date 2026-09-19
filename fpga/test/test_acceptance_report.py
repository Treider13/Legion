"""Tests of report data validation only; no gateway, simulator or device model."""
from __future__ import annotations

import copy
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from acceptance_report import (
    REQUIRED_STAGES, boolean_evidence, complete_report_error, decode_report,
    gateway_identity, summarize,
)


def check_rows() -> list[dict]:
    # Parser input, not a claimed hardware measurement or an emulated device.
    return [{"stage": stage, "name": "schema input", "status": "PASS", "ok": True}
            for stage in REQUIRED_STAGES]


class ReportValidationTests(unittest.TestCase):
    def test_gateway_requires_explicit_identity_fields(self):
        fields = {"ok": True, "fake": False, "legion": True, "board": "bladerf2"}
        self.assertIs(gateway_identity(fields)[0], True)
        for key in fields:
            with self.subTest(missing=key):
                incomplete = dict(fields)
                del incomplete[key]
                self.assertIs(gateway_identity(incomplete)[0], None)

    def test_gateway_rejects_emulation_and_wrong_interface(self):
        fields = {"ok": True, "fake": False, "legion": True, "board": "bladerf1"}
        for change in ({"fake": True}, {"legion": False}):
            self.assertIs(gateway_identity({**fields, **change})[0], False)

    def test_gateway_does_not_coerce_strings_numbers_or_invalid_reply(self):
        fields = {"ok": True, "fake": False, "legion": True, "board": "bladerf1"}
        for key, value in (("fake", 0), ("fake", "false"), ("legion", 1),
                           ("legion", "true"), ("board", []), ("ok", 1)):
            self.assertIs(gateway_identity({**fields, key: value})[0], None)
        for reply in (None, [], "ok", 1):
            self.assertIs(gateway_identity(reply)[0], None)

    def test_watchdog_missing_or_failed_response_is_unknown(self):
        for reply in ({}, {"ok": False, "wd_fired": False}, {"ok": True}, None):
            for expected in (False, True):
                self.assertIs(boolean_evidence(reply, "wd_fired", expected)[0], None)

    def test_watchdog_only_accepts_boolean_measurements(self):
        for value in (None, 0, 1, "false", "true", [], {}):
            self.assertIs(boolean_evidence({"ok": True, "wd_fired": value},
                                           "wd_fired", False)[0], None)
        for actual in (True, False):
            for expected in (True, False):
                self.assertIs(boolean_evidence({"ok": True, "wd_fired": actual},
                                               "wd_fired", expected)[0], actual is expected)

    def test_empty_run_is_incomplete(self):
        result = summarize([])
        self.assertFalse(result["ok"])
        self.assertFalse(result["complete"])
        self.assertEqual(result["status"], "INCOMPLETE")
        self.assertEqual(result["missing_stages"], list(REQUIRED_STAGES))

    def test_missing_e6_cannot_pass(self):
        result = summarize(check_rows()[:-1])
        self.assertEqual(result["status"], "INCOMPLETE")
        self.assertEqual(result["missing_stages"], ["E6"])

    def test_skipped_or_unknown_e6_cannot_pass(self):
        for status in ("SKIP", "UNKNOWN"):
            rows = check_rows()
            rows[-1].update(status=status, ok=False)
            result = summarize(rows)
            self.assertEqual(result["status"], "INCOMPLETE")
            self.assertFalse(result["ok"])
            self.assertFalse(result["complete"])
            self.assertEqual(result["counts"][status], 1)

    def test_error_or_failure_takes_precedence(self):
        for status in ("FAIL", "ERROR"):
            rows = check_rows()
            rows[0].update(status=status, ok=False)
            rows[-1].update(status="UNKNOWN", ok=False)
            result = summarize(rows)
            self.assertEqual(result["status"], "FAILED")
            self.assertEqual(result["fails"], 1)

    def test_invalid_rows_cannot_become_success(self):
        for row in (None, {}, {"stage": "E1", "status": [], "ok": True},
                    {"stage": [], "status": "PASS", "ok": True},
                    {"stage": "E1", "status": "PASS", "ok": 1},
                    {"stage": "E1", "status": "SKIP", "ok": True}):
            result = summarize(check_rows() + [row])
            self.assertFalse(result["ok"])
            self.assertEqual(result["counts"]["ERROR"], 1)

    def test_old_green_reports_are_not_accepted(self):
        for report in ({"ok": True}, {"ok": True, "checks": []}, None, []):
            self.assertIsNotNone(complete_report_error(report))

    def test_consistent_complete_schema_roundtrips(self):
        rows = check_rows()
        report = {**summarize(rows), "checks": rows}
        self.assertIsNone(complete_report_error(json.loads(json.dumps(report))))

    def test_incomplete_report_cannot_be_relabelled_green(self):
        rows = check_rows()[:-1]
        report = {**summarize(rows), "checks": rows, "ok": True,
                  "status": "PASSED", "complete": True}
        self.assertIsNotNone(complete_report_error(report))

    def test_summary_must_match_details(self):
        rows = check_rows()
        original = {**summarize(rows), "checks": rows}
        for field, value in (("fails", 1), ("fails", False), ("ok", 1),
                             ("schema_version", 2.0), ("required_stages", []),
                             ("counts", {}), ("missing_stages", ["E1"])):
            report = copy.deepcopy(original)
            report[field] = value
            self.assertIsNotNone(complete_report_error(report), field)

    def test_nested_counters_require_exact_integer_types(self):
        rows = check_rows()
        original = {**summarize(rows), "checks": rows}
        for key, value in (("FAIL", False), ("ERROR", 0.0), ("PASS", 6.0),
                           ("UNKNOWN", "0"), ("SKIP", None)):
            report = copy.deepcopy(original)
            report["counts"][key] = value
            self.assertIsNotNone(complete_report_error(report), (key, value))

    def test_duplicate_json_keys_are_rejected_at_any_depth(self):
        for text in ('{"ok":false,"ok":true}',
                     '{"counts":{"FAIL":1,"FAIL":0}}',
                     '{"checks":[{"status":"FAIL","status":"PASS"}]}'):
            with self.assertRaisesRegex(ValueError, "повторяющийся ключ"):
                decode_report(text)

    def test_non_json_constants_are_rejected(self):
        for value in ("NaN", "Infinity", "-Infinity"):
            with self.assertRaisesRegex(ValueError, "недопустимое значение"):
                decode_report('{"value":' + value + '}')

    def test_shell_wrapper_rejects_missing_gateway_before_device_access(self):
        script = Path(__file__).with_name("run_acceptance.sh")
        for arguments in (("--gw",), ("--gw", ""), ("--gw", "--skip-e6")):
            result = subprocess.run(["bash", str(script), *arguments],
                                    capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 2)
            self.assertIn("--gw требует адрес", result.stderr)
            self.assertNotIn("предусловия", result.stdout)

    def test_validator_cli_rejects_contradictory_duplicate_keys(self):
        rows = check_rows()
        data = json.dumps({**summarize(rows), "checks": rows})
        data = data.replace('"ok": true', '"ok": false, "ok": true', 1)
        script = Path(__file__).with_name("acceptance_report.py")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "ambiguous-report.json"
            path.write_text(data, encoding="utf-8")
            result = subprocess.run([sys.executable, str(script), str(path)],
                                    capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 2)
            self.assertIn("повторяющийся ключ", result.stderr)

    def test_validator_cli_rejects_old_report_and_invalid_json(self):
        script = Path(__file__).with_name("acceptance_report.py")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "report 'quoted'.json"
            for content, expected_code in (("{", 2), ('{"ok": true}', 1)):
                path.write_text(content, encoding="utf-8")
                result = subprocess.run([sys.executable, str(script), str(path)],
                                        capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode, expected_code)
                self.assertIn("FAIL:", result.stderr)


if __name__ == "__main__":
    unittest.main()
