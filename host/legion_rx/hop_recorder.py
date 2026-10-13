"""HopRecorder — запись скачков внутри sub-corridor (ТЗ п.2).

Вход: sub_corridor + поток мощности каналов (CH_PWR по решётке PFB).
Выход — записи [seq_num, channel_idx, freq_mhz, dwell_us, t_start, confidence].
Работает ТОЛЬКО в границах sub-corridor (каналы вне f_start..f_end не
рассматриваются — запрещено ТЗ).

Dwell пишется как метрика (FHSDT), ряд из-за него не режется.
Коммит: период найден и записано ≥ 2 полных цикла (поиск 2..4096).
AFH без периода — после 2×4096 скачков.
"""
from __future__ import annotations

import numpy as np

from .corridor import in_subcorridor

FHSDT_TOL = 0.20  # ±20% (ТЗ/[G6])
MIN_OBS_HOPS = 8    # минимум наблюдений до поиска периода (не сетка!)
MAX_CYCLE = 4096    # потолок поиска периода (ТЗ: сетка ЛЮБАЯ до 4096)
# Контрольные точки поиска периода (удвоение): покрывают любую сетку
# с перерасходом ≤ 2×, стоимость поиска не чаще чем в 2 раза от цикла.
_CHECKPOINTS = (8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256, 384, 512,
                768, 1024, 1536, 2048, 3072, 4096, 6144, 8192, 12288)


