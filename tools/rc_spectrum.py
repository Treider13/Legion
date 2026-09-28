#!/usr/bin/env python3
"""ELRS vs mLRS по спектру: CSS (LoRa) + интервал пакетов.

Факты (не маркетинг):
  ExpressLRS common.h / expresslrs.org Signal Health:
    2.4 LoRa: 25/50/100/150/200/250/333/500 Гц, SX1280 BW 812.5 кГц
    2.4 FLRC: 250/500/1000 Гц (и DVDA с тем же эфирным шагом)
    900 LoRa: 25/50/100/150/200/250/333/500 Гц
  olliw42/mLRS README:
    2.4 LoRa: 50 / 31 / 19 Гц; FLRC 111 Гц
    868/915 LoRa: 31 / 19 Гц; FSK 50 Гц
  50 Гц LoRa — пересечение ELRS и mLRS: уникально не приписать.
  Без двух пакетов в окне — только CSS/FLRC, не имя.

xA4: канал ~2 MSPS после децимации. 160 мс кольца хватает на 19 Гц.
"""
from __future__ import annotations

import math
from typing import Any

import numpy as np

ELRS_24_LORA = (25.0, 50.0, 100.0, 150.0, 200.0, 250.0, 333.0, 500.0)
ELRS_24_FLRC = (250.0, 333.0, 500.0, 1000.0)
MLRS_24_LORA = (19.0, 31.0, 50.0)
MLRS_24_FLRC = (111.0,)
ELRS_900_LORA = (25.0, 50.0, 100.0, 150.0, 200.0, 250.0, 333.0, 500.0)
MLRS_900_LORA = (19.0, 31.0)
MLRS_900_FSK = (50.0,)

SX1280_LORA_BW = 812_500.0
CSS_HIT = 1.55
RATE_TOL = 0.10


def _nearest(rate: float, table: tuple[float, ...]) -> tuple[float, float]:
    if rate <= 0 or not table:
        return 0.0, 1e9
    best = min(table, key=lambda x: abs(x - rate) / x)
    err = abs(best - rate) / best
    return best, err


def _in_table(rate: float, table: tuple[float, ...]) -> float | None:
    best, err = _nearest(rate, table)
    if err <= RATE_TOL:
        return best
    return None


def envelope_packets(x: np.ndarray, fs: float) -> dict[str, Any]:
    """Пачки по огибающей: интервал стартов и длительность."""
    empty = {
        "n": 0,
        "intervalS": 0.0,
        "rateHz": 0.0,
        "durS": 0.0,
        "starts": [],
    }
    z = np.asarray(x, dtype=np.complex64).ravel()
    if z.size < 64 or fs <= 0:
        return empty
    mag = np.abs(z)
    win = max(8, int(round(fs * 0.00015)))
    if win > 1:
        ker = np.ones(win, dtype=np.float64) / float(win)
        mag = np.convolve(mag, ker, mode="same")
    noise = float(np.median(mag))
    peak = float(np.max(mag))
    if peak < 4.0 * (noise + 1e-12):
        return empty
    thr = noise + 0.35 * (peak - noise)
    above = mag > thr
    starts: list[int] = []
    ends: list[int] = []
    on = False
    s0 = 0
    min_gap = max(4, int(round(fs * 0.0003)))
    min_len = max(8, int(round(fs * 0.0002)))
    for i, a in enumerate(above):
        if a and not on:
            if not starts or i - starts[-1] >= min_gap:
                on = True
                s0 = i
        elif on and not a:
            if i - s0 >= min_len:
                starts.append(s0)
                ends.append(i)
            on = False
    if on and (z.size - s0) >= min_len:
        starts.append(s0)
        ends.append(int(z.size))
    if len(starts) < 1:
        return empty
    durs = [(e - s) / fs for s, e in zip(starts, ends)]
    dur = float(np.median(durs)) if durs else 0.0
    if len(starts) >= 2:
        gaps = np.diff(np.asarray(starts, dtype=np.float64)) / fs
        gaps = gaps[gaps > 0.0004]
        interval = float(np.median(gaps)) if gaps.size else 0.0
    else:
        interval = 0.0
    rate = (1.0 / interval) if interval > 0 else 0.0
    return {
        "n": len(starts),
        "intervalS": interval,
        "rateHz": rate,
        "durS": dur,
        "starts": starts[:32],
    }


