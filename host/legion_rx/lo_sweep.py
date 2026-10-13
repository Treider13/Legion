"""LoSweeper — окна сканирования коридора шире IBW (bladeRF 2.0 micro).

IBW до 56 МГц [F11]. Шаг — середина окна, края фильтра щель не оставляют.
Полный retune ~3.8 мс [F13];
кэш quick-tune ~500 мкс [F14], не более 256 профилей [F15]. Очередь
schedule_retune ≤ 16 [F20]. При частых retune fs ≤ 20 Msps [F19].

Quick-tune: LRU-кэш на host + radio.set_frequency_rx (bladeRF-cli).
bladerf_get_quick_tune недоступен через legion_fpga.py (PIO/FakeTransport,
не libbladeRF). Аппаратный API — лаборатория, не этот модуль.
"""
from __future__ import annotations

import math
from collections import OrderedDict

import numpy as np

IBW_HZ = 56.0e6          # потолок аналогового фильтра AD9361


def window_hz(fs_hz: float, ceiling_hz: float = IBW_HZ) -> float:
    """Окно одного LO: min(потолок AD9361, fs). fs=34e6 → 34 МГц."""
    return min(float(ceiling_hz), float(fs_hz))
OVERLAP = 0.15          # доля перекрытия соседних окон
EDGE_GUARD = 0.10       # края окна — завал фильтра, в ряд не пишутся
SCAN_DWELL_S = 4.0e-3   # dwell окна; полный retune ~3.8 мс [F13]
RETUNE_QUEUE = 16
QUICK_TUNE_MAX = 256
FS_RETUNE_MAX = 20.0e6
RETUNE_FULL_S = 3.8e-3
RETUNE_CACHED_S = 500e-6


def stitch_power(segments: dict, windows: list, fs_hz: float,
                  n_out: int = 1024):
    """Одна строка спектра на весь коридор.

    segments: индекс окна → (lo_hz, линейная мощность fftshift).
    Края окна не входят. Нахлёст смешивается по мощности, не по децибелам.
    Частота, которую середина окна не закрыла, остаётся дыркой.
    """
    if not windows:
        return None
    keeps = []
    for w in windows:
        span = float(w["f_end"]) - float(w["f_start"])
        if span <= 0:
            continue
        guard = EDGE_GUARD * span
        keeps.append((float(w["f_start"]) + guard, float(w["f_end"]) - guard))
    if not keeps:
        return None
    f0 = min(a for a, _b in keeps)
    f1 = max(b for _a, b in keeps)
    if f1 <= f0:
        return None
    axis = np.linspace(f0, f1, int(n_out))
    acc = np.zeros(axis.size, dtype=np.float64)
    wsum = np.zeros(axis.size, dtype=np.float64)
    fs = float(fs_hz)
    for w in windows:
        item = segments.get(int(w["index"]))
        if item is None:
            item = segments.get(w["index"])
        if item is None:
            continue
        lo, lin = item
        lin = np.asarray(lin, dtype=np.float64).ravel()
        n = int(lin.size)
        if n < 4 or fs <= 0:
            continue
        # fftshift: бин n/2 — несущая. Полбина в сторону даёт яму на шве.
        freqs = float(lo) + (np.arange(n) - n / 2.0) * (fs / n)
        span = float(w["f_end"]) - float(w["f_start"])
        if span <= 0:
            continue
        guard = EDGE_GUARD * span
        lo_keep = float(w["f_start"]) + guard
        hi_keep = float(w["f_end"]) - guard
        if hi_keep <= lo_keep:
            continue
        order = np.argsort(freqs)
        freqs = freqs[order]
        lin = np.maximum(lin[order], 0.0)
        p = np.interp(axis, freqs, lin, left=0.0, right=0.0)
        inside = (axis >= lo_keep) & (axis <= hi_keep)
        half = 0.5 * (hi_keep - lo_keep)
        center = 0.5 * (lo_keep + hi_keep)
        # Ближе к центру — больше вес. На самой границе вес не ноль,
        # иначе стык двух кусков становится дыркой −120 дБ.
        weight = np.clip(1.0 - np.abs(axis - center) / max(half, 1.0), 1e-3, 1.0)
        weight = np.where(inside, weight, 0.0)
        acc += p * weight
        wsum += weight
    db = np.full(axis.size, -120.0, dtype=np.float64)
    hit = wsum > 0
    db[hit] = 10.0 * np.log10(np.maximum(acc[hit] / wsum[hit], 1e-12))
    return db, f0, f1


