"""Спектрограмма/спектр на xp (классификатор шаг 5, визуализация шаг 8).

STFT: stride-tricks окна → rfft → 10·log10(|X|²+eps). Формат выхода:
(F, T) float32, F = nfft//2+1 (только положительные частоты rfft — для
классификатора) или fftshift полного FFT для вьювера (spectrum_db).
"""
from __future__ import annotations

import numpy as np

EPS = 1e-12


def stft_db(x, nfft: int, hop: int, xp, window: str = "hann"):
    """(N,) → (F, T) dB float32. Окна по hop; комплексный вход — полный
    fft с fftshift (двусторонний спектр, каналы PFB-сетки совпадают с
    бинами при nfft == n_chans)."""
    x = xp.asarray(x)
    n_fr = 1 + (x.size - nfft) // hop
    if n_fr < 1:
        raise ValueError(f"сэмплов {x.size} < nfft {nfft}")
    shape = (n_fr, nfft)
    strides = (x.strides[0] * hop, x.strides[0])
    win = _window(window, nfft, xp).astype(x.real.dtype)
    fr = xp.lib.stride_tricks.as_strided(x, shape=shape, strides=strides)
    spec = xp.fft.fftshift(xp.fft.fft(fr * win, axis=1), axes=1)
    pwr = xp.abs(spec) ** 2
    return (10.0 * xp.log10(pwr + EPS)).astype(xp.float32).T  # (F, T)


def spectrum_db(x, nfft: int, hop: int, xp) -> "object":
    """Усреднённый по кадру спектр (F,) dB — строка для вьювера (шаг 8)."""
    s = stft_db(x, nfft, hop, xp)
    return s.mean(axis=1)


def _window(name: str, n: int, xp):
    if name == "hann":
        return xp.hanning(n)
    if name == "rect":
        return xp.ones(n)
    raise ValueError(f"окно {name}")


def norm_db(s_db, xp=None, floor_db: float = -120.0, ceil_db: float = -20.0):
    """Нормировка dB → [0, 1] float32 для входа CNN (фиксированная шкала,
    чтобы амплитудная калибровка классов не плавала между прогонами)."""
    if xp is None:
        from . import xputil

        xp = xputil.backend("auto")
    n = (s_db - floor_db) / (ceil_db - floor_db)
    return xp.clip(n, 0.0, 1.0).astype(xp.float32)
