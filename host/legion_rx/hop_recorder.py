"""HopRecorder — запись скачков внутри sub-corridor (ТЗ п.2).

Вход: sub_corridor + поток мощности каналов (CH_PWR по решётке PFB).
Выход — записи [seq_num, channel_idx, freq_mhz, dwell_us, t_start, confidence].
Работает ТОЛЬКО в границах sub-corridor (каналы вне f_start..f_end не
рассматриваются — запрещено ТЗ).

Валидация [G6]: FHSDT (dwell в ±20% от скользящей медианы), FHSDC
(duty cycle). ≥16 валидных скачков → add_pattern в PatternStore (фаза 1).
"""
from __future__ import annotations

import numpy as np

from .corridor import in_subcorridor

MIN_HOPS_FOR_PATTERN = 16
FHSDT_TOL = 0.20  # ±20% (ТЗ/[G6])


class HopRecorder:
    def __init__(self, sub_corridor: dict, chan_step_hz: float = 312.5e3):
        self.sub = dict(sub_corridor)
        self.chan_step = float(chan_step_hz)
        self.hops: list[dict] = []
        self.valid_count = 0
        self.duty_cycle = 0.0
        self._seq = 0
        self._cur: "int | None" = None     # текущий доминантный канал
        self._cur_t0 = 0.0
        self._frames = 0
        self._active = 0
        self._dwells: list[float] = []

    def update(self, ch_pwr, freqs_hz, t_s: float) -> "dict | None":
        """Тик. Возвращает запись скачка при смене доминантного канала."""
        p = np.asarray(ch_pwr, dtype=np.float64)
        f = np.asarray(freqs_hz, dtype=np.float64)
        self._frames += 1
        # маска sub-corridor: вне границ — нули (жёстко, ТЗ)
        mask = np.array([in_subcorridor(x, self.sub) for x in f])
        if not mask.any():
            return None
        p_sub = np.where(mask, p, 0.0)
        floor = float(np.median(p_sub[mask]))
        mad = float(np.median(np.abs(p_sub[mask] - floor))) + 1e-12
        thr = floor + 6.0 * 1.4826 * mad
        k = int(np.argmax(p_sub))
        dom = k if p_sub[k] > thr else None
        if dom is not None:
            self._active += 1
        self.duty_cycle = self._active / max(1, self._frames)  # FHSDC [G6]
        if dom is None or dom == self._cur:
            return None
        # смена канала → закрываем предыдущий скачок
        hop = None
        if self._cur is not None:
            dwell_us = (float(t_s) - self._cur_t0) * 1e6
            hop = {
                "seq_num": self._seq,
                "channel_idx": self._cur,
                "freq_mhz": float(f[self._cur]) / 1e6,
                "dwell_us": dwell_us,
                "t_start": self._cur_t0,
                "confidence": float(min(1.0, p_sub[k] / (thr + 1e-12) / 3.0)),
            }
            self._seq += 1
            # FHSDT: dwell в ±20% от медианы предыдущих [G6]
            if len(self._dwells) < 4:
                valid = True  # bootstrap первых скачков
            else:
                med = float(np.median(self._dwells[-16:]))
                valid = abs(dwell_us - med) <= FHSDT_TOL * med
            hop["fhsdt_valid"] = bool(valid)
            self._dwells.append(dwell_us)
            self.hops.append(hop)
            if valid:
                self.valid_count += 1
        self._cur = dom
        self._cur_t0 = float(t_s)
        return hop

    def maybe_commit(self, store) -> "str | None":
        """≥16 валидных скачков → add_pattern (статус pending), pattern_id."""
        if self.valid_count < MIN_HOPS_FOR_PATTERN:
            return None
        return store.add_pattern(self.sub, self.hops)

    def reset(self) -> None:
        """Переобучение (drift): счётчики в ноль, sub-corridor тот же."""
        self.__init__(self.sub, self.chan_step)
