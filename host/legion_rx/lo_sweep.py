"""LoSweeper — окна сканирования коридора шире IBW (bladeRF 2.0 micro).

IBW до 56 МГц [F11]. Перекрытие окон 15%. Полный retune ~3.8 мс [F13];
кэш quick-tune ~500 мкс [F14], не более 256 профилей [F15]. Очередь
schedule_retune ≤ 16 [F20]. При частых retune fs ≤ 20 Msps [F19].

Quick-tune: LRU-кэш на host + radio.set_frequency_rx (bladeRF-cli).
bladerf_get_quick_tune недоступен через legion_fpga.py (PIO/FakeTransport,
не libbladeRF). Аппаратный API — лаборатория, не этот модуль.
"""
from __future__ import annotations

import math
from collections import OrderedDict

IBW_HZ = 56.0e6          # потолок аналогового фильтра AD9361


def window_hz(fs_hz: float, ceiling_hz: float = IBW_HZ) -> float:
    """Окно одного LO: min(потолок AD9361, fs). fs=34e6 → 34 МГц."""
    return min(float(ceiling_hz), float(fs_hz))
OVERLAP = 0.15          # доля перекрытия соседних окон
SCAN_DWELL_S = 4.0e-3   # dwell окна; полный retune ~3.8 мс [F13]
RETUNE_QUEUE = 16
QUICK_TUNE_MAX = 256
FS_RETUNE_MAX = 20.0e6
RETUNE_FULL_S = 3.8e-3
RETUNE_CACHED_S = 500e-6


def plan_windows(f_start: float, f_end: float,
                 ibw_hz: float = IBW_HZ,
                 overlap: float = OVERLAP) -> list[dict]:
    """Окна [{f_center, f_start, f_end, overlap_next}].
    n = ceil(width / (IBW × (1−overlap))). Один кусок, если width ≤ IBW.
    2100–2500 МГц / 56 МГц / 15% → 9 окон; 2150–2230 → 2."""
    lo, hi = float(min(f_start, f_end)), float(max(f_start, f_end))
    width = hi - lo
    ibw = float(ibw_hz)
    if width <= 0:
        raise ValueError("plan_windows: пустой коридор")
    if width <= ibw:
        mid = 0.5 * (lo + hi)
        return [{"f_center": mid, "f_start": lo, "f_end": hi,
                 "overlap_next": 0.0, "index": 0}]
    usable = ibw * (1.0 - float(overlap))
    n = max(2, int(math.ceil(width / usable)))
    step = (width - ibw) / (n - 1) if n > 1 else 0.0
    out = []
    for i in range(n):
        a = lo + i * step
        b = a + ibw
        if i == n - 1:
            b = hi
            a = hi - ibw
        ov = 0.0
        if i + 1 < n:
            nxt_a = lo + (i + 1) * step
            ov = max(0.0, b - nxt_a)
        out.append({
            "f_center": 0.5 * (a + b),
            "f_start": a, "f_end": b,
            "overlap_next": ov, "index": i,
        })
    return out


