"""Спектр 256 точек на компьютере вместо legion_fft_peak.

Слово как в HDL: [7:0] bin, [23:8] mag16, [30:24] frame, [31] valid.
bin = round(offset / fs * 256) по модулю 256. DC (bin 0) пропускается.
mag16 = (дБ над медианой) * 256, чтобы порог слота 256 означал 1 дБ.
"""

from __future__ import annotations

import math


def _fft256(i_samp: list[float], q_samp: list[float]) -> list[float]:
    n = 256
    if len(i_samp) < n or len(q_samp) < n:
        raise ValueError("нужно минимум 256 комплексных отсчётов")
    ii = i_samp[-n:]
    qq = q_samp[-n:]
    mag = [0.0] * n
    for k in range(n):
        sr = 0.0
        si = 0.0
        ang = -2.0 * math.pi * k / n
        for t in range(n):
            c = math.cos(ang * t)
            s = math.sin(ang * t)
            sr += ii[t] * c - qq[t] * s
            si += ii[t] * s + qq[t] * c
        mag[k] = math.hypot(sr, si)
    return mag


def peak_word_from_iq(
    i_samp: list[float],
    q_samp: list[float],
    frame: int,
    dc_notch: bool = True,
) -> int:
    mag = _fft256(i_samp, q_samp)
    order = sorted(range(256), key=lambda k: mag[k], reverse=True)
    best = next((k for k in order if not dc_notch or k != 0), 0)
    ranked = sorted(mag)
    median = ranked[128]
    db = 0.0 if mag[best] <= median or median <= 0 else 20.0 * math.log10(mag[best] / median)
    mag16 = max(0, min(0xFFFF, int(round(db * 256.0))))
    valid = 1 if mag16 > 0 else 0
    return (
        (valid << 31)
        | ((int(frame) & 0x7F) << 24)
        | (mag16 << 8)
        | (best & 0xFF)
    ) & 0xFFFFFFFF
