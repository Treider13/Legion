"""Профили quick-tune после сужения пятна.

Пара RX+TX на стоянку, не больше 8. Слот кристалла — номер 0..7.
Скачок несущей больше 100 МГц или переход через 3 ГГц — не быстрый
профиль: полная калибровка, пауза удара.
Очередь retune — 16 мест. Пара занимает два. Доливать пачками.
Живой отзыв — libbladeRF schedule_retune по метке, не консоль.
"""
from __future__ import annotations

BAND_SPLIT_HZ = 3.0e9
FAST_MAX_HZ = 100.0e6
MAX_PAIRS = 8
QUEUE_SLOTS = 16


def band_of(hz: float) -> int:
    return 1 if float(hz) >= BAND_SPLIT_HZ else 0


def needs_full_cal(prev_hz: float, nxt_hz: float) -> bool:
    if abs(float(nxt_hz) - float(prev_hz)) > FAST_MAX_HZ:
        return True
    return band_of(prev_hz) != band_of(nxt_hz)


class ProfileCache:
    def __init__(self) -> None:
        self.pairs: list[dict] = []
        self.note = ""

    def store_after_narrow(self, fpga, centers_hz: list[float]) -> dict:
        """Таблица lo_khz в NIOS. Сам quick-tune снимает библиотека на плате."""
        centers = [float(c) for c in centers_hz][:MAX_PAIRS]
        self.pairs = []
        ok = True
        for i, lo in enumerate(centers):
            lo_khz = int(round(lo / 1000.0))
            one = fpga.store_profile_lo_khz(i, lo_khz) if fpga is not None else False
            ok = one and ok
            self.pairs.append({
                "slot": i,
                "lo_hz": lo,
                "lo_khz": lo_khz,
                "stored": bool(one),
            })
        dropped = max(0, len(centers_hz) - MAX_PAIRS)
        self.note = (
            f"пар {len(self.pairs)}, очередь {QUEUE_SLOTS} "
            f"(пара = 2 места). Снято после сужения."
        )
        if dropped:
            self.note += f" Слотов не хватило: {dropped}."
        return {"ok": ok, "n": len(self.pairs), "note": self.note}

    def batch_marks(self, scenario: list[tuple[int, int]],
                    dwell_s: float, t0_sample: int, fs_hz: float) -> list[dict]:
        """Метки, где стоянка меняется. Не больше 8 пар за пачку (16 мест)."""
        marks = []
        prev = None
        prev_lo = None
        fs = float(fs_hz)
        dwell = max(1, int(round(float(dwell_s) * fs)))
        for hop_i, win in scenario:
            if prev is not None and win == prev:
                continue
            lo = self.pairs[win]["lo_hz"] if win < len(self.pairs) else None
            full = False
            if lo is not None and prev_lo is not None:
                full = needs_full_cal(prev_lo, lo)
            marks.append({
                "hop": hop_i,
                "window": win,
                "sample": int(t0_sample) + hop_i * dwell,
                "full_cal": full,
                "lo_hz": lo,
            })
            prev = win
            prev_lo = lo
        return marks

    @staticmethod
    def chunks(marks: list[dict], pair_slots: int = 2) -> list[list[dict]]:
        n = max(1, QUEUE_SLOTS // pair_slots)
        return [marks[i:i + n] for i in range(0, len(marks), n)] or [[]]
