#!/usr/bin/env python3
"""FHSS с IQ: STFT → порог → dwell → hop-set / шаг / скорость.

Метод как PMC11314967 (61.44 MSPS, IBW 56 МГц — ровно bladeRF xA4):
  кадр STFT, бинаризация относительно медианы кадра, склейка бинов в dwell,
  смена центра = hop. Не CNN и не угадывание следующего канала.

xA4:
  61.44 MSPS / nfft 4096 → Δt ≈ 66.7 мкс, Δf ≈ 15 кГц (шаг Crossfire 260 кГц виден).
  900 ISM 26 МГц входит в IBW; 2.4 ISM 83.5 МГц — hop-set в одном кадре обрезан.
  Канализатор 2 МГц hop-set убивает: крутим на широком IQ до выреза.

Не демодулятор. ПЕРЕДАТЬ протоколы не целится.
"""
from __future__ import annotations

import math
from typing import Any

import numpy as np

from protocol_db import XA4_IBW_MHZ, classify_fhss_domain, classify_rc

FHSS_NFFT_FAST = 4096
FHSS_HOP_FAST = 2048
FHSS_MAX_S = 0.160  # 160 мс = ATTACK_RC_S: три hop на 19 Гц mLRS; 80 мс не хватало
FHSS_DG_DB = 14.0  # PMC Algorithm 1
FHSS_MIN_HOPS = 3
FHSS_MIN_FRAMES = 2
FHSS_MIN_SPACING_MHZ = 0.15  # ниже — chirp/утечка STFT, не сетка RC


def _nfft_for(fs: float) -> tuple[int, int]:
    rate = float(fs)
    if rate >= 30e6:
        return FHSS_NFFT_FAST, FHSS_HOP_FAST
    if rate >= 8e6:
        return 2048, 1024
    if rate >= 2e6:
        return 512, 256
    return 256, 128


def stft_db(x: np.ndarray, nfft: int, hop: int) -> tuple[np.ndarray, np.ndarray]:
    """Сдвинутая мощность STFT, дБ. Кадры × бины."""
    z = np.asarray(x, dtype=np.complex64).ravel()
    nfft = int(nfft)
    hop = int(max(1, hop))
    if z.size < nfft:
        return np.zeros((0, nfft), dtype=np.float64), np.zeros(0)
    nframes = 1 + (int(z.size) - nfft) // hop
    win = np.hanning(nfft).astype(np.float64)
    scale = float(np.sum(win * win)) + 1e-20
    out = np.empty((nframes, nfft), dtype=np.float64)
    for i in range(nframes):
        sl = z[i * hop : i * hop + nfft]
        spec = np.fft.fft(sl * win)
        p = (np.abs(spec) ** 2) / scale
        out[i] = 10.0 * np.log10(np.maximum(p, 1e-20))
    return np.fft.fftshift(out, axes=1), np.fft.fftshift(np.fft.fftfreq(nfft, d=1.0 / 1.0))


def _clusters(row: np.ndarray, freqs_mhz: np.ndarray, thr: float) -> list[tuple[float, float, float]]:
    """(center_mhz, bw_mhz, peak_db) над порогом."""
    above = row >= thr
    out: list[tuple[float, float, float]] = []
    i = 0
    n = int(above.size)
    while i < n:
        if not above[i]:
            i += 1
            continue
        j = i + 1
        while j < n and above[j]:
            j += 1
        sl = row[i:j]
        k = i + int(np.argmax(sl))
        bw = float(freqs_mhz[j - 1] - freqs_mhz[i]) if j > i else 0.0
        out.append((float(freqs_mhz[k]), max(bw, 0.0), float(row[k])))
        i = j
    return out