def _fft_sharp(z: np.ndarray) -> float:
    spec = np.abs(np.fft.fft(z * np.hanning(int(z.size))))
    mid = spec.copy()
    mid[:4] = 0
    mid[-4:] = 0
    return float(np.max(mid)) / (float(np.median(spec)) + 1e-20)


def css_score(x: np.ndarray, fs: float, bw: float = SX1280_LORA_BW) -> float:
    """Во сколько раз dechirp острее сырого FFT. LoRa ≫ 1, FLRC ≈ 1."""
    z = np.asarray(x, dtype=np.complex128).ravel()
    if z.size < 64 or fs <= 0:
        return 0.0
    n = min(int(z.size), int(round(fs * 0.008)))
    z = z[:n]
    t = np.arange(n, dtype=np.float64) / fs
    k = bw / max(t[-1], 1e-9)
    up = np.exp(1j * 2.0 * math.pi * (0.5 * k * t * t - 0.5 * bw * t))
    raw = _fft_sharp(z)
    best = max(_fft_sharp(z * up), _fft_sharp(z * np.conj(up)))
    return best / (raw + 1e-12)


def packet_css(x: np.ndarray, fs: float, starts: list[int], dur_s: float) -> float:
    if not starts:
        return css_score(x, fs)
    n = max(32, int(round(dur_s * fs))) if dur_s > 0 else int(round(fs * 0.002))
    scores: list[float] = []
    for s in starts[:8]:
        chunk = x[s : s + n]
        if chunk.size < 32:
            continue
        scores.append(css_score(chunk, fs))
    return float(np.median(scores)) if scores else css_score(x, fs)


def classify_rc(rate_hz: float, css: bool, band: str) -> dict[str, Any]:
    """Имя только когда сетка не пересекается. 50 Гц LoRa — dual."""
    rate = float(rate_hz)
    b900 = band == "p900"
    if css:
        if _in_table(rate, MLRS_24_LORA if not b900 else MLRS_900_LORA) in (19.0, 31.0):
            hit = _in_table(rate, MLRS_24_LORA if not b900 else MLRS_900_LORA)
            return {
                "id": "mlrs",
                "label": f"mLRS LoRa {hit:.0f} Гц",
                "hint": "CSS + 19/31 Гц — сетка olliw42/mLRS, не ELRS",
                "matchedHz": hit,
            }
        if _in_table(rate, (50.0,)):
            return {
                "id": "elrs-mlrs-50",
                "label": "LoRa 50 Гц (ELRS или mLRS)",
                "hint": "50 Гц CSS есть и у ELRS, и у mLRS — уникально не приписать",
                "matchedHz": 50.0,
            }
        table = ELRS_900_LORA if b900 else ELRS_24_LORA
        hit = _in_table(rate, table)
        if hit and hit != 50.0:
            return {
                "id": "elrs",
                "label": f"ELRS LoRa {hit:.0f} Гц",
                "hint": "CSS + скорость ELRS (100…500 Гц / 25 Гц) — mLRS таких 2.4-режимов нет",
                "matchedHz": hit,
            }
        return {
            "id": "rc-unknown",
            "label": "CSS / LoRa-подобно",
            "hint": "chirp есть, интервал не сел на сетку ELRS/mLRS",
            "matchedHz": 0.0,
        }
    # не CSS: FLRC / FSK
    if not b900:
        if _in_table(rate, MLRS_24_FLRC):
            return {
                "id": "mlrs",
                "label": "mLRS FLRC 111 Гц",
                "hint": "без CSS, ~9 мс — FLRC mLRS; ELRS FLRC 250/500/1000",
                "matchedHz": 111.0,
            }
        hit = _in_table(rate, ELRS_24_FLRC)
        if hit:
            return {
                "id": "elrs",
                "label": f"ELRS FLRC {hit:.0f} Гц",
                "hint": "без CSS, 250…1000 Гц — сетка ExpressLRS FLRC/FSK",
                "matchedHz": hit,
            }
    else:
        if _in_table(rate, MLRS_900_FSK):
            return {
                "id": "elrs-mlrs-50",
                "label": "900 50 Гц без CSS",
                "hint": "50 Гц на 900: ELRS LoRa/DVDA, mLRS FSK, Crossfire — не разделить",
                "matchedHz": 50.0,
            }
        hit = _in_table(rate, ELRS_900_LORA)
        if hit and hit >= 100.0:
            return {
                "id": "elrs",
                "label": f"ELRS 900 {hit:.0f} Гц",
                "hint": "≥100 Гц на 900 — сетка ELRS; mLRS 900 только 19/31 (и FSK 50)",
                "matchedHz": hit,
            }
        if _in_table(rate, MLRS_900_LORA):
            hit = _in_table(rate, MLRS_900_LORA)
            return {
                "id": "mlrs",
                "label": f"mLRS 900 {hit:.0f} Гц",
                "hint": "19/31 Гц на 900 — mLRS; ELRS 900 так низко не ходит (кроме 25)",
                "matchedHz": hit,
            }
    if rate <= 0:
        return {
            "id": "rc-unknown",
            "label": "узкий RC, мало пакетов",
            "hint": "нужно ≥2 пакета в окне памяти (~160 мс) чтобы снять интервал",
            "matchedHz": 0.0,
        }
    return {
        "id": "rc-unknown",
        "label": "узкий RC, сетка не сошлась",
        "hint": "интервал не ELRS и не mLRS — не имя фирмы",
        "matchedHz": 0.0,
    }