def plan_windows(f_start: float, f_end: float,
                 ibw_hz: float = IBW_HZ,
                 overlap: float = OVERLAP) -> list[dict]:
    """Окна [{f_center, f_start, f_end, overlap_next}].
    Шаг — середина окна, края фильтра не оставляют щель.
    Один кусок, если width ≤ IBW. 2100–2500 МГц / 56 МГц → 9 окон."""
    lo, hi = float(min(f_start, f_end)), float(max(f_start, f_end))
    width = hi - lo
    ibw = float(ibw_hz)
    if width <= 0:
        raise ValueError("plan_windows: пустой коридор")
    if width <= ibw:
        mid = 0.5 * (lo + hi)
        return [{"f_center": mid, "f_start": lo, "f_end": hi,
                 "overlap_next": 0.0, "index": 0}]
    # Середина куска стыкуется со следующей: шаг = окно × (1 − 2×край).
    # Иначе между кусками щель, и частота там не попадает в ряд.
    guard = EDGE_GUARD * ibw
    cover = max(float(overlap), 2.0 * EDGE_GUARD)
    usable = ibw * (1.0 - cover)
    if usable <= 0:
        usable = ibw * 0.5
    n = max(2, int(math.ceil(width / usable)))
    start0 = lo - guard
    start_last = hi - ibw + guard
    step = (start_last - start0) / (n - 1) if n > 1 else 0.0
    out = []
    for i in range(n):
        a = start0 + i * step
        b = a + ibw
        ov = 0.0
        if i + 1 < n:
            nxt_a = start0 + (i + 1) * step
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
        bucket = self.hops[w["index"]]
        bucket.append(rec)
        if len(bucket) > 8192:
            del bucket[:4096]

    def dwell_done(self, t_s: float, win_t0_s: float) -> bool:
        return (float(t_s) - float(win_t0_s)) >= SCAN_DWELL_S

    def advance(self, sample_count: int) -> bool:
        """Следующее окно. False — скан закончен."""
        self.idx += 1
        if self.idx >= len(self.windows):
            return False
        self.tune_current(sample_count)
        return True

    def _window(self, hop: dict) -> "dict | None":
        win = hop.get("window")
        if win is None or not self.windows:
            return None
        try:
            return self.windows[int(win)]
        except (IndexError, TypeError, ValueError):
            return None

    def _in_interior(self, hop: dict) -> bool:
        """Середина окна. Край — завал фильтра. Одно окно не режем:
        другого куска, откуда взять эту частоту, нет."""
        if len(self.windows) <= 1:
            return True
        w = self._window(hop)
        if w is None:
            return True
        span = float(w["f_end"]) - float(w["f_start"])
        if span <= 0:
            return True
        guard = EDGE_GUARD * span
        f = float(hop.get("freq_mhz", 0.0)) * 1e6
        return (float(w["f_start"]) + guard) <= f <= (float(w["f_end"]) - guard)

    def stitch(self, hop_rate_hz: float = 1000.0) -> list[dict]:
        """Услышанные скачки — один ряд по времени. Края окон сняты.
        Пока приём переезжает, новых скачков нет: дырка только пометка,
        если пауза больше полного retune (~3.8 мс). Пропущенное не выдумывается."""
        rows = []
        for i in sorted(self.hops):
            rows.extend(self.hops[i])
        rows.sort(key=lambda h: (int(h.get("sample_count", 0)),
                                 float(h.get("t_start", 0.0))))
        rows = [h for h in rows if self._in_interior(h)]
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
