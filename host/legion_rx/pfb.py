"""PFB-канализация на GPU (шаг 4.2–4.6).

Первичный путь — cupyx.signal.channelize_poly при выполнении ограничений
(шаг 4.3):
  * zero-overlap: децимация == числу каналов (так и построено: M = n_chans);
  * len(filter)/n_chans (taps на канал) <= 32.
Иначе — собственный полифазный канализатор на xp (CuPy/NumPy):

    X[t, m] = x[t*M + m]            (блоки по M сэмплов, zero-overlap)
    z[t, m] = Σ_j X[t-tp+1+j, m]·hp[j, m],  hp = h.reshape(tp, M)
    y[t, :] = fft(z[t, :])          (M-каналов, порядок = бины FFT)

Свойства: та же полифазная структура, что у channelize_poly; на тоне
в центре канала k энергия садится в канал k (тест test_pfb.py).

CH_PWR_gpu (4.4, 4.6) — mean|y|² по кадру. Отдельная величина от FPGA
CH_PWR: в регистры FPGA НЕ пишется никогда (запрещено).
"""
from __future__ import annotations

import numpy as np

from . import xputil

MAX_TAPS_PER_CHAN = 32  # ограничение channelize_poly (шаг 4.3)


def channelize_poly_ok(n_chans: int, taps_per_ch: int) -> tuple[bool, str]:
    """Применимость cupyx.signal.channelize_poly (шаг 4.3)."""
    if n_chans <= 0:
        return False, "n_chans <= 0"
    if int(taps_per_ch) > MAX_TAPS_PER_CHAN:
        return (False,
                f"taps/chan {taps_per_ch} > {MAX_TAPS_PER_CHAN} — свой PFB")
    if int(taps_per_ch) < 1:
        return False, "taps/chan < 1"
    return True, ""


def design_prototype(n_chans: int, taps_per_ch: int) -> np.ndarray:
    """Прототип ФНХ: срез на краю канала (Nyquist децимированной сетки),
    усиление ×M для единичной амплитуды в канале. Длина = M*taps."""
    from scipy.signal import firwin

    m = int(n_chans)
    tp = int(taps_per_ch)
    h = firwin(m * tp, cutoff=1.0 / m, window="hann", fs=2.0)
    return (h * m).astype(np.float32)


class Channelizer:
    """Полифазный канализатор кадра: (N,) complex → (n_frames, M) complex."""

    def __init__(self, n_chans: int, taps_per_ch: int = 8,
                 xp=None, h: "np.ndarray | None" = None,
                 prefer_channelize_poly: bool = True):
        self.m = int(n_chans)
        self.tp = int(taps_per_ch)
        self.xp = xp if xp is not None else xputil.backend("auto")
        h_np = design_prototype(self.m, self.tp) if h is None else np.asarray(h, dtype=np.float32)
        if h_np.size != self.m * self.tp:
            raise ValueError(f"len(h)={h_np.size} != M*taps={self.m * self.tp}")
        self.h = self.xp.asarray(h_np)
        self.hp = self.h.reshape(self.tp, self.m)
        ok, why = channelize_poly_ok(self.m, self.tp)
        self.use_cp = bool(prefer_channelize_poly and ok and
                         self.xp is not np and _has_channelize_poly(self.xp))
        self.backend_name = ("cupyx.signal.channelize_poly" if self.use_cp
                             else f"custom-pfb ({why or 'numpy backend'})")

    def channelize(self, x) -> "object":
        """(N,) complex → (N//M - tp + 1, M) complex64, бины в порядке FFT."""
        xp = self.xp
        x = xp.asarray(x)
        n_fr = x.size // self.m
        if n_fr < self.tp:
            raise ValueError(f"кадр {x.size} сэмплов короче M*taps={self.m * self.tp}")
        if self.use_cp:
            from cupyx.scipy.signal import channelize_poly  # type: ignore

            y = channelize_poly(x, self.h, self.m)  # (M, n_out)
            return y.T  # (n_out, M) — тот же лейаут, что у custom
        xb = x[: n_fr * self.m].reshape(n_fr, self.m)
        n_out = n_fr - self.tp + 1
        z = xp.zeros((n_out, self.m), dtype=xp.complex64)
        for j in range(self.tp):
            z += xb[j: j + n_out] * self.hp[self.tp - 1 - j]
        return xp.fft.fft(z, axis=1)

    def ch_power(self, y) -> "object":
        """CH_PWR_gpu: средняя мощность по каналам за кадр (шаг 4.4/4.6)."""
        return self.xp.mean(self.xp.abs(y) ** 2, axis=0)

    def channel_freq(self, k: int, fs_hz: float) -> float:
        """Частота канала относительно LO, Гц (порядок бинов FFT)."""
        k = int(k) % self.m
        if k >= self.m // 2:
            k -= self.m
        return k * float(fs_hz) / self.m


def _has_channelize_poly(xp) -> bool:
    try:
        from cupyx.scipy.signal import channelize_poly  # noqa: F401

        return True
    except Exception:
        return False
