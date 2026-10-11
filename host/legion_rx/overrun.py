"""OverrunMonitor — шаг 3.9: опрос `rx status` каждые 100 мс в той же
сессии bladeRF-cli + счётчик асинхронных overrun-строк из stdout.

Двойной канал истины:
  1. poll: поле overruns из rx status (если версия CLI его печатает);
  2. async: строки CLI «RX: overrun …», ловимые фоном (BladerfCliSession).
Жёсткая физическая проверка — отдельно: FifoSource.bytes_read за 60 с
должен равняться 80 МБ/с × 60 с (пропавшие сэмплы = пропавшие байты).
"""
from __future__ import annotations

import json
import threading
import time

from .cli_session import BladerfCliSession, CliError

POLL_S = 0.1  # шаг 3.9: каждые 100 мс


class OverrunMonitor:
    def __init__(self, session: BladerfCliSession, log_path: "str | None" = None,
                 poll_s: float = POLL_S):
        self._s = session
        self._poll_s = float(poll_s)
        self._log = open(log_path, "a", buffering=1) if log_path else None
        self.total_overruns = 0
        self.total_underruns = 0
        self.async_events = 0
        self.poll_count = 0
        self.poll_errors = 0
        self.samples: list[dict] = []
        self._stop = threading.Event()
        self._th = threading.Thread(target=self._run, daemon=True,
                                    name="overrun-monitor")

    def start(self) -> None:
        self._th.start()

    def stop(self) -> None:
        self._stop.set()
        self._th.join(timeout=3.0)
        if self._log:
            self._log.close()

    def _record(self, rec: dict) -> None:
        self.samples.append(rec)
        if self._log:
            self._log.write(json.dumps(rec, ensure_ascii=False) + "\n")

    def _run(self) -> None:
        t0 = time.perf_counter()
        while not self._stop.is_set():
            # Асинхронные строки CLI — независимый канал (считаем ВСЕГДА).
            for _ in self._s.take_async_events():
                self.async_events += 1
                self._record({"t": round(time.perf_counter() - t0, 3),
                              "kind": "async_overrun_line"})
            try:
                st = self._s.rx_status()
                self.poll_count += 1
                rec = {"t": round(time.perf_counter() - t0, 3),
                       "kind": "poll", "state": st.get("state"),
                       "overruns": st.get("overruns"),
                       "underruns": st.get("underruns")}
                self._record(rec)
                # Дельта по нарастающему счётчику CLI; None (нет поля в
                # формате) — пропускаем, остаётся async-канал + байты.
                ov, un = st.get("overruns"), st.get("underruns")
                if ov is not None:
                    self.total_overruns = max(self.total_overruns, int(ov))
                if un is not None:
                    self.total_underruns = max(self.total_underruns, int(un))
            except CliError:
                self.poll_errors += 1
            self._stop.wait(self._poll_s)

    def verdict(self) -> dict:
        """Критерий 3.10: overruns == 0. Async-строки = факт overrun'а,
        даже если версия CLI счётчик в status не печатает."""
        return {
            "overruns_poll": self.total_overruns,
            "overruns_async_lines": self.async_events,
            "overruns_total": self.total_overruns + self.async_events,
            "poll_count": self.poll_count,
            "poll_errors": self.poll_errors,
            "ok": (self.total_overruns + self.async_events) == 0,
        }
