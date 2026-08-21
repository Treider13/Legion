#!/usr/bin/env python3
"""
LEGION SDR worker — один процесс на сессию радио.

Протокол: одна JSON-строка на stdin → одна JSON-строка на stdout.
Поток TX не пишет в stdout (иначе рассинхрон RPC).

API сверен с:
  https://github.com/pothosware/SoapySDR/wiki/PythonSupport
    Device.enumerate(), Device(args), setupStream CF32,
    readStream/writeStream → StreamResult.ret (сэмплы или код ошибки).
  SoapySDR/Constants.h: TIMEOUT=-1 STREAM_ERROR=-2 CORRUPTION=-3
    OVERFLOW=-4 UNDERFLOW=-7; C++ timeoutUs по умолчанию 100000.
  Deepwave «Transmitting in Python»: timeoutUs=int(1e6), тон не DC.
  MeasureDelay.py: if status.ret != len(tx_pulse): raise.
  SoapyRemote: enumerate/open с driver=remote,remote=tcp://host:55132.

Режим 1: RX FFT (energy) + TX CW на LO → RF out. ESP32 сюда не входит.
LEGION_SDR_FAKE=1 — только проверка протокола (не эфир).
"""
from __future__ import annotations

import json
import math
import os
import sys
import threading
import time
from typing import Any

FAKE = os.environ.get("LEGION_SDR_FAKE", "").strip() in ("1", "true", "yes")

# Constants.h — те же числа, если модуль Soapy не импортирован.
SOAPY_SDR_TIMEOUT = -1
SOAPY_SDR_STREAM_ERROR = -2
SOAPY_SDR_CORRUPTION = -3
SOAPY_SDR_OVERFLOW = -4
SOAPY_SDR_UNDERFLOW = -7

try:
    import SoapySDR
    from SoapySDR import SOAPY_SDR_CF32, SOAPY_SDR_RX, SOAPY_SDR_TX

    SOAPY = True
    SOAPY_SDR_TIMEOUT = int(getattr(SoapySDR, "SOAPY_SDR_TIMEOUT", SOAPY_SDR_TIMEOUT))
    SOAPY_SDR_STREAM_ERROR = int(getattr(SoapySDR, "SOAPY_SDR_STREAM_ERROR", SOAPY_SDR_STREAM_ERROR))
    SOAPY_SDR_CORRUPTION = int(getattr(SoapySDR, "SOAPY_SDR_CORRUPTION", SOAPY_SDR_CORRUPTION))
    SOAPY_SDR_OVERFLOW = int(getattr(SoapySDR, "SOAPY_SDR_OVERFLOW", SOAPY_SDR_OVERFLOW))
    SOAPY_SDR_UNDERFLOW = int(getattr(SoapySDR, "SOAPY_SDR_UNDERFLOW", SOAPY_SDR_UNDERFLOW))
except ImportError:
    SoapySDR = None  # type: ignore
    SOAPY_SDR_CF32 = SOAPY_SDR_RX = SOAPY_SDR_TX = None  # type: ignore
    SOAPY = False

try:
    import numpy as np

    NUMPY = True
except ImportError:
    np = None  # type: ignore
    NUMPY = False


