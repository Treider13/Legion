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
                 poll_s: float = POLL_S,
                 on_escalate=None, escalate_threshold: int = 10):
        """on_escalate(total) — реакция [F3]: вызывается из потока монитора,
        когда нарастающий счёт overrun'ов превышает escalate_threshold сверх
        уже обработанных. None — только подсчёт (старый режим)."""
        self._s = session
        self._poll_s = float(poll_s)
        self._log = open(log_path, "a", buffering=1) if log_path else None
        self._on_escalate = on_escalate
        self._threshold = int(escalate_threshold)
        self._escalated_upto = 0
        self.escalation_count = 0
        self.total_overruns = 0
        self.total_underruns = 0
        self.async_events = 0
        self.poll_count = 0
        self.poll_errors = 0
        self.error_texts: list[str] = []  # последние ≤20 текстов ошибок poll
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
            except CliError as e:
                self.poll_errors += 1
                self.error_texts.append(str(e)[:200])
                self.error_texts = self.error_texts[-20:]
                self._record({"t": round(time.perf_counter() - t0, 3),
                              "kind": "poll_error", "error": str(e)[:200]})
            self._maybe_escalate()
            self._stop.wait(self._poll_s)

    def _maybe_escalate(self) -> None:
        """Overrun'ы растут → эскалация [F3]. Каждый вызов — за новый порог."""
        if self._on_escalate is None:
            return
        total = self.total_overruns + self.async_events
        if total >= self._escalated_upto + self._threshold:
            self._escalated_upto = total
            self.escalation_count += 1
            try:
                self._on_escalate(total)
            except Exception as e:
                # Эскалация не обязана валить монитор — фиксируем.
                self._record({"kind": "escalate_error", "error": str(e)[:200]})

    def verdict(self) -> dict:
        """Критерий 3.10: overruns == 0 И опрос исправен [F7]: poll_errors>0
        означает слепые окна мониторинга — «0» тогда недоказан."""
        return {
            "overruns_poll": self.total_overruns,
            "overruns_async_lines": self.async_events,
            "overruns_total": self.total_overruns + self.async_events,
            "poll_count": self.poll_count,
            "poll_errors": self.poll_errors,
            "error_texts": list(self.error_texts),
            "escalations": self.escalation_count,
            "ok": (self.total_overruns + self.async_events) == 0
                  and self.poll_errors == 0,
        }
