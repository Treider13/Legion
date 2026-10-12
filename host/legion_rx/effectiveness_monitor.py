"""EffectivenessMonitor — контроль эффективности помехи (фаза 4 ТЗ).

Метрика — PDR-прокси: доля наблюдаемых всплесков от ожидаемых.
Декодирования пакетов нет: выживаемость всплесков, не протокольный PDR.
FER = 1 − PDR_proxy.
"""
from __future__ import annotations


class EffectivenessMonitor:
    def __init__(self, pdr_floor: float = 0.5, pdr_high: float = 0.8,
                 window: int = 32):
        self.floor = float(pdr_floor)
        self.high = float(pdr_high)
        self.window = int(window)
        self._exp: list[float] = []
        self._obs: list[float] = []
        self.jams_applied = 0

    def update(self, expected: float, observed: float) -> None:
        e = max(0.0, float(expected))
        o = max(0.0, float(observed))
        self._exp.append(e)
        self._obs.append(o)
        self._exp = self._exp[-self.window:]
        self._obs = self._obs[-self.window:]

    def mark_jam_applied(self) -> None:
        self.jams_applied += 1

    @property
    def pdr(self) -> "float | None":
        e = sum(self._exp)
        return sum(self._obs) / max(e, 1e-9)

    @property
    def fer(self) -> "float | None":
        p = self.pdr
        return None if p is None else 1.0 - p

    def evaluate(self) -> dict:
        p = self.pdr
        if self.jams_applied == 0:
            verdict = "unknown"
        elif p < self.floor:
            verdict = "effective"
        elif p > self.high:
            verdict = "ineffective"
        else:
            verdict = "marginal"
        return {"verdict": verdict, "pdr_target": p, "fer_target": self.fer,
                "jams_applied": self.jams_applied,
                "window": len(self._exp)}