def analyze_fhss(x: np.ndarray, fs: float, lo_mhz: float) -> dict[str, Any]:
    """Широкий IQ → hop-set, dwell, шаг, скорость. lo_mhz — RF центр кадра."""
    empty = {
        "hit": False,
        "hops": 0,
        "unique": 0,
        "hopSetMhz": [],
        "spacingMhz": 0.0,
        "dwellMs": 0.0,
        "intervalMs": 0.0,
        "rateHz": 0.0,
        "hopBwMhz": 0.0,
        "spanMhz": 0.0,
        "fLowMhz": 0.0,
        "fHighMhz": 0.0,
        "windowLimited": False,
        "ibwMhz": min(XA4_IBW_MHZ, float(fs) / 1e6 if fs else 0.0),
        "hint": "мало IQ или нет смены частоты",
        "domain": None,
    }
    z = np.asarray(x, dtype=np.complex64).ravel()
    rate = float(fs)
    lo = float(lo_mhz)
    if z.size < 256 or rate <= 0:
        return empty
    nfft, hop = _nfft_for(rate)
    max_n = int(min(z.size, max(nfft * 4, rate * FHSS_MAX_S)))
    z = z[-max_n:]
    db, bins = stft_db(z, nfft, hop)
    if db.shape[0] < 3:
        return empty
    freqs = lo + (bins * (rate / 1e6))
    df = abs(float(freqs[1] - freqs[0])) if freqs.size > 1 else 0.05
    gate = max(df * 2.0, 0.08)
    tracks: list[dict[str, Any]] = []
    closed: list[dict[str, Any]] = []

    def close_stale(frame: int) -> None:
        keep: list[dict[str, Any]] = []
        for t in tracks:
            if frame - int(t["last"]) >= 1:
                if int(t["last"]) - int(t["start"]) + 1 >= FHSS_MIN_FRAMES:
                    closed.append(t)
            else:
                keep.append(t)
        tracks[:] = keep

    for fi, row in enumerate(db):
        noise = float(np.median(row))
        thr = noise + FHSS_DG_DB
        peaks = _clusters(row, freqs, thr)
        used = [False] * len(peaks)
        for t in tracks:
            best_i = -1
            best_d = gate
            for i, (f, _bw, _p) in enumerate(peaks):
                if used[i]:
                    continue
                d = abs(f - float(t["freq"]))
                if d < best_d:
                    best_d = d
                    best_i = i
            if best_i >= 0:
                f, bw, p = peaks[best_i]
                used[best_i] = True
                n = int(t["n"]) + 1
                t["freq"] = (float(t["freq"]) * (n - 1) + f) / n
                t["bw"] = (float(t["bw"]) * (n - 1) + bw) / n
                t["pwr"] = max(float(t["pwr"]), p)
                t["n"] = n
                t["last"] = fi
        for i, (f, bw, p) in enumerate(peaks):
            if used[i]:
                continue
            tracks.append({"freq": f, "bw": bw, "pwr": p, "start": fi, "last": fi, "n": 1})
        close_stale(fi)
    close_stale(db.shape[0] + 1)

    if len(closed) < 2:
        empty["hops"] = len(closed)
        empty["hint"] = "одна частота или короткие вспышки — не FHSS"
        return empty

    dt = hop / rate
    durs = [(int(t["last"]) - int(t["start"]) + 1) * dt for t in closed]
    starts = [int(t["start"]) * dt for t in closed]
    centers = [float(t["freq"]) for t in closed]
    bws = [float(t["bw"]) for t in closed]
    order = np.argsort(starts)
    starts_s = [starts[i] for i in order]
    centers_s = [centers[i] for i in order]
    if len(starts_s) >= 2:
        gaps = np.diff(np.asarray(starts_s, dtype=np.float64))
        gaps = gaps[gaps > dt * 0.5]
        interval = float(np.median(gaps)) if gaps.size else 0.0
    else:
        interval = 0.0
    uniq = _unique_set(centers, gate)
    spacing = _mode_delta(uniq)
    if len(uniq) < FHSS_MIN_HOPS or spacing < FHSS_MIN_SPACING_MHZ:
        empty["hops"] = len(closed)
        empty["unique"] = len(uniq)
        empty["spacingMhz"] = float(spacing)
        empty["hint"] = "chirp/тон или мало каналов — не FHSS-сетка"
        return empty
    span = float(max(uniq) - min(uniq)) if len(uniq) >= 2 else 0.0
    ibw = min(XA4_IBW_MHZ, rate / 1e6)
    limited = span >= 0.82 * ibw
    dwell = float(np.median(durs)) if durs else 0.0
    rate_hz = (1.0 / interval) if interval > 0 else 0.0
    mid = float(np.median(centers))
    domain = (
        classify_fhss_domain(spacing, mid, float(min(uniq)), float(max(uniq))) if spacing > 0 else None
    )
    hint = "FHSS: смена частоты в кадре"
    if domain:
        hint = domain["hint"]
    if limited:
        hint += f" · окно xA4 ≈{ibw:.0f} МГц, hop-set может быть обрезан"
    return {
        "hit": True,
        "hops": len(closed),
        "unique": len(uniq),
        "hopSetMhz": [round(f, 4) for f in uniq[:64]],
        "spacingMhz": float(spacing),
        "dwellMs": dwell * 1e3,
        "intervalMs": interval * 1e3,
        "rateHz": rate_hz,
        "hopBwMhz": float(np.median(bws)) if bws else 0.0,
        "spanMhz": span,
        "fLowMhz": float(min(uniq)) if uniq else 0.0,
        "fHighMhz": float(max(uniq)) if uniq else 0.0,
        "windowLimited": bool(limited),
        "ibwMhz": float(ibw),
        "hint": hint,
        "domain": domain,
        "pathMhz": [round(centers_s[i], 4) for i in range(min(32, len(centers_s)))],
    }


