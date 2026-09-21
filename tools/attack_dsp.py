#!/usr/bin/env python3
"""
Глаза хост-Атаки на IQ. Только attack_scan / attack_think.
scan() / FPGA / ESP32 сюда не ходят.

Откуда формулы (код, не маркетинг):
  Thomson DPSS — scipy.signal.windows.dpss, трёхдиагональ Slepian
    (Percival & Walden; numpy.linalg.eigh_tridiagonal).
  ITU-R SM.443 / SM.328 — занятая полоса 99% (β/2=0.5%) и x-dB от пика.
  rtl-sdr-analyzer / labPsd.width3dbMhz — −3 дБ от пика.
  Spectral flatness — MPEG-7 / Wiener: геом. / арифм. среднее линейной PSD.
  FAM точка — PySDR cyclostationary + gr-specest cyclo_fam: сдвиг спектра на α.
  Вычет своей волны — корреляционное выравнивание + масштаб
    (первый каскад IBFD / Adaptive_SIC), затем короткий LMS.
  Кумулянты C20/C21/C40 — Swami & Sadler AMC.
"""
from __future__ import annotations

import math
from typing import Any

import numpy as np

ATTACK_MEM_CAP = 1 << 24  # 16 777 216 complex64 ≈ 273 мс @ 61.44 MSPS, ≈128 МБ
ATTACK_TAPERS = 3
ATTACK_NW = 2.5
ATTACK_FAM_ALPHAS = 16
ATTACK_LOOK_N = 8192
ATTACK_LMS_TAPS = 32
ATTACK_CLIP = 0.92

_DPSS: dict[tuple[int, int], np.ndarray] = {}


def _tridiag_matvec(diag: np.ndarray, off: np.ndarray, x: np.ndarray) -> np.ndarray:
    y = diag * x
    y[:-1] += off * x[1:]
    y[1:] += off * x[:-1]
    return y


def _tridiag_largest(diag: np.ndarray, off: np.ndarray, k: int, iters: int = 48) -> np.ndarray:
    """k старших векторов трёхдиагонали: итерация подпространства (без SciPy)."""
    n = int(diag.size)
    rng = np.random.default_rng(1)
    q = rng.normal(size=(n, k))
    q, _ = np.linalg.qr(q)
    for _ in range(iters):
        z = np.empty_like(q)
        for j in range(k):
            z[:, j] = _tridiag_matvec(diag, off, q[:, j])
        q, _ = np.linalg.qr(z)
    rays = np.array([float(q[:, j] @ _tridiag_matvec(diag, off, q[:, j])) for j in range(k)])
    order = np.argsort(rays)[::-1]
    return q[:, order]