class LoSweeper:
    def __init__(self, ibw_hz: float = IBW_HZ, radio=None,
                 samples_per_frame: int = 20_000, fs_hz: float = 20e6):
        self.ibw_hz = float(ibw_hz)
        self.radio = radio
        self.spf = int(samples_per_frame)
        self.fs_hz = float(fs_hz)
        self.windows: list[dict] = []
        self.idx = 0
        self.hops: dict[int, list] = {}
        self._win_t0_s = 0.0
        self._win_samples0 = 0
        self._queue: list[dict] = []
        self._qt: OrderedDict = OrderedDict()  # f_hz → profile
        self.sample_count = 0
        self.coverage_frac = 0.0
        self.work: "dict | None" = None
        self.note = ""

    def setup(self, f_start: float, f_end: float) -> list[dict]:
        self.note = ""
        if self.fs_hz > FS_RETUNE_MAX:
            self.note = (f"fs={self.fs_hz:.0f} > {FS_RETUNE_MAX:.0f}; "
                         "частые retune — риск underrun [F19]")
        self.windows = plan_windows(f_start, f_end, self.ibw_hz)
        self.idx = 0
        self.hops = {w["index"]: [] for w in self.windows}
        self.work = None
        return self.windows

    def current(self) -> "dict | None":
        if 0 <= self.idx < len(self.windows):
            return self.windows[self.idx]
        return None

    def tune_current(self, sample_count: int) -> dict:
        """Перестройка LO на текущее окно. Кэш LRU ≤ 256 [F15]."""
        w = self.current()
        if w is None:
            return {"ok": False, "why": "no_window"}
        return self._tune(w["f_center"], sample_count)

    def _tune(self, f_hz: float, sample_count: int) -> dict:
        key = int(round(float(f_hz)))
        cached = key in self._qt
        if cached:
            self._qt.move_to_end(key)
            method = "reuseQuickTune"
            expect_s = RETUNE_CACHED_S
        else:
            if len(self._qt) >= QUICK_TUNE_MAX:
                self._qt.popitem(last=False)
            self._qt[key] = {"f_hz": key, "quick_tune": True}
            method = "saveQuickTune"
            expect_s = RETUNE_FULL_S
        if self.radio is not None:
            self.radio.set_frequency_rx(float(f_hz))
        rec = {"f_hz": float(f_hz), "sample_count": int(sample_count),
               "method": method, "expect_s": expect_s, "cached": cached}
        self._queue.append(rec)
        self._queue = self._queue[-RETUNE_QUEUE:]
        return rec

    def on_hop(self, hop: dict) -> None:
        w = self.current()
        if w is None or hop is None:
            return
        rec = dict(hop)
        rec["window"] = w["index"]
        rec["lo_hz"] = w["f_center"]
        rec.setdefault("sample_count", self.sample_count)
        self.hops[w["index"]].append(rec)

    def dwell_done(self, t_s: float, win_t0_s: float) -> bool:
        return (float(t_s) - float(win_t0_s)) >= SCAN_DWELL_S

    def advance(self, sample_count: int) -> bool:
        """Следующее окно. False — скан закончен."""
        self.idx += 1
        if self.idx >= len(self.windows):
            return False
        self.tune_current(sample_count)
        return True

    def stitch(self, hop_rate_hz: float = 1000.0) -> list[dict]:
        """Единый ряд по sample_count. Дубли перекрытия снимаются.
        hole только на границе окон при разрыве > полного retune (~3.8 мс)."""
        rows = []
        for i in sorted(self.hops):
            rows.extend(self.hops[i])
        rows.sort(key=lambda h: (int(h.get("sample_count", 0)),
                                 float(h.get("t_start", 0.0))))
        gap_samples = int(round(RETUNE_FULL_S * self.fs_hz))
        out = []
        seen = set()
        prev_sc = None
        prev_win = None
        for h in rows:
            f = round(float(h.get("freq_mhz", 0.0)), 3)
            sc = int(h.get("sample_count", 0))
            win = h.get("window")
            key = (sc // max(1, self.spf), f)
            if key in seen:
                continue
            seen.add(key)
            hole = (prev_sc is not None and win != prev_win
                    and sc - prev_sc > gap_samples)
            rec = dict(h)
            rec["hole"] = hole
            out.append(rec)
            prev_sc = sc
            prev_win = win
        return out

    def finish(self, hop_rate_hz: float = 1000.0) -> dict:
        """Окно с макс. числом прыжков → рабочий LO. Покрытие в доле hop."""
        counts = {i: len(self.hops.get(i, [])) for i in self.hops}
        if not self.windows:
            self.note = "нет окон"
            self.coverage_frac = 0.0
            return {"work": None, "stitched": [], "coverage": 0.0}
        best = max(self.windows, key=lambda w: counts.get(w["index"], 0))
        self.work = best
        stitched = self.stitch(hop_rate_hz)
        total = max(1, sum(counts.values()))
        vis = counts.get(best["index"], 0)
        self.coverage_frac = vis / total
        self.note = (f"Покрытие {100.0 * self.coverage_frac:.1f}% "
                     f"(окно {best['index']}, hops={vis}/{total})")
        if self.radio is not None:
            self._tune(best["f_center"], self.sample_count)
        return {"work": best, "stitched": stitched,
                "coverage": self.coverage_frac, "note": self.note,
                "counts": counts}
