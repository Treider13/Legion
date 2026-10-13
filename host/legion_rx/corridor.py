"""CorridorDetector — FFT Burst Detector [G1] + байесовский P(hopping|data) [G2].

Вход на тик: вектор мощности по бинам (CH_PWR PFB или спектр) + freqs.
Порог — ДИНАМИЧЕСКИЙ на бин [G1]: EMA-оценка шумового пола каждого бина,
активность = бин выше своего пола два кадра подряд. Всплески тегируются start/end/freq.

P(hopping|data) [G2]: лог-шансы обновляются признаками окна (регулярность
интервалов CV, duty cycle, число всплесков); hop rate = mean ± 95% CI по
интервалам (delta-метод через медиану).

SUB-CORRIDOR EXTRACTION (жёсткое правило контура):
    sub_f_start = f_min − 400 кГц,  sub_f_end = f_max + 400 кГц.
Работа (hop_recorder, fpga_control) — ТОЛЬКО внутри sub-corridor.
"""
from __future__ import annotations

import math
import uuid

import numpy as np

SUB_MARGIN_HZ = 400.0e3  # ТЗ: ±400 кГц от f_min/f_max


class CorridorDetector:
    def __init__(self, k_sigma: float = 6.0, ema: float = 0.05,
                 min_width_bins: int = 3, window: int = 64):
        self.k = float(k_sigma)
        self.ema_a = float(ema)
        self.min_w = int(min_width_bins)
        self.window = int(window)
        self._floor = None          # EMA-пол на бин [G1]
        self._prev_active = None
        self._recent = None         # счётчик "активен в окне" на бин
        self._intervals: list[float] = []   # интервалы между всплесками, с
        self._last_burst_t: "float | None" = None
        self._burst_count = 0
        self._active_frames = 0
        self._frames = 0
        self._log_odds = 0.0        # байесовские лог-шансы P(hopping) [G2]
        self._evals = 0
        self._hold = None

    # ---- [G1] FFT Burst Detector: динамический порог на бин ----

    def update(self, power_lin, freqs_hz, t_s: float) -> dict:
        """power_lin (M,) линейная → {corridors, bursts, active_any}."""
        p = np.asarray(power_lin, dtype=np.float64) + 1e-20
        f = np.asarray(freqs_hz, dtype=np.float64)
        if self._floor is None:
            # Старт пола — МЕДИАНА первого кадра (не сам кадр: пик в поле
            # гасил бы детект на десятки тиков EMA-спада).
            self._floor = np.full(p.size, float(np.median(p)))
            self._prev_active = np.zeros(p.size, dtype=bool)
            self._recent = np.zeros(p.size, dtype=np.int32)
        floor = self._floor
        # Выше своего пола, два кадра подряд. Один отсчёт на уровне пола — не вспышка.
        raw = p > floor
        if self._hold is None or self._hold.shape != p.shape:
            self._hold = np.zeros(p.size, dtype=np.int32)
        self._hold = np.where(raw, np.minimum(self._hold + 1, 2), 0)
        active = self._hold >= 2
        # EMA-пол обновляем ТОЛЬКО неактивными бинами: сигнал себя не топит
        mask = ~active
        floor[mask] = (1 - self.ema_a) * floor[mask] + self.ema_a * p[mask]
        self._floor = floor
        self._frames += 1
        # Коридор = аккумуляция активности за окно (одиночный всплеск FHSS —
        # 1 бин; коридор восстанавливается по следу скачков, [G1]). Дилатация
        # ±1 бин: всплеск физически накрывает соседние каналы (краевое
        # расщепление PFB), иначе коридор рассыпается на одиночные бины.
        self._recent[active] = self.window
        recent_mask = self._recent > 0
        recent_mask = (recent_mask |
                       np.roll(recent_mask, 1) | np.roll(recent_mask, -1))
        corridors = []
        for a, b in _runs(recent_mask, self.min_w):
            # freqs в порядке FFT-бинов (wrap на M/2): границы — min/max.
            corridors.append({
                "corridor_id": uuid.uuid4().hex[:8],
                "f_start": float(min(f[a], f[b])),
                "f_end": float(max(f[a], f[b])),
                "bins": (a, b),
                "power": float(p[a: b + 1].max()),
            })
        self._recent[self._recent > 0] -= 1
        # Всплеск = новый активный ран (start/end/freq теги [G1])
        new_active = active & ~self._prev_active
        bursts = []
        for a, b in _runs(new_active, 1):
            bursts.append({"t_start": float(t_s), "t_end": float(t_s),
                           "f_center": float(f[(a + b) // 2]),
                           "bins": (a, b)})
        self._prev_active = active
        active_any = bool(active.any())
        if active_any:
            self._active_frames += 1
        if bursts:
            if self._last_burst_t is not None:
                self._intervals.append(float(t_s) - self._last_burst_t)
                self._intervals = self._intervals[-256:]
            self._last_burst_t = float(t_s)
            self._burst_count += len(bursts)
        return {"corridors": corridors, "bursts": bursts,
                "active_any": active_any, "floor": floor.copy()}

    # ---- [G2] Bayesian P(hopping|data), hop rate mean ± 95% CI ----

    def posterior(self) -> dict:
        """Оценка по накопленному окну: признаки → лог-шансы (LR)."""
        iv = np.asarray(self._intervals)
        n = iv.size
        duty = self._active_frames / max(1, self._frames)
        if n >= 5:
            med = float(np.median(iv))
            cv = float(np.std(iv) / (np.mean(iv) + 1e-12))
            if self._evals == 0 or n > self._evals:
                # регулярные интервалы + не-непрерывность → hopping
                lr = 4.0 if (cv < 0.35 and self._burst_count >= 6) else 0.5
                if duty > 0.9 and self._burst_count < 3:
                    lr *= 0.25  # постоянная несущая — против hopping
                self._log_odds += math.log(lr)
                self._log_odds = max(-30.0, min(30.0, self._log_odds))
                self._evals = n
            rate = 1.0 / med if med > 0 else 0.0
            # 95% CI на средний интервал → через delta-метод на rate
            ci_iv = 1.96 * float(np.std(iv)) / math.sqrt(n)
            rate_lo = 1.0 / (med + ci_iv) if med + ci_iv > 0 else 0.0
            rate_hi = 1.0 / max(1e-9, med - ci_iv)
            ci95 = (rate_hi - rate_lo) / 2.0
        else:
            rate, ci95 = 0.0, 0.0
        p = 1.0 / (1.0 + math.exp(-self._log_odds))
        return {"p_hopping": p, "hop_rate_hz": rate, "hop_rate_ci95_hz": ci95,
                "intervals_n": n, "duty": duty, "bursts": self._burst_count}


def _runs(mask: np.ndarray, min_len: int) -> list:
    """Индексы [a, b] непрерывных True-участков длиной ≥ min_len."""
    out = []
    i = 0
    n = mask.size
    while i < n:
        if mask[i]:
            j = i
            while j + 1 < n and mask[j + 1]:
                j += 1
            if j - i + 1 >= min_len:
                out.append((i, j))
            i = j + 1
        else:
            i += 1
    return out


def extract_subcorridor(hop_freqs_hz, parent_corridor_id: str,
                        margin_hz: float = SUB_MARGIN_HZ) -> dict:
    """SUB-CORRIDOR EXTRACTION (ТЗ):
        sub_f_start = f_min − 400 кГц, sub_f_end = f_max + 400 кГц.
    Хранит {parent_corridor_id, sub_corridor_id, f_start, f_end}.
    Пример ТЗ: parent 2000–3000 МГц, FHSS 2400–2483 → [2399.6, 2483.4]."""
    fr = [float(x) for x in hop_freqs_hz]
    if not fr:
        raise ValueError("extract_subcorridor: пустой список частот")
    f_min, f_max = min(fr), max(fr)
    return {
        "parent_corridor_id": str(parent_corridor_id),
        "sub_corridor_id": f"{parent_corridor_id}:sub:{uuid.uuid4().hex[:6]}",
        "f_start": f_min - float(margin_hz),
        "f_end": f_max + float(margin_hz),
        "f_min": f_min, "f_max": f_max,
        "margin_hz": float(margin_hz),
    }


def in_subcorridor(freq_hz: float, sub: dict) -> bool:
    """Жёсткая граница: работать ТОЛЬКО внутри sub-corridor."""
    return float(sub["f_start"]) <= float(freq_hz) <= float(sub["f_end"])


IBW_HZ = 56.0e6  # bladeRF 2.0 micro, приём [F11]


def ibw_visibility(sub: dict, lo_hz: float, ibw_hz: float = IBW_HZ) -> dict:
    """Видимая доля sub в текущем IBW. width > IBW → неполный паттерн."""
    width = float(sub["f_end"]) - float(sub["f_start"])
    half = 0.5 * float(ibw_hz)
    vis_lo = max(float(sub["f_start"]), float(lo_hz) - half)
    vis_hi = min(float(sub["f_end"]), float(lo_hz) + half)
    visible = max(0.0, vis_hi - vis_lo)
    frac = visible / max(width, 1.0)
    wider = width > float(ibw_hz)
    note = ""
    if wider:
        note = "FHSS шире IBW"
        if frac < 0.5:
            note += "; видимая часть <50%, паттерн неполный"
        else:
            note += "; работа по видимой части"
    return {"width_hz": width, "wider_than_ibw": wider,
            "visible_hz": visible, "visible_frac": frac,
            "visible_lo": vis_lo, "visible_hi": vis_hi, "note": note}
