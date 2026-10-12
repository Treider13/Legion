"""Шаг 3.9–3.10 + [F3]/[F7]: эскалация при overrun, poll_errors в verdict."""
import time

from legion_rx.cli_session import CliError
from legion_rx.overrun import OverrunMonitor


class _FakeSession:
    """Сессия-заглушка: overrun'ы растут на step с каждым poll."""
    def __init__(self, step=5, fail=False):
        self.step = step
        self.fail = fail
        self.total = 0

    def take_async_events(self):
        return []

    def rx_status(self):
        if self.fail:
            raise CliError("rx status: сессия умерла")
        self.total += self.step
        return {"state": "running", "overruns": self.total,
                "underruns": 0, "raw": f"Overruns: {self.total}"}


def test_escalation_fires_over_threshold():
    fired = []
    mon = OverrunMonitor(_FakeSession(step=6), poll_s=0.01,
                         on_escalate=lambda total: fired.append(total),
                         escalate_threshold=10)
    mon.start()
    time.sleep(0.25)
    mon.stop()
    # 6/10 мс poll → 12, 18, 24… ≥ 10 дважды за 0.25 с
    assert fired, "эскалация не сработала при росте overrun'ов"
    assert fired[0] >= 10
    assert fired == sorted(fired)
    v = mon.verdict()
    assert v["overruns_total"] > 0
    assert v["ok"] is False
    assert v["escalations"] == len(fired)


def test_no_escalation_below_threshold():
    fired = []
    mon = OverrunMonitor(_FakeSession(step=1), poll_s=0.01,
                         on_escalate=lambda t: fired.append(t),
                         escalate_threshold=10)
    mon.start()
    time.sleep(0.08)
    mon.stop()
    assert fired == []


def test_poll_errors_enter_verdict():
    mon = OverrunMonitor(_FakeSession(fail=True), poll_s=0.01)
    mon.start()
    time.sleep(0.05)
    mon.stop()
    v = mon.verdict()
    assert v["poll_errors"] > 0
    assert v["ok"] is False  # [F7]: слепые окна — «0 overruns» недоказан
    assert v["error_texts"], "тексты ошибок потеряны"
    assert "сессия умерла" in v["error_texts"][0]


def test_clean_run_verdict_ok():
    mon = OverrunMonitor(_FakeSession(step=0), poll_s=0.01)
    mon.start()
    time.sleep(0.05)
    mon.stop()
    v = mon.verdict()
    assert v["overruns_total"] == 0
    assert v["poll_errors"] == 0
    assert v["ok"] is True