def band_of(freq_mhz: float) -> str:
    if 850 <= freq_mhz <= 950:
        return "p900"
    if 2400 <= freq_mhz <= 2500:
        return "s24"
    return "other"


def analyze_rc(x: np.ndarray, fs: float, freq_mhz: float = 2442.0) -> dict[str, Any]:
    """CSS + интервал → elrs / mlrs / 50 Гц dual / unknown."""
    band = band_of(freq_mhz)
    empty = {
        "id": "rc-unknown",
        "label": "узкий RC",
        "hint": "мало IQ для интервала/chirp",
        "rateHz": 0.0,
        "intervalMs": 0.0,
        "css": False,
        "cssScore": 0.0,
        "packets": 0,
        "band": band,
        "matchedHz": 0.0,
    }
    z = np.asarray(x, dtype=np.complex64).ravel()
    if z.size < 128 or fs <= 0:
        return empty
    env = envelope_packets(z, fs)
    score = packet_css(z, fs, env["starts"], float(env["durS"]))
    css = score >= CSS_HIT
    cls = classify_rc(float(env["rateHz"]), css, band)
    return {
        **cls,
        "rateHz": float(env["rateHz"]),
        "intervalMs": float(env["intervalS"]) * 1e3,
        "css": bool(css),
        "cssScore": float(score),
        "packets": int(env["n"]),
        "band": band,
        "durMs": float(env["durS"]) * 1e3,
    }


def synth_lora_upchirp(n: int, fs: float, bw: float = SX1280_LORA_BW) -> np.ndarray:
    t = np.arange(int(n), dtype=np.float64) / float(fs)
    k = bw / max(t[-1] if n > 1 else 1e-6, 1e-9)
    return (0.35 * np.exp(1j * 2.0 * math.pi * (0.5 * k * t * t - 0.5 * bw * t))).astype(np.complex64)


def synth_flrc_packet(n: int, fs: float) -> np.ndarray:
    """Узкий пакет без линейного chirp (GMSK-подобно)."""
    rng = np.random.default_rng(4)
    bits = rng.integers(0, 2, size=max(8, n // 8))
    ups = np.repeat(2.0 * bits.astype(np.float64) - 1.0, max(1, n // bits.size))[:n]
    if ups.size < n:
        ups = np.pad(ups, (0, n - ups.size))
    phase = np.cumsum(0.7 * ups) * (2.0 * math.pi * 40e3 / fs)
    return (0.35 * np.exp(1j * phase)).astype(np.complex64)


def synth_rc_train(
    fs: float,
    rate_hz: float,
    n: int,
    css: bool = True,
    pkt_s: float = 0.0012,
) -> np.ndarray:
    interval = max(8, int(round(fs / max(rate_hz, 1.0))))
    pkt_n = max(32, int(round(fs * pkt_s)))
    pkt = synth_lora_upchirp(pkt_n, fs) if css else synth_flrc_packet(pkt_n, fs)
    x = np.zeros(int(n), dtype=np.complex64)
    pos = interval // 4
    while pos + pkt_n < n:
        x[pos : pos + pkt_n] += pkt
        pos += interval
    return x
