#!/usr/bin/env python3
"""
Глаза хост-Атаки на IQ. Только attack_scan / attack_think.
scan() / FPGA / ESP32 сюда не ходят.

Откуда формулы (код, не маркетинг):
  Thomson DPSS — scipy.signal.windows.dpss (Percival & Walden):
    diag = ((M-1-2t)/2)² cos(2πW), off = t(M-t)/2, старшие k векторов.
    SciPy зовёт scipy.linalg.eigh_tridiagonal; здесь итерация подпространства.
  ITU-R SM.443 §3 / SM.328: span ≈ 1.5× ожидаемой полосы вокруг пика,
    сумма линейной мощности = 100%, с краёв по β/2 = 0.5%.
  −3 дБ — rtl-sdr-analyzer / labPsd.width3dbMhz; −26 дБ — SM.443 x-dB.
  Spectral flatness — MPEG-7 / Wiener: геом. / арифм. среднее линейной PSD.
  FAM — компактный PySDR FAM уже на канале (не сетка из 16 α на 61.44):
    окна Ханна, первый FFT, сдвиг фазы, второй FFT произведения.
    α=0 выкинут. Острота = пик/медиана профиля, в когерентность 0…1.
  Вычет — корреляция на полном круге (как corr_est), масштаб,
    затем LMS GNU Radio: y = w·u, w += μ e conj(u).
    Опора — baseband TX (как Adaptive_SIC / gr-fullduplex), те же часы что RX.
  Канализатор — GNU Radio freq_xlating: сдвиг на DC, ФНЧ, децимация.
    AMC (gr-inspector, Swami/Sadler): признаки после канала, не на нулях
    61.44-МГц FFT. Wiener/MPEG-7 — по занятому каналу, не по вырезанному Nyquist.
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
ATTACK_THINK_N = 1 << 16  # хвост на разбор; кольцо 2^24 через FFT не гоняем
ATTACK_LOOK_FS = 2.0e6  # пол канала AMC, чтобы FAM и решётка не умерли
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


def multitaper_dbm(x: np.ndarray, k: int = ATTACK_TAPERS, blank_dc: bool = True) -> np.ndarray:
    """Thomson: среднее K эйгенспектров, дБм как welch_dbm (|X|²/N²).
    blank_dc — для водопада (утечка LO). Разбор выреза после xlating — False:
    тон на DC иначе стирается, и AMC врёт «шум»."""
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
    if blank_dc:
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
    """ITU-R SM.443 §3: span ≈ 1.5× ожидаемой полосы, затем β/2 = 0.5% с краёв."""
    if dbm.size < 4:
        return 0.0
    i = _peak_index(dbm, freqs, peak_mhz)
    expected = max(width_xd_b(dbm, freqs, peak_mhz, 26), width_xd_b(dbm, freqs, peak_mhz, 3))
    df = abs(float(freqs[1] - freqs[0])) if freqs.size > 1 else 0.0
    if expected < df * 2:
        expected = max(df * 4, expected)
    half = 0.75 * max(expected, df)
    lo = i
    hi = i
    while lo > 0 and float(freqs[lo - 1]) >= peak_mhz - half:
        lo -= 1
    while hi + 1 < freqs.size and float(freqs[hi + 1]) <= peak_mhz + half:
        hi += 1
    lin = lin_from_dbm(dbm)
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


def _scf_grid(x: np.ndarray, fs: float) -> dict[str, float]:
    """Короткая сетка SCF, если отсчётов мало для FAM. Те же 16 α, не карта."""
    n = int(len(x))
    if n < 64 or fs <= 0:
        return {"alphaHz": 0.0, "coh": 0.0}
    win = 0.5 - 0.5 * np.cos(2.0 * np.pi * np.arange(n) / max(n - 1, 1))
    X = np.fft.fft(x * win)
    best_a = 0.0
    best_c = 0.0
    fmax = min(fs / 4.0, 2.0e6)
    for i in range(1, ATTACK_FAM_ALPHAS + 1):
        alpha = fmax * i / ATTACK_FAM_ALPHAS
        half = int(round((alpha * 0.5) * n / fs))
        if half <= 0 or 2 * half >= n:
            continue
        up = np.roll(X, -half)
        dn = np.roll(X, half)
        den = float(np.mean(np.abs(up) * np.abs(dn))) + 1e-20
        coh = abs(complex(np.mean(up * np.conj(dn)))) / den
        if coh > best_c:
            best_c = coh
            best_a = alpha
    return {"alphaHz": float(best_a), "coh": float(best_c)}


def _fam_coh(sharp: float) -> float:
    """Острота пик/медиана → 0…1. Порог семьи 0.22 = явно выше пола шума.
    Пол ~2.4: у белого шума максимум по сотням α почти такой. Цикл уходит вверх."""
    excess = max(0.0, float(sharp) - 2.4)
    return max(0.0, min(1.0, excess / (excess + 3.0)))


def point_fam(x: np.ndarray, fs: float) -> dict[str, float]:
    """Компактный FAM (PySDR) по уже переданному буферу.

    Вызов стоит после channelize_look: fs — частота канала, не 61.44.
    Np=32/64, L=Np/4. Длина второго FFT такая, чтобы шаг α был около 2 кГц:
    на 20 МГц канала жёсткие 4096 отсчётов оставляли 2 периода и сливали
    10/16/28 кГц в один бин. α≈0 выкинут. Имя протокола не выходит.
    """
    raw = np.asarray(x, dtype=np.complex128).ravel()
    if int(raw.size) < 64 or fs <= 0:
        return {"alphaHz": 0.0, "coh": 0.0}
    # Около 2 мс канала, потолок 16384: на 2 МГц это прежние 4096,
    # на 20 МГц хватает окон, чтобы 10 кГц не сел в соседний бин 20 кГц.
    n = min(int(raw.size), max(4096, min(16384, int(fs * 0.002))))
    block_in = raw[-n:]
    if n < 512:
        return _scf_grid(block_in, fs)
    Np = 64 if n >= 1536 else 32
    L = max(1, Np // 4)
    max_w = (n - Np) // L + 1
    if max_w < 8:
        return _scf_grid(block_in, fs)
    avail = 1 << int(math.floor(math.log2(max_w)))
    want = max(8.0, float(fs) / (float(L) * 2_000.0))
    want_p = 1 << int(math.ceil(math.log2(want)))
    P = max(8, min(avail, want_p))
    need = (P - 1) * L + Np
    while need > n and P >= 16:
        P //= 2
        need = (P - 1) * L + Np
    if need > n or P < 8:
        return _scf_grid(block_in, fs)
    block = block_in[-need:]
    idx = (np.arange(P) * L)[:, None] + np.arange(Np)[None, :]
    hann = 0.5 - 0.5 * np.cos(2.0 * np.pi * np.arange(Np) / max(Np - 1, 1))
    XF1 = np.fft.fftshift(np.fft.fft(block[idx] * hann, axis=1), axes=1)
    f_cyc = (np.arange(Np) - (Np / 2.0)) / float(Np)
    t_samp = (np.arange(P) * float(L))
    XD = XF1 * np.exp(-2j * np.pi * t_samp[:, None] * f_cyc[None, :])
    fine = (np.arange(P) - (P / 2.0)) * (fs / (float(P) * float(L)))
    mags: list[np.ndarray] = []
    alphas: list[np.ndarray] = []
    for d in range(1, Np // 2 + 1):
        left = XD[:, d:]
        right = XD[:, : Np - d]
        prod = left * np.conj(right)
        spec = np.abs(np.fft.fftshift(np.fft.fft(prod, axis=0), axes=0))
        prof = np.mean(spec, axis=1)
        pk = float(np.mean(np.abs(left) ** 2))
        pl = float(np.mean(np.abs(right) ** 2))
        den = math.sqrt(max(pk, 0.0) * max(pl, 0.0)) * float(P) + 1e-20
        coarse = (d / float(Np)) * fs
        mags.append(prof / den)
        alphas.append(coarse + fine)
    mag = np.concatenate(mags)
    alpha = np.concatenate(alphas)
    # α≈0 — обычный спектр, не цикл. Режем только низ, около 2 кГц.
    # Не долю шага fs/Np: этот шаг 30–60 кГц и выкидывал 10–22 кГц,
    # как раз те циклы, которые после канализатора должна видеть FAM.
    ok = (np.abs(alpha) >= 2_000.0) & (np.abs(alpha) <= fs * 0.45)
    mag = mag[ok]
    alpha = alpha[ok]
    if mag.size < 8 or not np.any(np.isfinite(mag)):
        return {"alphaHz": 0.0, "coh": 0.0}
    med = float(np.median(mag)) + 1e-20
    i = int(np.argmax(mag))
    sharp = float(mag[i] / med)
    if not math.isfinite(sharp):
        return {"alphaHz": 0.0, "coh": 0.0}
    return {"alphaHz": float(abs(alpha[i])), "coh": float(_fam_coh(sharp))}


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
    """Семья разбора, не имя фирмы. Порядок как lookFromBins: тон → решётка → цикл → шум.
    Иначе OFDM с CP всегда падал в «цикл» (он циклостационарен — факт, не семья для оператора)."""
    if flat < 0.22 or (c20 >= 0.55 and flat < 0.35):
        kind = "tone"
        ru = "похоже на тон"
    elif cep >= 0.22 and 0.25 <= flat < 0.75:
        kind = "ofdm"
        ru = "решётка / OFDM-подобно"
    elif fam_coh >= 0.22 and flat < 0.7:
        kind = "cycle"
        ru = "есть цикл (энергия могла занизить ширину)"
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
    lag = int(np.argmax(np.abs(corr)))
    if lag > nfft // 2:
        lag -= nfft
    rs = np.roll(r, lag)
    denom = complex(np.vdot(rs, rs))
    if abs(denom) < 1e-12:
        return x, rs.astype(np.complex64)
    g = complex(np.vdot(rs, x)) / denom
    return (x - g * rs).astype(np.complex64), rs.astype(np.complex64)


def lms_polish(rx: np.ndarray, ref: np.ndarray, taps: int = ATTACK_LMS_TAPS, mu: float = 0.008) -> np.ndarray:
    """Короткий LMS после выравнивания. GNU Radio adaptive_algorithm_lms:
    y = w·u, w += μ e conj(u). Не полный IBFD 90 дБ."""
    n = int(len(rx))
    t = min(int(taps), n // 4)
    if n < t * 4:
        return rx
    r = np.asarray(ref, dtype=np.complex128)
    if len(r) < n:
        r = np.tile(r, int(math.ceil(n / max(len(r), 1))))[:n]
    else:
        r = r[:n]
    x = np.asarray(rx, dtype=np.complex128)
    w = np.zeros(t, dtype=np.complex128)
    e = np.empty(n, dtype=np.complex128)
    e[:t] = x[:t]
    for i in range(t, n):
        u = r[i - t : i][::-1]
        y = np.dot(w, u)
        err = x[i] - y
        e[i] = err
        w += mu * err * np.conj(u)
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
    """Вырезать полосу на родной fs (сдвиг + ФНЧ). Не для AMC: нули Nyquist
    роняют Wiener-плоскость. Разбор — channelize_look. Вычет — до выреза, на fs RX."""
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


def channelize_look(
    x: np.ndarray,
    fs: float,
    center_mhz: float,
    lo_mhz: float,
    bw_mhz: float,
    n: int = ATTACK_THINK_N,
    target_fs: float = ATTACK_LOOK_FS,
) -> tuple[np.ndarray, float]:
    """GNU Radio Frequency Xlating FIR: сдвиг на DC, ФНЧ, децимация.

    want_fs ≥ max(2·BW, 2 МГц), decim = floor(fs/want_fs) — не уже Найквиста канала.
    Спектр на fs_out занимает канал, не «дырявый» 61.44 МГц.
    """
    if len(x) == 0 or fs <= 0:
        return np.zeros(0, dtype=np.complex64), 0.0
    want = min(int(n), int(len(x)))
    block = np.asarray(x[-want:], dtype=np.complex64)
    df = (float(center_mhz) - float(lo_mhz)) * 1e6
    t = np.arange(want, dtype=np.float64) / fs
    shifted = block * np.exp(-1j * 2.0 * np.pi * df * t)
    bw_hz = max(float(bw_mhz) * 1e6, fs / float(max(want, 1)))
    want_fs = min(float(fs), max(2.0 * bw_hz, float(target_fs)))
    decim = max(1, int(math.floor(fs / want_fs)))
    fs_out = float(fs) / float(decim)
    cutoff = 0.45 * fs_out
    freq = np.fft.fftfreq(want, d=1.0 / fs)
    X = np.fft.fft(shifted)
    X[np.abs(freq) > cutoff] = 0
    filtered = np.fft.ifft(X)
    return np.asarray(filtered[::decim], dtype=np.complex64), fs_out


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
            spec = multitaper_dbm(x[-min(n, 4096) :], blank_dc=False)
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