def _reply(**kw: Any) -> None:
    sys.stdout.write(json.dumps(kw, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def parse_args(s: str) -> dict[str, str]:
    """Soapy Kwargs из строки. SoapyRemote: driver=remote,remote=tcp://host:55132
    (wiki SoapyRemote / 0xfeed). Не режем tcp:// по запятой — запятых в URL нет."""
    out: dict[str, str] = {}
    for part in (s or "").split(","):
        if "=" not in part:
            continue
        k, v = part.split("=", 1)
        k, v = k.strip(), v.strip()
        if k:
            out[k] = v
    return out


TX_FS = 2.0e6
TX_N = 4096  # кратно 8 → целое число периодов при bb = fs/8 (Deepwave AIR-T)
TX_FAIL_LIMIT = 8
FFT_MIN = 1024  # wiki PythonSupport: буфер 1024, не 64 бина UI


def cw_lo_hz(rf_hz: float, fs: float = TX_FS) -> float:
    """LO так, чтобы тон fs/8 попал на rf. Deepwave: lo = tone_rf - bb."""
    return rf_hz - fs / 8.0


def stream_timeout_us(n: int, fs: float) -> int:
    """Не дефолт 100000 µs. Deepwave: 1e6. Блок + запас на SoapyRemote."""
    block_s = float(n) / max(float(fs), 1.0)
    return max(1_000_000, int(4.0 * block_s * 1e6))


def stream_ret(sr: Any) -> int:
    """Wiki: sr.ret — число сэмплов или код ошибки. Старые биндинги — int."""
    if sr is None:
        return 0
    if hasattr(sr, "ret"):
        try:
            return int(sr.ret)
        except (TypeError, ValueError):
            return 0
    try:
        return int(sr)
    except (TypeError, ValueError):
        return 0


def stream_flags(sr: Any) -> int:
    if sr is None or not hasattr(sr, "flags"):
        return 0
    try:
        return int(sr.flags)
    except (TypeError, ValueError):
        return 0


def stream_kind(ret: int) -> str:
    if ret > 0:
        return "ok"
    if ret == SOAPY_SDR_TIMEOUT:
        return "timeout"
    if ret == SOAPY_SDR_OVERFLOW:
        return "overflow"
    if ret == SOAPY_SDR_UNDERFLOW:
        return "underflow"
    if ret in (SOAPY_SDR_STREAM_ERROR, SOAPY_SDR_CORRUPTION):
        return "error"
    if ret == 0:
        return "empty"
    return "error"


def make_cw(n: int = TX_N, fs: float = TX_FS, amp: float = 0.25):
    """Непрерывный синус, не DC. DC на LMS/AD9361 часто давит IQ-коррекция.
    Источник: Deepwave transmit_tone + пример SoapySDR writeStream CF32."""
    if not NUMPY:
        raise RuntimeError("numpy required")
    t = np.arange(n, dtype=np.float64) / fs
    bb = fs / 8.0
    return (amp * np.exp(1j * 2.0 * np.pi * bb * t)).astype(np.complex64)


# ============================================================================
# Синтез baseband-сигналов (вкладка ТИП СИГНАЛА). Волна строится в нулевой
# baseband-оси при TX_FS; tx_wave гетеродинирует её на +fs/8 и ставит
# LO = RF − fs/8 — ось 0 Гц оказывается ровно на запрошенной RF, а
# DC-центрованные волны (QPSK, шум) не попадают под LO-утечку/IQ-коррекцию.
# Петля TX крутит буфер по кругу: периодическим волнам частота «защёлкивается»
# на целое число периодов, модулированным RRC применяется циклически — стык
# буфера без щелчка.
# ============================================================================

WAVE_N = 65536  # буфер TX; OFDM укорачивается до 819×80 = 65520

WAVE_KINDS = (
    "sine", "tone", "square", "sawtooth", "triangle", "chirp", "awgn",
    "bpsk", "qpsk", "qam16", "fsk2", "dsss", "css", "ofdm", "am", "fm",
    # 2026: IoT / LMR / спутник / 6G / радар
    "gmsk", "gfsk", "oqpsk", "psk8", "apsk16", "pi4dqpsk", "fsk4", "mfsk8",
    "ook", "zadoffchu", "scfdma", "otfs", "afdm", "ocdm", "p4",
)


def _pfloat(pr: dict[str, Any], key: str, default: float, lo: float, hi: float) -> float:
    try:
        v = float((pr or {}).get(key, default))
    except (TypeError, ValueError):
        v = default
    return min(max(v, lo), hi)


def _amp(pr: dict[str, Any]) -> float:
    return _pfloat(pr, "amp", 0.25, 0.01, 0.9)


def _seed(pr: dict[str, Any]) -> int:
    try:
        return int((pr or {}).get("seed", 1337)) & 0x7FFFFFFF
    except (TypeError, ValueError):
        return 1337


def _snap_hz(f_hz: float, fs: float, n: int) -> float:
    """Частота с целым числом периодов в буфере — стык петли без щелчка."""
    cycles = max(1, round(f_hz * n / fs))
    return cycles * fs / n


def rrc_taps(sps: int, alpha: float, span: int = 8):
    """Root-raised-cosine — тот же excess_bw, что у GNU Radio generic_mod."""
    m = np.arange(-span * sps / 2, span * sps / 2 + 1, dtype=np.float64) / sps
    h = np.empty_like(m)
    for i, ti in enumerate(m):
        if abs(ti) < 1e-9:
            h[i] = 1.0 - alpha + 4.0 * alpha / np.pi
        elif abs(abs(ti) - 1.0 / (4.0 * alpha)) < 1e-9:
            h[i] = (alpha / np.sqrt(2.0)) * (
                (1.0 + 2.0 / np.pi) * np.sin(np.pi / (4.0 * alpha))
                + (1.0 - 2.0 / np.pi) * np.cos(np.pi / (4.0 * alpha))
            )
        else:
            h[i] = (
                np.sin(np.pi * ti * (1.0 - alpha))
                + 4.0 * alpha * ti * np.cos(np.pi * ti * (1.0 + alpha))
            ) / (np.pi * ti * (1.0 - (4.0 * alpha * ti) ** 2))
    return h / np.sqrt(np.sum(h ** 2))


def _circ_filter(h: Any, x: Any):
    """Циклическая свёртка через БПФ — хвосты RRC заворачиваются в буфер."""
    n = len(x)
    return np.fft.ifft(np.fft.fft(x) * np.fft.fft(h, n))


def _psk_symbols(nsym: int, m: int, seed: int):
    """Gray PSK со сдвигом pi/M — как pskmod(..., pi/M, 'gray') в MATLAB."""
    bps = int(np.log2(m))
    rs = np.random.RandomState(seed)
    bits = rs.randint(0, 2, nsym * bps).reshape(nsym, bps)
    val = np.zeros(nsym, dtype=int)
    for k in range(bps):
        val |= bits[:, k] << (bps - 1 - k)
    gray = val ^ (val >> 1)
    return np.exp(1j * (np.pi / m + gray * 2.0 * np.pi / m))


def _qam16_symbols(nsym: int, seed: int):
    """16-QAM, Gray PAM-4 на I и Q, нормировка 1/sqrt(10)."""
    rs = np.random.RandomState(seed)
    bits = rs.randint(0, 2, nsym * 4).reshape(nsym, 4)

    def pam4(b0: Any, b1: Any) -> Any:
        g = b0 * 2 + (b0 ^ b1)  # 00→-3, 01→-1, 11→+1, 10→+3
        return (2 * g - 3) / np.sqrt(10.0)

    return pam4(bits[:, 0], bits[:, 1]) + 1j * pam4(bits[:, 2], bits[:, 3])


def _mod_wave(symbols: Any, sps: int, alpha: float, amp: float, n: int, diff: bool):
    """Символы → (дифф. кодирование) → апсэмплинг → циклический RRC → пик=amp."""
    if diff:
        symbols = np.cumprod(symbols)
    up = np.zeros(len(symbols) * sps, dtype=complex)
    up[::sps] = symbols
    y = _circ_filter(rrc_taps(sps, alpha), up)
    peak = float(np.max(np.abs(y))) or 1.0
    return (amp * y / peak).astype(np.complex64)


def _mseq31():
    """m-последовательность, Gp=31: LFSR x^5+x^3+1 (примитивный полином)."""
    r = [0, 0, 0, 0, 1]
    out = []
    for _ in range(31):
        out.append(r[-1])
        fb = r[4] ^ r[2]
        r = [fb] + r[:-1]
    return np.array(out, dtype=np.float64) * 2.0 - 1.0


def _gauss_kernel(sps: int, bt: float, span: int = 3):
    """Гауссов частотный импульс (GFSK/GMSK): σ = sqrt(ln2)/(2π·BT) символа."""
    t = np.arange(-span * sps / 2, span * sps / 2 + 1, dtype=np.float64) / sps
    sigma = np.sqrt(np.log(2.0)) / (2.0 * np.pi * bt)
    g = np.exp(-(t ** 2) / (2.0 * sigma ** 2))
    return g / np.sum(g)


def _gfsk_wave(n: int, pr: dict[str, Any], amp: float, bt: float):
    """CPFSK с гауссовым импульсом, h=0.5: GMSK (BT=0.3) / GFSK (BT=0.5)."""
    sps = 8
    rs = np.random.RandomState(_seed(pr))
    sym = rs.randint(0, 2, n // sps + 2) * 2 - 1
    up = np.zeros(len(sym) * sps)
    up[::sps] = sym
    f = np.convolve(up, _gauss_kernel(sps, bt), mode="same")
    phase = np.cumsum(2.0 * np.pi * 0.5 * f / sps)  # h=0.5 → ±π/2 за символ
    return (amp * np.exp(1j * phase[:n])).astype(np.complex64)


def _oqpsk_wave(n: int, pr: dict[str, Any], amp: float):
    """OQPSK с полусинус-импульсом (802.15.4-like): Q отстаёт на полсимвола."""
    sps = 8
    rs = np.random.RandomState(_seed(pr))
    nsym = n // sps + 2
    i_sym = rs.randint(0, 2, nsym) * 2 - 1
    q_sym = rs.randint(0, 2, nsym) * 2 - 1
    hs = np.sin(np.pi * np.arange(sps, dtype=np.float64) / sps)
    i_up = np.zeros(nsym * sps)
    i_up[::sps] = i_sym
    q_up = np.zeros(nsym * sps)
    q_up[::sps] = q_sym
    fi = np.convolve(i_up, hs)[: nsym * sps]
    fq = np.convolve(q_up, hs)[: nsym * sps]
    half = sps // 2
    y = (fi[half:] + 1j * fq[:-half])[:n]
    peak = float(np.max(np.abs(y))) or 1.0
    return (amp * y / peak).astype(np.complex64)


def _apsk16_symbols(nsym: int, seed: int):
    """16-APSK (DVB-S2): кольца 4+12, γ = r2/r1 = 2.73, средняя мощность = 1."""
    rs = np.random.RandomState(seed)
    ring = rs.randint(0, 16, nsym)
    r2 = 2.73
    out = np.empty(nsym, dtype=complex)
    inner = ring < 4
    out[inner] = np.exp(1j * (np.pi / 4 + ring[inner] * np.pi / 2))
    k = ring[~inner] - 4
    out[~inner] = r2 * np.exp(1j * (np.pi / 12 + k * np.pi / 6))
    return out / np.sqrt((4.0 + 12.0 * r2 ** 2) / 16.0)


def _pi4dqpsk_wave(n: int, pr: dict[str, Any], amp: float):
    """π/4-DQPSK (TETRA/DMR): приращения фазы ±π/4, ±3π/4, RRC."""
    sps = int(_pfloat(pr, "sps", 4, 2, 16))
    alpha = _pfloat(pr, "alpha", 0.035, 0.03, 0.5)
    rs = np.random.RandomState(_seed(pr))
    dibits = rs.randint(0, 4, n // sps)
    step = np.array([np.pi / 4, 3 * np.pi / 4, -np.pi / 4, -3 * np.pi / 4])[dibits]
    sym = np.exp(1j * np.cumsum(step))
    return _mod_wave(sym, sps, alpha, amp, n, diff=False)


def _fsk4_wave(fs: float, n: int, pr: dict[str, Any], amp: float):
    """4-FSK / C4FM (APCO-25, DMR): дибиты → 4 уровня, гауссово сглаживание."""
    sps = 8
    dev = _pfloat(pr, "devKhz", 125.0, 5.0, fs / 8e3) * 1e3
    rs = np.random.RandomState(_seed(pr))
    sym = (rs.randint(0, 4, n // sps + 2) * 2 - 3) / 3.0  # ±1/3, ±1
    up = np.zeros(len(sym) * sps)
    up[::sps] = sym
    f = np.convolve(up, _gauss_kernel(sps, 0.5), mode="same")
    phase = np.cumsum(2.0 * np.pi * dev * f / sps)
    return (amp * np.exp(1j * phase[:n])).astype(np.complex64)


def _mfsk8_wave(n: int, pr: dict[str, Any], amp: float):
    """8-FSK с гауссовыми переходами (FT8-like): 8 тонов с шагом toneKhz."""
    sps = 32
    df = _pfloat(pr, "toneKhz", 31.25, 1.0, 200.0) * 1e3
    rs = np.random.RandomState(_seed(pr))
    sym = rs.randint(0, 8, n // sps + 2) - 3.5
    up = np.zeros(len(sym) * sps)
    up[::sps] = sym
    f = np.convolve(up, _gauss_kernel(sps, 0.5, span=2), mode="same")
    phase = np.cumsum(2.0 * np.pi * df * f / sps)
    return (amp * np.exp(1j * phase[:n])).astype(np.complex64)


def _zadoffchu_wave(n: int, pr: dict[str, Any], amp: float):
    """Zadoff-Chu (LTE/5G PRACH): exp(−jπ·u·k(k+1)/N), N=631 простое."""
    nzc = 631
    u = int(_pfloat(pr, "u", 25, 1, nzc - 1))
    k = np.arange(nzc, dtype=np.float64)
    zc = np.exp(-1j * np.pi * u * k * (k + 1.0) / nzc)
    y = np.tile(zc, n // nzc + 1)[:n]
    return (amp * y).astype(np.complex64)


def _scfdma_wave(n: int, pr: dict[str, Any], amp: float):
    """SC-FDMA (LTE uplink): QPSK → DFT(64) → поднесущие → IDFT(256) → CP."""
    m, nfft, cp = 64, 256, 16
    rs = np.random.RandomState(_seed(pr))
    frames = []
    for _ in range(n // (nfft + cp)):
        bits = rs.randint(0, 4, m)
        qpsk = np.exp(1j * (np.pi / 4 + bits * np.pi / 2))
        spec = np.zeros(nfft, dtype=complex)
        spec[:m] = np.fft.fft(qpsk)
        td = np.fft.ifft(spec) * np.sqrt(nfft)
        frames.append(np.concatenate([td[-cp:], td]))
    y = np.concatenate(frames) if frames else np.zeros(n, dtype=complex)
    peak = float(np.max(np.abs(y))) or 1.0
    return (amp * y / peak).astype(np.complex64)


def _otfs_wave(n: int, pr: dict[str, Any], amp: float):
    """OTFS (6G): QPSK на delay-Doppler сетке 64×16; rect-пульс → IDZT —
    IFFT по допплеру в каждой строке задержки (как в zak-otfs-rt)."""
    m, ndop = 64, 16
    rs = np.random.RandomState(_seed(pr))
    frames = []
    for _ in range(n // (m * ndop)):
        bits = rs.randint(0, 4, (m, ndop))
        x_dd = np.exp(1j * (np.pi / 4 + bits * np.pi / 2))
        frames.append((np.fft.ifft(x_dd, axis=1) * np.sqrt(ndop)).reshape(-1))
    y = np.concatenate(frames) if frames else np.zeros(n, dtype=complex)
    peak = float(np.max(np.abs(y))) or 1.0
    return (amp * y / peak).astype(np.complex64)


def _afdm_wave(n: int, pr: dict[str, Any], amp: float):
    """AFDM (6G, chirp-домен): x = s·C, C[k,m] = exp(j2π(c1k² + c2m² + km/N))."""
    nsub = 256
    c1 = 1.0 / (2.0 * nsub)
    c2 = 1.0 / (2.0 * nsub)
    k = np.arange(nsub, dtype=np.float64)
    m = np.arange(nsub, dtype=np.float64)
    cm = np.exp(
        1j * 2.0 * np.pi
        * (c1 * np.outer(k * k, np.ones(nsub)) + c2 * np.outer(np.ones(nsub), m * m) + np.outer(k, m) / nsub)
    )
    rs = np.random.RandomState(_seed(pr))
    frames = []
    for _ in range(n // nsub):
        bits = rs.randint(0, 4, nsub)
        s = np.exp(1j * (np.pi / 4 + bits * np.pi / 2))
        frames.append(s @ cm / np.sqrt(nsub))
    y = np.concatenate(frames) if frames else np.zeros(n, dtype=complex)
    peak = float(np.max(np.abs(y))) or 1.0
    return (amp * y / peak).astype(np.complex64)


def _ocdm_wave(n: int, pr: dict[str, Any], amp: float):
    """OCDM (6G): OFDM с преобразованием Френеля — ортогональные чирп-несущие."""
    nsub = 64
    k = np.arange(nsub, dtype=np.float64)
    d = np.subtract.outer(k, k)
    fres = np.exp(-1j * np.pi * d * d / nsub) / np.sqrt(nsub)
    rs = np.random.RandomState(_seed(pr))
    frames = []
    for _ in range(n // nsub):
        bits = rs.randint(0, 4, nsub)
        s = np.exp(1j * (np.pi / 4 + bits * np.pi / 2))
        frames.append(fres.conj().T @ s)
    y = np.concatenate(frames) if frames else np.zeros(n, dtype=complex)
    peak = float(np.max(np.abs(y))) or 1.0
    return (amp * y / peak).astype(np.complex64)


def _p4_wave(n: int, pr: dict[str, Any], amp: float):
    """P4 полифазный код (импульсное сжатие, радар): L=64 чипа, 4 сэмпла/чип."""
    length, spc = 64, 4
    k = np.arange(1, length + 1, dtype=np.float64)
    ph = np.pi * (k - 1.0) ** 2 / length - np.pi * (k - 1.0)
    code = np.exp(1j * ph)
    y = np.tile(np.repeat(code, spc), n // (length * spc) + 1)[:n]
    return (amp * y).astype(np.complex64)


def make_waveform(kind: str, fs: float = TX_FS, n: int = WAVE_N, pr: dict[str, Any] | None = None):
    """Один буфер baseband-сигнала. Ось 0 Гц = центр запрошенной RF."""
    if not NUMPY:
        raise RuntimeError("numpy required")
    if kind not in WAVE_KINDS:
        raise ValueError(f"unknown waveform {kind}")
    pr = pr or {}
    amp = _amp(pr)
    t = np.arange(n, dtype=np.float64) / fs

    if kind == "sine":
        # Аналитический сигнал: одна линия на fj·fs (fj=0 → ровно на RF).
        fj = _pfloat(pr, "fj", 0.0, -0.45, 0.45)
        fj = round(fj * n) / n
        return (amp * np.exp(1j * 2.0 * np.pi * fj * np.arange(n))).astype(np.complex64)

    if kind == "tone":
        # Узкополосный тон со смещением Fj и случайной фазой (модель tone_jammer).
        fj = _pfloat(pr, "fj", 0.1, -0.45, 0.45)
        fj = round(fj * n) / n
        theta = float(np.random.uniform(0.0, 2.0 * np.pi))
        return (amp * np.exp(1j * (2.0 * np.pi * fj * np.arange(n) + theta))).astype(np.complex64)

    if kind == "square":
        fb = _snap_hz(_pfloat(pr, "fbKhz", 125.0, 1.0, fs / 2e3) * 1e3, fs, n)
        return (amp * np.sign(np.sin(2.0 * np.pi * fb * t))).astype(np.complex64)

    if kind == "sawtooth":
        fb = _snap_hz(_pfloat(pr, "fbKhz", 125.0, 1.0, fs / 2e3) * 1e3, fs, n)
        return (amp * (2.0 * ((fb * t) % 1.0) - 1.0)).astype(np.complex64)

    if kind == "triangle":
        fb = _snap_hz(_pfloat(pr, "fbKhz", 125.0, 1.0, fs / 2e3) * 1e3, fs, n)
        return (amp * (2.0 / np.pi) * np.arcsin(np.sin(2.0 * np.pi * fb * t))).astype(np.complex64)

    if kind == "chirp":
        # Линейный чирп −span/2 → +span/2 за буфер; ∫f dt = 0 → фаза стыкуется.
        span = _pfloat(pr, "spanKhz", 1000.0, 10.0, fs / 2e3) * 1e3
        f0 = -span / 2.0
        k = span / (n / fs)
        return (amp * np.exp(1j * 2.0 * np.pi * (f0 * t + 0.5 * k * t * t))).astype(np.complex64)

    if kind == "awgn":
        # Комплексный AWGN: RMS = amp/2, жёсткий клип на amp (защита ЦАП).
        rs = np.random.RandomState(_seed(pr))
        x = (rs.randn(n) + 1j * rs.randn(n)) / np.sqrt(2.0) * (amp / 2.0)
        mag = np.abs(x)
        over = mag > amp
        x[over] *= amp / mag[over]
        return x.astype(np.complex64)

    if kind in ("bpsk", "qpsk", "qam16"):
        sps = int(_pfloat(pr, "sps", 4, 2, 16))
        alpha = _pfloat(pr, "alpha", 0.035, 0.03, 0.5)
        nsym = n // sps
        if kind == "bpsk":
            sym = _psk_symbols(nsym, 2, _seed(pr))
        elif kind == "qpsk":
            sym = _psk_symbols(nsym, 4, _seed(pr))
        else:
            sym = _qam16_symbols(nsym, _seed(pr))
        # Дифф. кодирование — для PSK (как differential=True у generic_mod).
        return _mod_wave(sym, sps, alpha, amp, n, diff=(kind != "qam16"))

    if kind == "fsk2":
        # CPFSK: фаза непрерывна, девиация ±dev вокруг оси.
        sps = int(_pfloat(pr, "sps", 8, 2, 64))
        dev = _pfloat(pr, "devKhz", 250.0, 1.0, fs / 4e3) * 1e3
        sym = 2 * np.random.RandomState(_seed(pr)).randint(0, 2, n // sps + 1) - 1
        up = np.repeat(sym, sps)[:n]
        phase = np.cumsum(2.0 * np.pi * dev * up / fs)
        return (amp * np.exp(1j * phase)).astype(np.complex64)

    if kind == "dsss":
        # BPSK × m-последовательность Gp=31, 2 сэмпла/чип (модель 802.11b).
        spc = 2
        chips = _mseq31()
        nbits = n // (31 * spc)
        data = np.random.RandomState(_seed(pr)).randint(0, 2, nbits) * 2 - 1
        spread = np.repeat(data, 31) * np.tile(chips, nbits)
        return (amp * np.repeat(spread, spc)[:n]).astype(np.complex64)

    if kind == "css":
        # Chirp spread spectrum (LoRa-подобный): символ = циклический сдвиг чирпа.
        sf = int(_pfloat(pr, "sf", 6, 5, 10))
        m = 1 << sf
        rs = np.random.RandomState(_seed(pr))
        k = np.arange(m, dtype=np.float64)
        out = [
            np.exp(1j * 2.0 * np.pi * ((k * k) / (2.0 * m) + (float(s) / m) * k))
            for s in rs.randint(0, m, n // m)
        ]
        y = np.concatenate(out) if out else np.zeros(n, dtype=complex)
        return (amp * y).astype(np.complex64)

    if kind == "ofdm":
        # 802.11a-подобный: NFFT=64, CP=16, 52 поднесущие QPSK (π/4, Gray-порядок).
        nfft, cp = 64, 16
        used = list(range(-26, 0)) + list(range(1, 27))
        rs = np.random.RandomState(_seed(pr))
        nsym = n // (nfft + cp)
        frames = []
        for _ in range(nsym):
            spec = np.zeros(nfft, dtype=complex)
            ph = np.pi / 4 + rs.randint(0, 4, len(used)) * np.pi / 2
            spec[np.mod(used, nfft)] = np.exp(1j * ph)
            td = np.fft.ifft(spec) * np.sqrt(nfft)
            frames.append(np.concatenate([td[-cp:], td]))
        y = np.concatenate(frames) if frames else np.zeros(n, dtype=complex)
        peak = float(np.max(np.abs(y))) or 1.0
        return (amp * y / peak).astype(np.complex64)

    if kind == "am":
        fb = _snap_hz(_pfloat(pr, "fbKhz", 125.0, 1.0, fs / 2e3) * 1e3, fs, n)
        fm = _pfloat(pr, "fmKhz", 31.25, 0.1, 500.0) * 1e3
        m = _pfloat(pr, "m", 0.5, 0.05, 1.0)
        env = (1.0 + m * np.sin(2.0 * np.pi * fm * t)) / (1.0 + m)
        return (amp * env * np.exp(1j * 2.0 * np.pi * fb * t)).astype(np.complex64)

    # --- 2026: IoT / LMR / спутник / 6G / радар ---
    if kind == "gmsk":
        return _gfsk_wave(n, pr, amp, bt=0.3)  # GSM: BT=0.3, h=0.5

    if kind == "gfsk":
        return _gfsk_wave(n, pr, amp, bt=0.5)  # BLE-like: BT=0.5

    if kind == "oqpsk":
        return _oqpsk_wave(n, pr, amp)

    if kind == "psk8":
        sps = int(_pfloat(pr, "sps", 4, 2, 16))
        alpha = _pfloat(pr, "alpha", 0.035, 0.03, 0.5)
        return _mod_wave(_psk_symbols(n // sps, 8, _seed(pr)), sps, alpha, amp, n, diff=True)

    if kind == "apsk16":
        sps = int(_pfloat(pr, "sps", 4, 2, 16))
        alpha = _pfloat(pr, "alpha", 0.035, 0.03, 0.5)
        return _mod_wave(_apsk16_symbols(n // sps, _seed(pr)), sps, alpha, amp, n, diff=False)

    if kind == "pi4dqpsk":
        return _pi4dqpsk_wave(n, pr, amp)

    if kind == "fsk4":
        return _fsk4_wave(fs, n, pr, amp)

    if kind == "mfsk8":
        return _mfsk8_wave(n, pr, amp)

    if kind == "ook":
        fb = _snap_hz(_pfloat(pr, "fbKhz", 125.0, 1.0, fs / 2e3) * 1e3, fs, n)
        sps = 16
        rs = np.random.RandomState(_seed(pr))
        env = np.repeat(rs.randint(0, 2, n // sps + 1), sps)[:n].astype(np.float64)
        return (amp * env * np.exp(1j * 2.0 * np.pi * fb * t)).astype(np.complex64)

    if kind == "zadoffchu":
        return _zadoffchu_wave(n, pr, amp)

    if kind == "scfdma":
        return _scfdma_wave(n, pr, amp)

    if kind == "otfs":
        return _otfs_wave(n, pr, amp)

    if kind == "afdm":
        return _afdm_wave(n, pr, amp)

    if kind == "ocdm":
        return _ocdm_wave(n, pr, amp)

    if kind == "p4":
        return _p4_wave(n, pr, amp)

    # fm: несущая fb, тон fm, индекс beta — линии Бесселя fb ± k·fm.
    fb = _snap_hz(_pfloat(pr, "fbKhz", 125.0, 1.0, fs / 2e3) * 1e3, fs, n)
    fm = _pfloat(pr, "fmKhz", 31.25, 0.1, 500.0) * 1e3
    beta = _pfloat(pr, "beta", 5.0, 0.1, 50.0)
    return (amp * np.exp(1j * (2.0 * np.pi * fb * t + beta * np.sin(2.0 * np.pi * fm * t)))).astype(np.complex64)


class Radio:
    def __init__(self) -> None:
        self.dev = None
        self.rx = None
        self.tx = None
        self.args = ""
        self.fake = FAKE
        self.tx_mhz: float | None = None
        self._stop = threading.Event()
        self._thr: threading.Thread | None = None
        self._lock = threading.Lock()
        self.can_tx = True
        self.full_duplex = True
        self.analog_bw = 20.0
        self._rx_on = False
        self._tone = None
        self.tx_error: str | None = None
        self.tx_fail = 0

    def tx_live(self) -> bool:
        if self.tx_mhz is None or self.tx_error:
            return False
        if self.fake:
            return True
        return self._thr is not None and self._thr.is_alive()

    def close(self) -> None:
        self.tx_off()
        with self._lock:
            if self.dev is not None and SOAPY:
                try:
                    if self.rx is not None:
                        self.dev.deactivateStream(self.rx)
                        self.dev.closeStream(self.rx)
                except Exception:
                    pass
                try:
                    if self.tx is not None:
                        self.dev.deactivateStream(self.tx)
                        self.dev.closeStream(self.tx)
                except Exception:
                    pass
            self.dev = None
            self.rx = None
            self.tx = None
            self._rx_on = False
            self.args = ""
            self.tx_error = None

    def open(self, args: str, analog_bw: float, can_tx: bool, full_duplex: bool) -> dict[str, Any]:
        self.close()
        self.analog_bw = analog_bw if analog_bw > 0 else 20.0
        self.can_tx = can_tx
        self.full_duplex = full_duplex
        self.args = args
        if self.fake or args.startswith("driver=fake"):
            self.fake = True
            return {"ok": True, "reason": "FAKE worker — не эфир", "fake": True}
        if not SOAPY:
            return {"ok": False, "reason": "SoapySDR Python не установлен (пакет python3-soapysdr / pip SoapySDR)"}
        if not NUMPY:
            return {
                "ok": False,
                "reason": "numpy не установлен — wiki PythonSupport: буферы CF32 это numpy.complex64",
            }
        kw = parse_args(args)
        if not kw:
            # Пустой host в UI = локальный USB. Wiki: Device(результат enumerate).
            try:
                found = list(SoapySDR.Device.enumerate())
            except Exception as e:
                return {"ok": False, "reason": f"enumerate: {e}"}
            if not found:
                return {"ok": False, "reason": "Soapy не видит устройств — укажите IP шлюза/платы"}
            kw = {str(k): str(v) for k, v in dict(found[0]).items()}
        try:
            self.dev = SoapySDR.Device(kw)
            _setup_front_end(self.dev, self.can_tx)
        except Exception as e:
            return {"ok": False, "reason": f"Soapy Device(): {e}"}
        return {"ok": True, "reason": f"открыт Soapy {kw}", "fake": False}

    def _ensure_rx(self, fs: float, center_hz: float) -> None:
        assert self.dev is not None
        self.dev.setSampleRate(SOAPY_SDR_RX, 0, fs)
        try:
            self.dev.setBandwidth(SOAPY_SDR_RX, 0, min(fs, self.analog_bw * 1e6))
        except Exception:
            pass
        self.dev.setFrequency(SOAPY_SDR_RX, 0, center_hz)
        if self.rx is None:
            self.rx = self.dev.setupStream(SOAPY_SDR_RX, SOAPY_SDR_CF32)
            self.dev.activateStream(self.rx)
            self._rx_on = True
        elif not self._rx_on:
            # half-duplex: после TX поток есть, но deactivate — wiki: activate снова
            self.dev.activateStream(self.rx)
            self._rx_on = True

    def scan(self, center_mhz: float, bw_mhz: float, bins: int) -> dict[str, Any]:
        n = max(8, min(int(bins), 4096))
        bw = max(0.2, float(bw_mhz))
        extra = self._scan_extra()
        if not self.full_duplex and self.tx_mhz is not None:
            # GSG HackRF — half-duplex. RX+TX сразу ломает тракт (каталог fullDuplex: false).
            return {
                "ok": True,
                "bins": [],
                "centerMhz": center_mhz,
                "reason": "half-duplex: RX пауза, пока TX на RF out",
                **extra,
            }
        if self.fake:
            return {"ok": True, "bins": _fake_bins(center_mhz, bw, n), "centerMhz": center_mhz, **extra}
        if self.dev is None:
            return {"ok": False, "reason": "SDR не открыт", "bins": [], **extra}
        if not NUMPY:
            return {"ok": False, "reason": "нужен numpy для FFT эфира", "bins": [], **extra}
        # Кепка только по аналоговой BW устройства. Был ещё потолок 40 МГц:
        # при окне 56 МГц (bladeRF) walker шагал на 56, а скан покрывал ±20 —
        # 16 МГц между окнами не сканировались никогда (аудит N1).
        fs = min(max(bw * 1e6, 1e6), self.analog_bw * 1e6)
        with self._lock:
            try:
                self._ensure_rx(fs, center_mhz * 1e6)
                spec = _read_fft(self.dev, self.rx, n, fs, center_mhz)
            except Exception as e:
                return {"ok": False, "reason": f"RX: {e}", "bins": [], **extra}
        return {"ok": True, "bins": spec, "centerMhz": center_mhz, **extra}

    def _scan_extra(self) -> dict[str, Any]:
        out: dict[str, Any] = {"txLive": self.tx_live()}
        if self.tx_error:
            out["txError"] = self.tx_error
        return out

    def _tx_prime(self, buf: Any, lo_hz: float, prev_mhz: float | None) -> dict[str, Any] | None:
        """RX-пауза (half-duplex) + tune LO + первый writeStream. None = успех,
        иначе dict с ошибкой. Откат: LO на прежнюю частоту или закрытие стрима.
        Буфер подменяется под локом сразу после первой записи — TX-петля не
        успевает выпустить старую волну на новой частоте."""
        timeout = stream_timeout_us(len(buf), TX_FS)
        created = False
        with self._lock:
            try:
                if not self.full_duplex and self.rx is not None and self._rx_on:
                    self.dev.deactivateStream(self.rx)
                    self._rx_on = False
                self.dev.setSampleRate(SOAPY_SDR_TX, 0, TX_FS)
                try:
                    # Широким волнам (шум, OFDM — до fs) нужен весь фильтр TX,
                    # иначе дефолтный (~1.5 МГц у LMS6002D) режет края спектра.
                    self.dev.setBandwidth(SOAPY_SDR_TX, 0, min(TX_FS, self.analog_bw * 1e6))
                except Exception:
                    pass
                self.dev.setFrequency(SOAPY_SDR_TX, 0, lo_hz)
                if self.tx is None:
                    self.tx = self.dev.setupStream(SOAPY_SDR_TX, SOAPY_SDR_CF32)
                    self.dev.activateStream(self.tx)
                    created = True
                # MeasureDelay: if status.ret != len(tx_pulse): raise
                sr = self.dev.writeStream(self.tx, [buf], len(buf), timeoutUs=timeout)
                ret = stream_ret(sr)
                kind = stream_kind(ret)
                if ret != len(buf):
                    if prev_mhz is not None:
                        self.dev.setFrequency(SOAPY_SDR_TX, 0, cw_lo_hz(prev_mhz * 1e6, TX_FS))
                    elif created and self.tx is not None:
                        try:
                            self.dev.deactivateStream(self.tx)
                            self.dev.closeStream(self.tx)
                        except Exception:
                            pass
                        self.tx = None
                    return {
                        "ok": False,
                        "reason": f"writeStream {kind} ret={ret} (ждали {len(buf)}) — сигнала на RF out нет",
                        "latencyUs": 0,
                    }
                self._tone = buf
            except Exception as e:
                return {"ok": False, "reason": f"TX tune: {e}", "latencyUs": 0}
        return None

    def _tx_commit(self, buf: Any, freq_mhz: float, t0: float, label: str) -> dict[str, Any]:
        self._tone = buf
        self.tx_mhz = freq_mhz
        self.tx_error = None
        self.tx_fail = 0
        self._start_tx_loop()
        us = int((time.perf_counter() - t0) * 1e6)
        return {
            "ok": True,
            "reason": f"{label} · {us} µs host",
            "latencyUs": us,
            "freqMhz": freq_mhz,
        }

    def tx_cue(self, freq_mhz: float) -> dict[str, Any]:
        if not self.can_tx:
            return {"ok": False, "reason": "нет TX — усилитель подключать некуда", "latencyUs": 0}
        t0 = time.perf_counter()
        if self.fake:
            self.tx_mhz = freq_mhz
            self.tx_error = None
            us = int((time.perf_counter() - t0) * 1e6)
            return {"ok": True, "reason": f"FAKE TX {freq_mhz:.6f} МГц", "latencyUs": us, "freqMhz": freq_mhz}
        if self.dev is None:
            return {"ok": False, "reason": "SDR не открыт", "latencyUs": 0}
        if not SOAPY:
            return {"ok": False, "reason": "нет Soapy", "latencyUs": 0}
        if not NUMPY:
            return {"ok": False, "reason": "нет numpy — TX stream нечем кормить", "latencyUs": 0}
        rf_hz = freq_mhz * 1e6
        lo_hz = cw_lo_hz(rf_hz, TX_FS)
        tone = make_cw()
        err = self._tx_prime(tone, lo_hz, self.tx_mhz)
        if err is not None:
            return err
        return self._tx_commit(
            tone, freq_mhz, t0,
            f"SDR TX {freq_mhz:.6f} МГц (тон fs/8, LO {(lo_hz/1e6):.6f})",
        )

    def tx_wave(self, freq_mhz: float, wave: str, params: dict[str, Any]) -> dict[str, Any]:
        """TX произвольной baseband-волны из WAVE_KINDS (вкладка ТИП СИГНАЛА).
        Буфер гетеродинируется на +fs/8, LO = RF − fs/8: ось 0 Гц волны
        оказывается на запрошенной RF, DC-волны не давятся IQ-коррекцией."""
        if wave not in WAVE_KINDS:
            return {"ok": False, "reason": f"неизвестный тип сигнала: {wave}", "latencyUs": 0}
        if not self.can_tx:
            return {"ok": False, "reason": "нет TX — усилитель подключать некуда", "latencyUs": 0}
        t0 = time.perf_counter()
        if self.fake:
            if NUMPY:
                try:
                    make_waveform(wave, TX_FS, WAVE_N, params)
                except Exception as e:
                    return {"ok": False, "reason": f"синтез {wave}: {e}", "latencyUs": 0}
            self.tx_mhz = freq_mhz
            self.tx_error = None
            us = int((time.perf_counter() - t0) * 1e6)
            return {
                "ok": True,
                "reason": f"FAKE TX {wave} {freq_mhz:.6f} МГц",
                "latencyUs": us,
                "freqMhz": freq_mhz,
            }
        if self.dev is None:
            return {"ok": False, "reason": "SDR не открыт", "latencyUs": 0}
        if not SOAPY:
            return {"ok": False, "reason": "нет Soapy", "latencyUs": 0}
        if not NUMPY:
            return {"ok": False, "reason": "нет numpy — сигнал не синтезировать", "latencyUs": 0}
        try:
            buf = make_waveform(wave, TX_FS, WAVE_N, params)
        except Exception as e:
            return {"ok": False, "reason": f"синтез {wave}: {e}", "latencyUs": 0}
        n = len(buf)
        t = np.arange(n, dtype=np.float64) / TX_FS
        buf = (buf * np.exp(1j * 2.0 * np.pi * (TX_FS / 8.0) * t)).astype(np.complex64)
        rf_hz = freq_mhz * 1e6
        lo_hz = cw_lo_hz(rf_hz, TX_FS)
        err = self._tx_prime(buf, lo_hz, self.tx_mhz)
        if err is not None:
            return err
        return self._tx_commit(
            buf, freq_mhz, t0,
            f"SDR TX {wave} {freq_mhz:.6f} МГц (baseband +fs/8, LO {(lo_hz/1e6):.6f})",
        )

    def _start_tx_loop(self) -> None:
        if self._thr and self._thr.is_alive():
            return
        self._stop.clear()
        if self._tone is None:
            self._tone = make_cw()

        def loop() -> None:
            while not self._stop.is_set() and self.dev is not None and self.tx is not None:
                with self._lock:
                    # Буфер читаем каждый блок: tx_wave на живом TX подменяет
                    # волну без пересоздания стрима (замыкание бы её не увидело).
                    buf = self._tone
                    if buf is None:
                        break
                    timeout = stream_timeout_us(len(buf), TX_FS)
                    try:
                        sr = self.dev.writeStream(self.tx, [buf], len(buf), timeoutUs=timeout)
                    except Exception as e:
                        self.tx_error = f"writeStream exception: {e}"
                        break
                    ret = stream_ret(sr)
                    kind = stream_kind(ret)
                    if kind == "ok":
                        self.tx_fail = 0
                        continue
                    if kind == "underflow":
                        # не хватило сэмплов вовремя — пишем снова, это не «нет RF»
                        continue
                    if kind == "error":
                        self.tx_error = f"writeStream {kind} ret={ret}"
                        break
                    self.tx_fail += 1
                    if self.tx_fail >= TX_FAIL_LIMIT:
                        self.tx_error = f"writeStream {kind} ×{self.tx_fail} — TX оборван"
                        break

        self._thr = threading.Thread(target=loop, name="legion-sdr-tx", daemon=True)
        self._thr.start()

    def tx_off(self) -> None:
        self._stop.set()
        if self._thr:
            # writeStream timeoutUs ≥ 1s — join должен переживать один блокирующий write
            self._thr.join(timeout=3.0)
            self._thr = None
        self.tx_mhz = None
        self.tx_error = None
        self.tx_fail = 0
        if self.dev is not None and self.tx is not None and SOAPY:
            with self._lock:
                try:
                    self.dev.deactivateStream(self.tx)
                    self.dev.closeStream(self.tx)
                except Exception:
                    pass
                self.tx = None


def _fake_bins(center: float, bw: float, n: int) -> list[dict[str, float]]:
    half = bw / 2
    out = []
    for i in range(n):
        f = center - half + (bw * i) / max(n - 1, 1)
        p = -92 + 1.5 * math.sin(f * 0.017)
        out.append({"freqMhz": f, "powerDbm": p})
    return out


def _setup_front_end(dev: Any, can_tx: bool) -> None:
    """Антенна/gain — как в wiki listAntennas + Deepwave setGain. Иначе TX часто в 0."""
    try:
        rx_ants = list(dev.listAntennas(SOAPY_SDR_RX, 0) or [])
        pick = next((a for a in rx_ants if str(a).upper() in ("RX", "RX1", "RX2", "LNAL", "LNAH")), None)
        if pick or rx_ants:
            dev.setAntenna(SOAPY_SDR_RX, 0, pick or rx_ants[0])
    except Exception:
        pass
    try:
        dev.setGainMode(SOAPY_SDR_RX, 0, True)
    except Exception:
        try:
            dev.setGain(SOAPY_SDR_RX, 0, 30)
        except Exception:
            pass
    if not can_tx:
        return
    try:
        tx_ants = list(dev.listAntennas(SOAPY_SDR_TX, 0) or [])
        pick = next((a for a in tx_ants if "TX" in str(a).upper()), None)
        if pick or tx_ants:
            dev.setAntenna(SOAPY_SDR_TX, 0, pick or tx_ants[0])
    except Exception:
        pass
    try:
        rng = dev.getGainRange(SOAPY_SDR_TX, 0)
        lo, hi = float(rng.minimum()), float(rng.maximum())
        dev.setGain(SOAPY_SDR_TX, 0, lo + 0.4 * (hi - lo))
    except Exception:
        try:
            dev.setGain(SOAPY_SDR_TX, 0, 20)
        except Exception:
            pass


def _read_size(dev: Any, rx: Any, n: int) -> int:
    want = max(int(n), FFT_MIN)
    try:
        mtu = int(dev.getStreamMTU(rx))
        if mtu > 0:
            want = max(want, min(mtu, 4096))
    except Exception:
        pass
    return min(max(want, FFT_MIN), 4096)


def _pool_bins(freqs: Any, db: Any, n: int) -> list[dict[str, float]]:
    if len(db) <= n:
        return [{"freqMhz": float(f), "powerDbm": float(p)} for f, p in zip(freqs, db)]
    edges = np.linspace(0, len(db), n + 1, dtype=int)
    out = []
    for i in range(n):
        a, b = int(edges[i]), int(edges[i + 1])
        if b <= a:
            b = a + 1
        j = int(a + np.argmax(db[a:b]))
        out.append({"freqMhz": float(freqs[j]), "powerDbm": float(db[j])})
    return out


def _read_fft(dev: Any, rx: Any, n: int, fs: float, center_mhz: float) -> list[dict[str, float]]:
    """Усредняем |FFT|², не IQ (когерентная сумма фаз гасит тон).
    Wiki: readStream возвращает StreamResult; timeoutUs не дефолт 100ms."""
    if not NUMPY:
        raise RuntimeError("нужен numpy для FFT эфира (pip install numpy)")
    nread = _read_size(dev, rx, n)
    buf = np.zeros(nread, dtype=np.complex64)
    timeout = stream_timeout_us(nread, fs)
    ps = None
    got = 0
    used = nread
    fatal = None
    for _ in range(12):
        sr = dev.readStream(rx, [buf], nread, timeoutUs=timeout)
        ret = stream_ret(sr)
        kind = stream_kind(ret)
        if kind == "error":
            fatal = f"readStream {kind} ret={ret}"
            break
        if ret <= 0:
            continue
        x = buf[:ret]
        if len(x) < 8:
            continue
        # нули в хвосте размазывают спектр (sinc). Только одинаковая длина.
        if ps is not None and len(x) != used:
            continue
        used = len(x)
        win = np.hanning(len(x))
        spec = np.fft.fftshift(np.fft.fft(x * win))
        p = (np.abs(spec) ** 2) / len(x)
        ps = p if ps is None else ps + p
        got += 1
        if got >= 2:
            break
    if fatal:
        raise RuntimeError(fatal)
    if ps is None or got == 0:
        raise RuntimeError("readStream: нет сэмплов (шлюз/кабель/прошивка?)")
    ps = ps / got
    db = 10.0 * np.log10(ps + 1e-12)
    freqs = np.fft.fftshift(np.fft.fftfreq(used, 1.0 / fs)) / 1e6 + center_mhz
    return _pool_bins(freqs, db, n)


FPGA_GW_PORT = int(os.environ.get("LEGION_FPGA_PORT", "5531"))


def fpga_gw_host(args: str) -> str:
    """IP шлюза из Soapy-аргументов (remote=tcp://IP:55132) или пусто."""
    for part in (args or "").split(","):
        part = part.strip()
        if part.startswith("remote=tcp://"):
            return part.split("//", 1)[1].split(":")[0]
    return ""


def fpga_rpc(host: str, msg: dict[str, Any]) -> dict[str, Any]:
    """Релей команды FPGA на legion_gateway шлюза (TCP, одна JSON-строка).
    Работает и когда Soapy не открыт: управление FPGA не зависит от стрима."""
    import socket as _socket

    if not host:
        return {"ok": False, "reason": "нет IP шлюза (remote=tcp://...) — FPGA-агент недоступен"}
    try:
        with _socket.create_connection((host, FPGA_GW_PORT), timeout=3.0) as s:
            s.sendall((json.dumps(msg) + "\n").encode())
            f = s.makefile("rb")
            line = f.readline()
        if not line:
            return {"ok": False, "reason": "шлюз закрыл соединение без ответа"}
        return json.loads(line.decode("utf-8", "replace"))
    except OSError as e:
        return {"ok": False, "reason": f"FPGA-агент {host}:{FPGA_GW_PORT}: {e}"}


def probe(args: str = "") -> dict[str, Any]:
    """Локальный enumerate пустой для SoapyRemote — нужен remote=tcp://host:55132."""
    found: list[dict[str, str]] = []
    if SOAPY:
        try:
            kw = parse_args(args)
            rows = SoapySDR.Device.enumerate(kw) if kw else SoapySDR.Device.enumerate()
            for row in rows:
                found.append({str(k): str(v) for k, v in dict(row).items()})
        except Exception as e:
            return {"ok": False, "reason": f"enumerate: {e}", "soapy": True, "devices": []}
    return {
        "ok": True,
        "soapy": SOAPY,
        "numpy": NUMPY,
        "fake": FAKE,
        "devices": found,
        "reason": "SoapySDR ок" if SOAPY else "SoapySDR не найден — поставьте python3-soapysdr на хосте/шлюзе",
    }


def handle(msg: dict[str, Any], radio: Radio) -> dict[str, Any]:
    op = msg.get("op")
    if op == "ping":
        return {
            "ok": True,
            "soapy": SOAPY,
            "numpy": NUMPY,
            "fake": FAKE or radio.fake,
            "txLive": radio.tx_live(),
            **({"txError": radio.tx_error} if radio.tx_error else {}),
        }
    if op == "probe":
        return probe(str(msg.get("args") or ""))
    if op == "open":
        return radio.open(
            str(msg.get("args") or ""),
            float(msg.get("analogBwMhz") or 20),
            bool(msg.get("canTx", True)),
            bool(msg.get("fullDuplex", True)),
        )
    if op == "scan":
        return radio.scan(float(msg["centerMhz"]), float(msg["bwMhz"]), int(msg.get("bins") or 64))
    if op == "tx":
        return radio.tx_cue(float(msg["freqMhz"]))
    if op == "tx_wave":
        params = msg.get("params")
        return radio.tx_wave(
            float(msg["freqMhz"]),
            str(msg.get("wave") or ""),
            params if isinstance(params, dict) else {},
        )
    if op == "tx_off":
        radio.tx_off()
        return {"ok": True, "reason": "TX off"}
    if op == "fpga":
        # Релей на legion_gateway шлюза: {"op":"fpga", "cmd":{...}, "gw"?:ip}
        cmd = msg.get("cmd")
        if not isinstance(cmd, dict):
            return {"ok": False, "reason": "fpga: нет cmd"}
        host = str(msg.get("gw") or "") or fpga_gw_host(radio.args)
        return fpga_rpc(host, cmd)
    if op == "close":
        radio.close()
        return {"ok": True, "reason": "closed"}
    return {"ok": False, "reason": f"unknown op {op}"}


def main() -> int:
    radio = Radio()
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError as e:
            _reply(ok=False, reason=f"JSON: {e}")
            continue
        try:
            _reply(**handle(msg, radio))
        except Exception as e:
            _reply(ok=False, reason=str(e))
    radio.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
