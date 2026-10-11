"""Кадр I/Q лабораторного приёма (шаги 3.7, 4.7).

Формат на проводе: BLADERF_FORMAT_SC16_Q11 — int16 LE, I первый, Q второй,
4 байта/сэмпл. При 20 MSPS — 80 МБ/с. Значение int16 хранит знаковый
Q1.11, поэтому комплексная нормировка = int16 / 2048.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

SC16_Q11_SCALE = 2048.0  # Q1.11: полная шкала int16 >> 4? Нет: 2^11
BYTES_PER_SAMPLE = 4  # int16 I + int16 Q


@dataclass
class Frame:
    """Один кадр I/Q + привязка к sample_count и perf_counter (шаг 4.7).

    int16: (n*2,) interleaved I,Q — вид из C-читателя, без копии.
    t_first / t_done — секунды, CLOCK_MONOTONIC (== time.perf_counter()).
    sample_count — номер ПЕРВОГО сэмпла кадра от старта потока.
    """

    int16: np.ndarray  # (2*n,) int16 LE, I first Q second
    n_samples: int
    sample_count: int
    t_first: float
    t_done: float
    fs_hz: float

    def complex64(self) -> np.ndarray:
        """Нормированная комплексная копия: int16 Q1.11 → float32 [-1, 1)."""
        f = self.int16.astype(np.float32) / np.float32(SC16_Q11_SCALE)
        return f[0::2] + 1j * f[1::2]

    @property
    def t_mid(self) -> float:
        return 0.5 * (self.t_first + self.t_done)

    @property
    def duration_s(self) -> float:
        return self.n_samples / self.fs_hz if self.fs_hz > 0 else 0.0
