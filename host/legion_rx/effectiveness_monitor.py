"""EffectivenessMonitor — контроль эффективности помехи (фаза 4 ТЗ).

Метрика — PDR-прокси цели: доля НАБЛЮДАЕМЫХ всплесков от ожидаемых по
паттерну (expected из плана помехи). Честно: декодирования пакетов нет —
это выживаемость всплесков в эфире, не протокольный PDR; FER = 1 − PDR_proxy.

  PDR_proxy > pdr_high после удара → jamming ineffective → adjust strategy.
  PDR_proxy < pdr_floor             → jamming effective  → поддерживать.
"""
from __future__ import annotations


class EffectivenessMonitor:
    def __init__(self, pdr_floor: float = 0.5, pdr_high: float = 0.8,
                 window: int = 32):
        self.floor = float(pdr_floor)
        self.high = float(pdr_high)
        self.window = int(window)
        self._exp: list[int] = []
        self._obs: list[int] = []
        self.jams_applied = 0

    def update(self, expected: int, observed: int) -> None:
        """Тик контроля: expected — всплесков по плану, observed — видимых."""
        self._exp.append(max(0, int(expected)))
        self._obs.append(max(0, min(int(observed), int(expected))))
        self._exp = self._exp[-self.window:]
        self._obs = self._obs[-self.window:]

    def mark_jam_applied(self) -> None:
        self.jams_applied += 1

    @property
    def pdr(self) -> "float | None":
        e = sum(self._exp)
        if e <= 0:
            return None
        return sum(self._obs) / e

    @property
    def fer(self) -> "float | None":
        p = self.pdr
        return None if p is None else 1.0 - p

    def evaluate(self) -> dict:
        """effective/ineffective/unknown + PDR/FER для лога и FSM."""
        p = self.pdr
        if p is None or self.jams_applied == 0:
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