def dpss_tapers(n: int, k: int = ATTACK_TAPERS, nw: float = ATTACK_NW) -> np.ndarray:
    """Первые k окон DPSS. Трёхдиагональ как у SciPy dpss, без SciPy."""
    n = int(n)
    k = max(1, min(int(k), n - 1))
    key = (n, k)
    cached = _DPSS.get(key)
    if cached is not None:
        return cached
    t = np.arange(n, dtype=np.float64)
    w = float(nw) / float(n)
    diag = ((n - 1.0 - 2.0 * t) / 2.0) ** 2 * np.cos(2.0 * np.pi * w)
    off = 0.5 * t[1:] * (n - t[1:])
    vecs = _tridiag_largest(diag, off, k)
    tapers = vecs.T.astype(np.float64)
    for i in range(k):
        s = float(np.sqrt(np.sum(tapers[i] ** 2)))
        if s > 0:
            tapers[i] /= s
        if tapers[i][n // 2] < 0:
            tapers[i] = -tapers[i]
    _DPSS[key] = tapers
    return tapers


def multitaper_dbm(x: np.ndarray, k: int = ATTACK_TAPERS) -> np.ndarray:
    """Thomson: среднее K эйгенспектров, дБм как welch_dbm (|X|²/N²)."""
    n = int(x.shape[-1]) if x.ndim == 1 else int(x.shape[1])
    if x.ndim == 1:
        frames = x.reshape(1, n)
    else:
        frames = x
    tapers = dpss_tapers(n, k)
    accum = np.zeros(n, dtype=np.float64)
    used = 0
    for fr in frames:
        for tap in tapers:
            spec = np.fft.fft(fr * tap)
            accum += np.abs(spec) ** 2
            used += 1
    avg = accum / float(max(used, 1))
    power = np.maximum(avg / (n * n), 1e-20)
    db = 10.0 * np.log10(power)
    db = np.fft.fftshift(db)
    half = n // 2
    if 0 < half < n - 1:
        db[half] = 0.5 * (db[half - 1] + db[half + 1])
    return db


def lin_from_dbm(dbm: np.ndarray) -> np.ndarray:
    return np.power(10.0, np.asarray(dbm, dtype=np.float64) / 10.0)


def spectral_flatness(dbm: np.ndarray) -> float:
    """Wiener / MPEG-7: геом. среднее / арифм. среднее линейной мощности."""
    lin = np.maximum(lin_from_dbm(dbm), 1e-20)
    if lin.size == 0:
        return 0.0
    g = float(np.exp(np.mean(np.log(lin))))
    a = float(np.mean(lin))
    if a <= 0:
        return 0.0
    return max(0.0, min(1.0, g / a))


def power_var_db(dbm: np.ndarray) -> float:
    if dbm.size < 2:
        return 0.0
    return float(np.var(np.asarray(dbm, dtype=np.float64)))


def _peak_index(dbm: np.ndarray, freqs: np.ndarray, peak_mhz: float) -> int:
    return int(np.argmin(np.abs(freqs - peak_mhz)))


def width_xd_b(dbm: np.ndarray, freqs: np.ndarray, peak_mhz: float, x_db: float) -> float:
    """x-dB от пика. −3 как rtl-sdr-analyzer / labPsd; −26 как ITU SM.443."""
    if dbm.size == 0:
        return 0.0
    i = _peak_index(dbm, freqs, peak_mhz)
    peak = float(dbm[i])
    if not math.isfinite(peak):
        return 0.0
    thr = peak - float(x_db)
    lo = i
    hi = i
    while lo > 0 and math.isfinite(float(dbm[lo - 1])) and float(dbm[lo - 1]) >= thr:
        lo -= 1
    while hi + 1 < dbm.size and math.isfinite(float(dbm[hi + 1])) and float(dbm[hi + 1]) >= thr:
        hi += 1
    return max(0.0, float(freqs[hi] - freqs[lo]))


def occupied_99(dbm: np.ndarray, freqs: np.ndarray, peak_mhz: float) -> float:
    """ITU SM.328: 99% мощности вокруг пика (по 0.5% с каждого края)."""
    if dbm.size < 4:
        return 0.0
    i = _peak_index(dbm, freqs, peak_mhz)
    lin = lin_from_dbm(dbm)
    floor = float(np.percentile(lin, 30))
    mask = lin >= floor * (10.0 ** 0.3)
    if not mask[i]:
        mask[i] = True
    lo = i
    hi = i
    while lo > 0 and mask[lo - 1]:
        lo -= 1
    while hi + 1 < lin.size and mask[hi + 1]:
        hi += 1
    sl = lin[lo : hi + 1]
    total = float(np.sum(sl))
    if total <= 0:
        return max(0.0, float(freqs[hi] - freqs[lo]))
    cut = 0.005 * total
    acc = 0.0
    left = 0
    while left < sl.size and acc + float(sl[left]) < cut:
        acc += float(sl[left])
        left += 1
    acc = 0.0
    right = sl.size - 1
    while right > left and acc + float(sl[right]) < cut:
        acc += float(sl[right])
        right -= 1
    return max(0.0, float(freqs[lo + right] - freqs[lo + left]))


def cepstrum_peak(dbm: np.ndarray) -> float:
    """Пик |цепстра| лог-PSD (JTIT 2008 picket-fence / OFDM). 0…1."""
    if dbm.size < 16:
        return 0.0
    logp = np.asarray(dbm, dtype=np.float64)
    c = np.abs(np.fft.ifft(logp))
    skip = max(2, c.size // 32)
    mid = c[skip : c.size // 2]
    if mid.size == 0:
        return 0.0
    peak = float(np.max(mid))
    mean = float(np.mean(c[skip:]))
    if mean <= 1e-12:
        return 0.0
    return max(0.0, min(1.0, (peak / mean - 1.0) / 8.0))


def point_fam(x: np.ndarray, fs: float) -> dict[str, float]:
    """Точечный FAM: когерентность на сетке α. Не полный SCF 56 МГц."""
    n = int(len(x))
    if n < 64 or fs <= 0:
        return {"alphaHz": 0.0, "coh": 0.0}
    win = 0.5 - 0.5 * np.cos(2.0 * np.pi * np.arange(n) / max(n - 1, 1))
    X = np.fft.fft(x * win)
    best_a = 0.0
    best_c = 0.0
    fmax = min(fs / 4.0, 2.0e6)
    mag = np.abs(X)
    for i in range(1, ATTACK_FAM_ALPHAS + 1):
        alpha = fmax * i / ATTACK_FAM_ALPHAS
        shift = int(round(alpha * n / fs))
        if shift <= 0 or shift >= n:
            continue
        rolled = np.roll(X, -shift)
        den = float(np.mean(mag * np.abs(rolled))) + 1e-20
        coh = abs(complex(np.mean(X * np.conj(rolled)))) / den
        if coh > best_c:
            best_c = coh
            best_a = alpha
    return {"alphaHz": float(best_a), "coh": float(best_c)}


def cumulants(x: np.ndarray) -> dict[str, float]:
    """C20/C21/C40 (Swami/Sadler), эксцесс |x|."""
    if len(x) < 16:
        return {"c20": 0.0, "c21": 0.0, "c40": 0.0, "kurt": 0.0}
    z = np.asarray(x, dtype=np.complex128)
    c21 = float(np.mean(np.abs(z) ** 2)) + 1e-20
    c20 = complex(np.mean(z * z))
    c40 = complex(np.mean(z**4)) - 3.0 * (c20**2)
    mag = np.abs(z)
    mu = float(np.mean(mag))
    var = float(np.mean((mag - mu) ** 2)) + 1e-20
    kurt = float(np.mean((mag - mu) ** 4) / (var * var))
    return {
        "c20": float(abs(c20) / c21),
        "c21": float(c21),
        "c40": float(abs(c40) / (c21**2)),
        "kurt": kurt,
    }


def classify_look(flat: float, cep: float, fam_coh: float, c20: float, kurt: float) -> dict[str, Any]:
    """Семья разбора, не имя фирмы."""
    if flat < 0.22:
        kind = "tone"
        ru = "похоже на тон"
    elif fam_coh >= 0.22 and flat < 0.7:
        kind = "cycle"
        ru = "есть цикл (энергия могла занизить ширину)"
    elif cep >= 0.22 and 0.25 <= flat < 0.75:
        kind = "ofdm"
        ru = "решётка / OFDM-подобно"
    elif flat >= 0.45:
        kind = "noise"
        ru = "плоский / шум-подобный"
    else:
        kind = "unknown"
        ru = "семья не ясна"
    conf = 0.35
    if kind == "tone":
        conf = min(0.95, 0.5 + (1.0 - flat) * 0.4)
    elif kind == "ofdm":
        conf = min(0.9, 0.4 + cep * 0.4 + flat * 0.2)
    elif kind == "cycle":
        conf = min(0.9, 0.4 + fam_coh)
    elif kind == "noise":
        conf = min(0.85, 0.35 + flat * 0.5)
    return {"kind": kind, "label": ru, "conf": float(conf)}


def detect_clip(x: np.ndarray) -> bool:
    if len(x) == 0:
        return False
    return bool(np.max(np.abs(x)) >= ATTACK_CLIP)


def align_scale_cancel(rx: np.ndarray, ref: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Вычет: сдвиг по макс. |корреляции| + комплексный масштаб.
    Как digital SI: correlate-and-delay, затем масштаб (Adaptive_SIC / Haykin).
    Возвращает (остаток, выровненную опору) — LMS дальше бьёт по выровненной, не по сырой."""
    n = int(len(rx))
    x = np.asarray(rx, dtype=np.complex64)
    if n < 16 or len(ref) < 16:
        return x, np.zeros(n, dtype=np.complex64)
    r = np.asarray(ref, dtype=np.complex64)
    if len(r) < n:
        reps = int(math.ceil(n / max(len(r), 1)))
        r = np.tile(r, reps)[:n]
    else:
        r = r[:n]
    nfft = 1 << int(math.ceil(math.log2(max(n * 2, 8))))
    corr = np.fft.ifft(np.fft.fft(x, nfft) * np.conj(np.fft.fft(r, nfft)))
    lag = int(np.argmax(np.abs(corr[:n])))
    rs = np.roll(r, lag)
    denom = complex(np.vdot(rs, rs))
    if abs(denom) < 1e-12:
        return x, rs.astype(np.complex64)
    g = complex(np.vdot(rs, x)) / denom
    return (x - g * rs).astype(np.complex64), rs.astype(np.complex64)


def lms_polish(rx: np.ndarray, ref: np.ndarray, taps: int = ATTACK_LMS_TAPS, mu: float = 0.008) -> np.ndarray:
    """Короткий LMS после выравнивания. Не полный IBFD 90 дБ."""
    n = int(len(rx))
    t = min(int(taps), n // 4)
    if n < t * 4:
        return rx
    r = np.asarray(ref, dtype=np.complex128)
    if len(r) < n:
        r = np.tile(r, int(math.ceil(n / len(r))))[:n]
    else:
        r = r[:n]
    x = np.asarray(rx, dtype=np.complex128)
    w = np.zeros(t, dtype=np.complex128)
    e = np.empty(n, dtype=np.complex128)
    e[:t] = x[:t]
    for i in range(t, n):
        u = r[i - t : i][::-1]
        y = np.vdot(w, u)
        err = x[i] - y
        e[i] = err
        w += mu * err * u
    return e.astype(np.complex64)


def cancel_own(rx: np.ndarray, ref: np.ndarray) -> tuple[np.ndarray, bool]:
    if detect_clip(rx):
        return rx, True
    e, aligned = align_scale_cancel(rx, ref)
    if len(e) >= 256:
        e = lms_polish(e, aligned)
    return e, False


def leftover_ratio(before: np.ndarray, after: np.ndarray) -> float:
    b = float(np.mean(np.abs(before) ** 2)) + 1e-20
    a = float(np.mean(np.abs(after) ** 2))
    return max(0.0, min(1.0, a / b))


def crop_iq(x: np.ndarray, fs: float, center_mhz: float, lo_mhz: float, bw_mhz: float, n: int = ATTACK_LOOK_N) -> np.ndarray:
    """Вырезать полосу вокруг частоты: сдвиг на DC + низкочастотный отбор."""
    if len(x) == 0 or fs <= 0:
        return np.zeros(0, dtype=np.complex64)
    want = min(int(n), int(len(x)))
    block = np.asarray(x[-want:], dtype=np.complex64)
    df = (center_mhz - lo_mhz) * 1e6
    t = np.arange(want, dtype=np.float64) / fs
    shifted = block * np.exp(-1j * 2.0 * np.pi * df * t)
    bw = max(float(bw_mhz) * 1e6, fs / float(want))
    cutoff = min(0.45, (bw / 2.0) / fs)
    freq = np.fft.fftfreq(want, d=1.0 / fs)
    X = np.fft.fft(shifted)
    X[np.abs(freq) > cutoff * fs] = 0
    return np.fft.ifft(X).astype(np.complex64)


def analyze_iq(
    x: np.ndarray,
    fs: float,
    dbm: np.ndarray | None = None,
) -> dict[str, Any]:
    """Разбор одного выреза. Все поля живые, не заглушки."""
    clip = detect_clip(x)
    fam = point_fam(x, fs) if len(x) >= 64 else {"alphaHz": 0.0, "coh": 0.0}
    cum = cumulants(x)
    if dbm is not None and dbm.size >= 8:
        flat = spectral_flatness(dbm)
        cep = cepstrum_peak(dbm)
        var = power_var_db(dbm)
    else:
        n = int(len(x))
        if n >= 64:
            spec = multitaper_dbm(x[-min(n, 4096) :])
            flat = spectral_flatness(spec)
            cep = cepstrum_peak(spec)
            var = power_var_db(spec)
        else:
            flat, cep, var = 0.0, 0.0, 0.0
    kind = classify_look(flat, cep, float(fam["coh"]), cum["c20"], cum["kurt"])
    return {
        "flatness": float(flat),
        "cepstrum": float(cep),
        "powerVarDb": float(var),
        "famAlphaHz": float(fam["alphaHz"]),
        "famCoh": float(fam["coh"]),
        "c20": cum["c20"],
        "c21": cum["c21"],
        "c40": cum["c40"],
        "kurt": cum["kurt"],
        "clip": bool(clip),
        **kind,
    }


def synth_look_iq(kind: str, n: int = 2048, fs: float = 2e6) -> np.ndarray:
    """Синтез для FAKE/тестов: тот же DSP, не заглушка ответа."""
    t = np.arange(n, dtype=np.float64) / fs
    rng = np.random.default_rng(7)
    if kind == "tone":
        return (0.4 * np.exp(1j * 2.0 * np.pi * (fs / 16.0) * t)).astype(np.complex64)
    if kind == "ofdm":
        x = np.zeros(n, dtype=np.complex128)
        for k in range(-16, 17):
            if k == 0:
                continue
            x += np.exp(1j * (2.0 * np.pi * k * (fs / 64.0) * t + float(rng.uniform(0, 2 * np.pi))))
        return (0.04 * x).astype(np.complex64)
    noise = (rng.normal(0, 0.2, n) + 1j * rng.normal(0, 0.2, n)).astype(np.complex64)
    return noise
