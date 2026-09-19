"""Validation of diagnostic evidence; no device access or hardware emulation."""
from __future__ import annotations

from collections import Counter
import json

REQUIRED_STAGES = tuple(f"E{i}" for i in range(1, 7))
CHECK_STATUSES = frozenset({"PASS", "FAIL", "ERROR", "UNKNOWN", "SKIP"})


def decode_report(text: str) -> object:
    """Reject ambiguous JSON instead of silently keeping the last duplicate key."""
    def unique_object(pairs: list[tuple[str, object]]) -> dict:
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f"повторяющийся ключ JSON: {key}")
            result[key] = value
        return result

    def invalid_constant(value: str) -> None:
        raise ValueError(f"недопустимое значение JSON: {value}")

    return json.loads(text, object_pairs_hook=unique_object,
                      parse_constant=invalid_constant)


def _same_typed_value(actual: object, expected: object) -> bool:
    """JSON booleans and floats must not impersonate integer counters."""
    if type(actual) is not type(expected):
        return False
    if isinstance(expected, dict):
        return (actual.keys() == expected.keys()
                and all(_same_typed_value(actual[key], value)
                        for key, value in expected.items()))
    if isinstance(expected, list):
        return (len(actual) == len(expected)
                and all(_same_typed_value(a, b) for a, b in zip(actual, expected)))
    return actual == expected


def gateway_identity(reply: object) -> tuple[bool | None, str]:
    """A reachable gateway alone is not evidence of a real Legion device."""
    if not isinstance(reply, dict) or reply.get("ok") is not True:
        return None, "нет успешного ответа шлюза"
    if reply.get("fake") is True:
        return False, "эмулятор не допускается к аппаратной приёмке"
    if reply.get("fake") is not False:
        return None, "шлюз не сообщил достоверный признак fake=false"
    if reply.get("legion") is False:
        return False, "шлюз не обнаружил интерфейс Legion"
    if reply.get("legion") is not True:
        return None, "наличие интерфейса Legion не подтверждено"
    if reply.get("board") not in ("bladerf1", "bladerf2"):
        return None, "тип платы не подтверждён"
    return True, "подтверждён ответ реального шлюза с интерфейсом Legion; не идентичность образа"


def boolean_evidence(reply: object, field: str, expected: bool) -> tuple[bool | None, str]:
    """Missing, failed or malformed telemetry remains unknown, never healthy."""
    if not isinstance(reply, dict) or reply.get("ok") is not True:
        return None, "нет успешного ответа телеметрии"
    value = reply.get(field)
    if type(value) is not bool:
        return None, f"поле {field} отсутствует или не имеет булев тип"
    return value is expected, f"{field}={value}; ожидалось {expected}"


def summarize(checks: list[dict]) -> dict:
    counts: Counter = Counter()
    seen: set[str] = set()
    for item in checks:
        if not isinstance(item, dict):
            counts["ERROR"] += 1
            continue
        status = item.get("status")
        stage = item.get("stage")
        if (not isinstance(status, str) or status not in CHECK_STATUSES
                or not isinstance(stage, str) or stage not in REQUIRED_STAGES
                or item.get("ok") is not (status == "PASS")):
            counts["ERROR"] += 1
            continue
        counts[status] += 1
        seen.add(stage)
    missing = [stage for stage in REQUIRED_STAGES if stage not in seen]
    failed = counts["FAIL"] + counts["ERROR"]
    complete = not missing and not counts["UNKNOWN"] and not counts["SKIP"]
    status = "FAILED" if failed else "PASSED" if complete else "INCOMPLETE"
    return {
        "schema_version": 2,
        "status": status,
        "ok": status == "PASSED",
        "complete": complete,
        "fails": failed,
        "counts": {key: counts[key] for key in sorted(CHECK_STATUSES)},
        "required_stages": list(REQUIRED_STAGES),
        "missing_stages": missing,
    }


def complete_report_error(report: object) -> str | None:
    """Validate recorded coverage, not authenticity of the physical measurements."""
    if (not isinstance(report, dict) or type(report.get("schema_version")) is not int
            or report.get("schema_version") != 2):
        return "нужен отчёт schema_version=2; старый ok=true не подтверждает полноту"
    checks = report.get("checks")
    if not isinstance(checks, list) or not checks:
        return "нет результатов отдельных проверок"
    expected = summarize(checks)
    for key, value in expected.items():
        if not _same_typed_value(report.get(key), value):
            return f"поле {key} не соответствует результатам проверок"
    if not expected["ok"]:
        return f"аппаратная приёмка не завершена успешно: {expected['status']}"
    return None


def main() -> int:
    import argparse
    import sys
    from pathlib import Path

    parser = argparse.ArgumentParser(description="Проверка полноты отчёта аппаратной приёмки")
    parser.add_argument("report", type=Path)
    args = parser.parse_args()
    try:
        report = decode_report(args.report.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        print(f"FAIL: отчёт не читается: {exc}", file=sys.stderr)
        return 2
    error = complete_report_error(report)
    if error:
        print(f"FAIL: {error}", file=sys.stderr)
        return 1
    print(f"ОТЧЁТ ПОЛНЫЙ: плата {report.get('board', '?')}, "
          f"время {report.get('ts', '?')}, проверок {len(report['checks'])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