class HopRecorder:
    def __init__(self, sub_corridor: dict, chan_step_hz: float = 312.5e3,
                 n_chans: "int | None" = None,
                 samples_per_frame: int = 20_000):
        self.sub = dict(sub_corridor)
        self.chan_step = float(chan_step_hz)
        self.n_chans = n_chans
        self.spf = int(samples_per_frame)
        self.hops: list[dict] = []
        self.valid_count = 0
        self.duty_cycle = 0.0
        self._seq = 0
        self._cur: "int | None" = None
        self._cur_t0 = 0.0
        self._frames = 0
        self._active = 0
        self._dwells: list[float] = []
        self._energy: list[float] = []
        self._period: "tuple | None" = None
        self._checked = 0
        self._grid_f0: "float | None" = None
        self._grid_step: "float | None" = None
        self._cur_mhz: "float | None" = None
        self._cur_pwr = 0.0
        self._lock_floor = 1.0
        self._hold_k: "int | None" = None
        self._hold_n = 0
        self._floor = None
        self._hold = None
        self.hole_count = 0

    def _emit_open(self, t_s: float, freqs) -> "dict | None":
        """Закрыть открытый скачок. Тишина и смена окна тоже закрывают."""
        if self._cur is None:
            return None
        dwell_us = (float(t_s) - self._cur_t0) * 1e6
        if self._grid_f0 is not None and self._cur_mhz is not None:
            freq_mhz = self._cur_mhz
        elif 0 <= int(self._cur) < len(freqs):
            freq_mhz = float(freqs[int(self._cur)]) / 1e6
        else:
            freq_mhz = float(self._cur_mhz or 0.0)
        hop = {
            "seq_num": self._seq,
            "channel_idx": int(self._cur),
            "freq_mhz": freq_mhz,
            "hole": False,
            "dwell_us": dwell_us,
            "t_start": self._cur_t0,
            "sample_count": self._frames * self.spf,
            "confidence": float(min(
                1.0, self._cur_pwr / (self._lock_floor + 1e-12) / 3.0)),
        }
        self._seq += 1
        if len(self._dwells) < 4:
            valid = True
        else:
            med = float(np.median(self._dwells[-16:]))
            valid = abs(dwell_us - med) <= FHSDT_TOL * med
        hop["fhsdt_valid"] = bool(valid)
        self._dwells.append(dwell_us)
        self.hops.append(hop)
        self.valid_count += 1
        self._cur = None
        self._cur_mhz = None
        return hop

    def flush(self, t_s: float, freqs_hz) -> "dict | None":
        """Сбросить открытый скачок в ряд до смены окна.
        Только что открытый (длительность ещё ноль) — не скачок."""
        self._hold_k = None
        self._hold_n = 0
        self._hold = None
        if self._cur is None or float(t_s) <= float(self._cur_t0):
            self._cur = None
            self._cur_mhz = None
            return None
        return self._emit_open(t_s, np.asarray(freqs_hz, dtype=np.float64))

    def _peak(self, p: np.ndarray):
        """Самый громкий локальный пик выше своего пола два кадра подряд.
        Один кадр и бин на своём полу — не вспышка."""
        if (self._floor is None or self._hold is None
                or self._floor.shape != p.shape):
            self._floor = np.full(p.size, float(np.median(p)))
            self._hold = np.zeros(p.size, dtype=np.int32)
        raw = p > self._floor
        self._hold = np.where(raw, np.minimum(self._hold + 1, 2), 0)
        active = self._hold >= 2
        quiet = ~active
        a = float(0.05)
        self._floor[quiet] = (1.0 - a) * self._floor[quiet] + a * p[quiet]
        if not np.any(active):
            return None
        left = np.empty(p.size, dtype=np.float64)
        right = np.empty(p.size, dtype=np.float64)
        left[0] = -np.inf
        left[1:] = p[:-1]
        right[-1] = -np.inf
        right[:-1] = p[1:]
        peaks = active & (p >= left) & (p >= right)
        if not np.any(peaks):
            return None
        return int(np.argmax(np.where(peaks, p, -np.inf)))

    def update(self, ch_pwr, freqs_hz, t_s: float) -> "dict | None":
        """Тик. Скачок пишется, когда пик сменился или погас.
        Бин выше своего пола два кадра подряд. Один кадр — не вспышка."""
        p = np.asarray(ch_pwr, dtype=np.float64)
        f = np.asarray(freqs_hz, dtype=np.float64)
        self._frames += 1
        self._energy.append(float(np.max(p)) if p.size else 0.0)
        mask = np.array([in_subcorridor(x, self.sub) for x in f])
        if not mask.any():
            return self.flush(t_s, f)
        p = np.where(mask, p, 0.0)
        k = self._peak(p)
        self.duty_cycle = self._active / max(1, self._frames)
        if k is None:
            return self._emit_open(t_s, f)
        self._active += 1
        self.duty_cycle = self._active / max(1, self._frames)
        dom_ch = int(k)
        dom_mhz = None
        if self._grid_f0 is not None:
            dom_mhz = float(f[k]) / 1e6
            dom_ch = self._grid_ch(float(f[k]))
        if dom_ch == self._cur:
            self._cur_pwr = float(p[k])
            return None
        hop = self._emit_open(t_s, f)
        self._cur = int(dom_ch)
        self._cur_mhz = dom_mhz
        self._cur_t0 = float(t_s)
        self._cur_pwr = float(p[k])
        self._lock_floor = float(self._floor[k]) if self._floor is not None else 1.0
        return hop

    def _grid_ch(self, freq_hz: float) -> int:
        step = self._grid_step if self._grid_f0 is not None else self.chan_step
        origin = self._grid_f0 if self._grid_f0 is not None else float(
            self.sub["f_start"])
        return int(round((float(freq_hz) - origin) / step))

    def load_stitched(self, rows: list) -> int:
        """Ряд lo_sweep.stitch → начальные hops, не пустой recorder.

        Дубли overlap (тот же кадр и частота) снимаются повторно.
        hole=True — разрыв между окнами больше полного retune (~4 мс).
        channel_idx — одна сетка от sub.f_start, не бин PFB окна.
        """
        self._grid_f0 = float(self.sub["f_start"])
        self._grid_step = float(self.chan_step)
        self.hops = []
        self._dwells = []
        self.valid_count = 0
        self._seq = 0
        self._period = None
        self._checked = 0
        self.hole_count = 0
        seen = set()
        for h in rows:
            freq_hz = float(h["freq_mhz"]) * 1e6
            if not in_subcorridor(freq_hz, self.sub):
                continue
            sc = int(h.get("sample_count") or 0)
            key = (sc // max(1, self.spf), round(float(h["freq_mhz"]), 3))
            if key in seen:
                continue
            seen.add(key)
            dwell = float(h.get("dwell_us") or 0.0)
            if len(self._dwells) < 4 or dwell <= 0:
                valid = True
            else:
                med = float(np.median(self._dwells[-16:]))
                valid = (abs(dwell - med) <= FHSDT_TOL * med) if med > 0 else True
            hole = bool(h.get("hole"))
            rec = {
                "seq_num": self._seq,
                "channel_idx": self._grid_ch(freq_hz),
                "freq_mhz": float(h["freq_mhz"]),
                "dwell_us": dwell,
                "t_start": float(h.get("t_start") or 0.0),
                "sample_count": sc,
                "confidence": float(h.get("confidence") or 0.0),
                "hole": hole,
                "window": h.get("window"),
                "fhsdt_valid": bool(valid),
            }
            self._seq += 1
            self._dwells.append(dwell)
            self.hops.append(rec)
            if hole:
                self.hole_count += 1
            self.valid_count += 1
        # Ряд уже закрыт. Открытый канал заставил бы записать последний скачок ещё раз.
        self._cur = None
        self._cur_mhz = None
        self._hold_k = None
        self._hold_n = 0
        self._floor = None
        self._hold = None
        return len(self.hops)

    def append_stitched(self, rows: list) -> int:
        """Хвост нового круга. Уже найденный период не сбрасывается."""
        if not self.hops:
            return self.load_stitched(rows)
        seen = {
            (int(h.get("sample_count") or 0) // max(1, self.spf),
             round(float(h["freq_mhz"]), 3))
            for h in self.hops
        }
        last_sc = max(int(h.get("sample_count") or 0) for h in self.hops)
        added = 0
        for h in rows:
            freq_hz = float(h["freq_mhz"]) * 1e6
            if not in_subcorridor(freq_hz, self.sub):
                continue
            sc = int(h.get("sample_count") or 0)
            if sc < last_sc:
                continue
            key = (sc // max(1, self.spf), round(float(h["freq_mhz"]), 3))
            if key in seen:
                continue
            seen.add(key)
            dwell = float(h.get("dwell_us") or 0.0)
            if len(self._dwells) < 4 or dwell <= 0:
                metric = True
            else:
                med = float(np.median(self._dwells[-16:]))
                metric = (abs(dwell - med) <= FHSDT_TOL * med) if med > 0 else True
            hole = bool(h.get("hole"))
            rec = {
                "seq_num": self._seq,
                "channel_idx": self._grid_ch(freq_hz),
                "freq_mhz": float(h["freq_mhz"]),
                "dwell_us": dwell,
                "t_start": float(h.get("t_start") or 0.0),
                "sample_count": sc,
                "confidence": float(h.get("confidence") or 0.0),
                "hole": hole,
                "window": h.get("window"),
                "fhsdt_valid": bool(metric),
            }
            self._seq += 1
            self._dwells.append(dwell)
            self.hops.append(rec)
            if hole:
                self.hole_count += 1
            self.valid_count += 1
            added += 1
        if len(self.hops) > 8192:
            self.hops = self.hops[-8192:]
            self._period = None
            self._checked = 0
            self.valid_count = len(self.hops)
        self._cur = None
        self._cur_mhz = None
        self._hold_k = None
        self._hold_n = 0
        self._floor = None
        self._hold = None
        return added

    def median_dwell_us(self) -> "float | None":
        if not self._dwells:
            return None
        return float(np.median(self._dwells))

    def ready(self) -> "tuple | None":
        """Период найден и записано ≥ 2 полных цикла.
        Дырка переезда — пометка, ряд из-за неё не рвётся: бьём по всему коридору."""
        from .pattern_store import find_period_tolerant

        if self._period is None:
            if self.valid_count < MIN_OBS_HOPS:
                return None
            nxt = next((c for c in _CHECKPOINTS if c > self._checked), None)
            if nxt is None or self.valid_count < nxt:
                return None
            self._checked = self.valid_count
            seq = [h["channel_idx"] for h in self.hops]
            self._period = find_period_tolerant(
                seq, tol=1, m=self.n_chans, max_cycle=MAX_CYCLE)
        if self._period is None:
            return None
        period, score = self._period
        if self.valid_count >= 2 * period:
            return (period, score)
        return None

    def maybe_commit(self, store) -> "str | None":
        """Адаптивный коммит: (период + ≥2 цикла) → add_pattern (pending).
        AFH-край: период не найден после 2×MAX_CYCLE скачков — фиксируем
        запись как есть (cycle=вся запись, тип adaptive_afh)."""
        if self.ready() is not None:
            return store.add_pattern(self.sub, self.hops)
        if self._period is None and self.valid_count >= 2 * MAX_CYCLE:
            return store.add_pattern(self.sub, self.hops)
        return None

    def reset(self) -> None:
        """Переобучение (drift): счётчики в ноль, sub-corridor тот же."""
        self.__init__(self.sub, self.chan_step, self.n_chans, self.spf)
