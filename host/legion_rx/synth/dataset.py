"""Датасет спектрограмм из синтеза (шаги 5.3, 5.6).

Окно классификации: 5 мс при 20 MSPS = 100 000 сэмплов; STFT nfft=256,
hop=780 → (256, 128) dB → norm [0,1]. Это и есть вход CNN (шаг 5.4).
Обучение — ОТДЕЛЬНЫЙ этап (5.6): здесь только построение массивов.
"""
from __future__ import annotations

import numpy as np

from ..spectrogram import norm_db, stft_db
from .protocols import CLASS_LO_HZ, CLASSES, GENERATORS

FS = 20.0e6
WIN_S = 0.005  # 5 мс на образец — окно классификатора
NFFT = 256
HOP = 780  # 100000/128 ≈ 781; 780 даёт T=128 ровно при N=100000
SPEC_T = 128


def spec_from_iq(iq: np.ndarray, nfft: int = NFFT, hop: int = HOP) -> np.ndarray:
    """I/Q → (1, F, T) float32 [0,1] — готовый тензор для CNN."""
    s = stft_db(np.asarray(iq), nfft, hop, np)  # (F, T) dB
    n = norm_db(s, np)
    if n.shape[1] >= SPEC_T:
        n = n[:, :SPEC_T]
    else:
        n = np.pad(n, ((0, 0), (0, SPEC_T - n.shape[1])))
    return n[np.newaxis, :, :]


def build_synth_dataset(n_per_class: int, fs: float = FS,
                        classes: "list[str] | None" = None,
                        seed: int = 1, snr_range=(5.0, 30.0),
                        win_s: float = WIN_S) -> dict:
    """n_per_class образцов на класс: X (N,1,256,128), y (N,), мета-список.
    SNR случайный из snr_range — разброс, как в эфире."""
    rng = np.random.default_rng(seed)
    names = list(classes or CLASSES)
    xs, ys, metas = [], [], []
    for ci, name in enumerate(names):
        gen = GENERATORS[name]
        for i in range(n_per_class):
            snr = float(rng.uniform(*snr_range))
            out = gen(fs=fs, dur=win_s, lo_hz=CLASS_LO_HZ[name],
                      seed=int(rng.integers(0, 2 ** 31)), snr_db=snr)
            xs.append(spec_from_iq(out["iq"]))
            ys.append(ci)
            m = dict(out["meta"])
            for k in ("hop_times_s", "hop_freqs_hz", "hop_visible"):
                m.pop(k, None)  # массивы ground truth — только в synth, не в датасете
            metas.append(m)
    x = np.stack(xs).astype(np.float32)
    y = np.asarray(ys, dtype=np.int64)
    perm = rng.permutation(len(y))
    return {"X": x[perm], "y": y[perm], "classes": names,
            "meta": [metas[i] for i in perm],
            "spec_shape": (NFFT, SPEC_T), "fs": fs, "win_s": win_s}