def _unique_set(freqs: list[float], gate: float) -> list[float]:
    if not freqs:
        return []
    xs = sorted(freqs)
    groups: list[list[float]] = [[xs[0]]]
    for f in xs[1:]:
        if abs(f - groups[-1][-1]) <= gate:
            groups[-1].append(f)
        else:
            groups.append([f])
    return [float(np.mean(g)) for g in groups]


def _mode_delta(freqs: list[float]) -> float:
    if len(freqs) < 2:
        return 0.0
    xs = sorted(freqs)
    deltas = [xs[i] - xs[i - 1] for i in range(1, len(xs)) if xs[i] - xs[i - 1] >= 0.12]
    if not deltas:
        return 0.0
    bins: dict[float, int] = {}
    for d in deltas:
        key = round(d * 20.0) / 20.0
        bins[key] = bins.get(key, 0) + 1
    return max(bins.items(), key=lambda kv: kv[1])[0]


def attach_rc(fhss: dict[str, Any], rc: dict[str, Any] | None, freq_mhz: float) -> dict[str, Any]:
    """Переклассификация RC с шагом hop, если FHSS его снял."""
    from protocol_db import band_of

    if not rc:
        rc = {"id": "rc-unknown", "label": "узкий RC", "hint": "", "rateHz": 0.0, "css": False}
    spacing = float(fhss.get("spacingMhz") or 0.0)
    rate = float(rc.get("rateHz") or fhss.get("rateHz") or 0.0)
    css = bool(rc.get("css"))
    cls = classify_rc(rate, css, band_of(freq_mhz), spacing, freq_mhz)
    return {
        **rc,
        **cls,
        "rateHz": rate,
        "css": css,
        "spacingMhz": spacing,
    }


def synth_fhss(
    fs: float,
    lo_mhz: float,
    hops_mhz: list[float],
    dwell_s: float,
    amp: float = 0.35,
) -> np.ndarray:
    """Синтез hop-поезда для тестов. Не эфирный TX."""
    rate = float(fs)
    dwell_n = max(16, int(round(rate * dwell_s)))
    n = dwell_n * max(1, len(hops_mhz))
    x = np.zeros(n, dtype=np.complex64)
    t = np.arange(dwell_n, dtype=np.float64) / rate
    pos = 0
    for f in hops_mhz:
        df = (float(f) - float(lo_mhz)) * 1e6
        x[pos : pos + dwell_n] = (amp * np.exp(1j * 2.0 * math.pi * df * t)).astype(np.complex64)
        pos += dwell_n
    return x
