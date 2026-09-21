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

Режим 1: RX как DIO-sys/spectrum_analyzer — непрерывный захват в кольцо
(40 MSPS, 4096/USB, без overflow), Hann, Welch-8, |X|²/N², сглаживание DC
+ TX CW на LO → RF out. ESP32 сюда не входит.
LEGION_SDR_FAKE=1 — только проверка протокола (не эфир).
"""
from __future__ import annotations

import json
import math
import gc
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

def _import_soapy():
    """apt python3-soapysdr кладёт модуль в dist-packages системного python.
    venv без --system-site-packages и python с deadsnakes его не видят."""
    try:
        import SoapySDR as soapy

        return soapy
    except ImportError:
        pass
    ver = f"{sys.version_info.major}.{sys.version_info.minor}"
    extra = (
        f"/usr/lib/python{ver}/dist-packages",
        "/usr/lib/python3/dist-packages",
        "/usr/local/lib/python3/dist-packages",
    )
    for p in extra:
        if p in sys.path or not os.path.isfile(os.path.join(p, "SoapySDR.py")):
            continue
        sys.path.insert(0, p)
        try:
            import SoapySDR as soapy

            return soapy
        except Exception:
            try:
                sys.path.remove(p)
            except ValueError:
                pass
    return None


def soapy_missing_reason() -> str:
    exe = sys.executable
    ver = f"{sys.version_info.major}.{sys.version_info.minor}"
    return (
        f"SoapySDR нет в {exe} (Python {ver}) — пакет python3-soapysdr "
        "ставится в системный python, не в venv и не в deadsnakes. "
        "LEGION_PYTHON=/usr/bin/python3 или: python3 -m venv --system-site-packages .venv"
    )


SoapySDR = _import_soapy()
if SoapySDR is not None:
    from SoapySDR import SOAPY_SDR_CF32, SOAPY_SDR_RX, SOAPY_SDR_TX

    SOAPY = True
    SOAPY_SDR_TIMEOUT = int(getattr(SoapySDR, "SOAPY_SDR_TIMEOUT", SOAPY_SDR_TIMEOUT))
    SOAPY_SDR_STREAM_ERROR = int(getattr(SoapySDR, "SOAPY_SDR_STREAM_ERROR", SOAPY_SDR_STREAM_ERROR))
    SOAPY_SDR_CORRUPTION = int(getattr(SoapySDR, "SOAPY_SDR_CORRUPTION", SOAPY_SDR_CORRUPTION))
    SOAPY_SDR_OVERFLOW = int(getattr(SoapySDR, "SOAPY_SDR_OVERFLOW", SOAPY_SDR_OVERFLOW))
    SOAPY_SDR_UNDERFLOW = int(getattr(SoapySDR, "SOAPY_SDR_UNDERFLOW", SOAPY_SDR_UNDERFLOW))
else:
    # Constants.h: TX=0 RX=1 — те же числа без модуля, чтобы park() и тесты
    # с mock-Device не сравнивали направление с None.
    SOAPY_SDR_CF32 = "CF32"
    SOAPY_SDR_TX = 0
    SOAPY_SDR_RX = 1
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


def _log(msg: str) -> None:
    """Диагностика — в stderr: stdout занят RPC-протоколом, а stderr
    Tauri наследует (sdr.rs) — строки видны в консоли приложения."""
    sys.stderr.write(f"[sdr_worker] {msg}\n")
    sys.stderr.flush()


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


def kwargs_str(kw: dict[str, str]) -> str:
    """SoapySDR issue #472: на новых SWIG (Python 3.13+) Device(dict) путает
    перегрузку make(Kwargs) с make(KwargsList) — dict не маршалится в C++,
    итог: конструктор открывает плату, а make бросает "no match" (поймано на
    стенде 2026-08-27, Ubuntu 26.04, Python 3.14, soapysdr 0.8.1-7build1).
    Строковая форма make(string) перегрузкой не затронута. enumerate(dict)
    багу не подвержен (у него нет перегрузки list) — probe не трогаем."""
    return ",".join(f"{k}={v}" for k, v in kw.items())


TX_FS = 2.0e6
# NCO FTW / solo-park. Эфир+FPGA паркуется на эту fs: окно детектора
# 16 сэмплов = 8 мкс (det_shift=4), петля видит ±1 МГц вокруг LO.
FPGA_PARK_FS_HZ = 2_000_000
# SoapyBladeRF bladeRF_Streaming.cpp: CF32 = SC16Q11 / 2048 (fullScale=2048).
# Детектор FPGA считает I²+Q² по кодам SC16Q11 — энергии из CF32 домножаем
# на 2048², тогда порог det_thr в единицах регистра DET_THR без поправок.
CF32_FULL_SCALE = 2048.0
# libbladeRF bladerf_get_board_name / SoapyBladeRF getHardwareKey():
#   bladerf1 = LMS6002D (x40/x115, CONTROL bit1/2)
#   bladerf2 = AD9361 micro (этими битами не кормится)


def classify_bladerf_hw(hardware_key: str, info: dict[str, str] | None = None) -> str:
    """lms | ad9361 | unknown. Не угадываем по драйверу bladerf — он общий."""
    key = (hardware_key or "").strip().lower()
    if key == "bladerf1":
        return "lms"
    if key == "bladerf2":
        return "ad9361"
    blob = " ".join([key, *(str(v).lower() for v in (info or {}).values())])
    if "bladerf2" in blob:
        return "ad9361"
    if "bladerf1" in blob:
        return "lms"
    return "unknown"


def soapy_hw_snapshot(dev: Any) -> dict[str, Any]:
    key = ""
    info: dict[str, str] = {}
    try:
        key = str(dev.getHardwareKey() or "")
    except Exception:
        key = ""
    try:
        raw = dev.getHardwareInfo()
        info = {str(k): str(v) for k, v in dict(raw).items()}
    except Exception as e:
        _log(f"getHardwareInfo не удался (класс платы — только по hardwareKey): {e}")
    return {"hardwareKey": key, "info": info, "class": classify_bladerf_hw(key, info)}


TX_N = 4096  # кратно 8 → целое число периодов при bb = fs/8 (Deepwave AIR-T)
TX_FAIL_LIMIT = 8
# DIO-sys/spectrum_analyzer: FFT 1024/2048/4096, Welch 8 кадров, Hann, |X|²/N².
# capture.hpp: 40 MSPS, 4096 сэмплов/USB, 32 буфера; main.cpp: кольцо 2^18.
# soapy_power/psd.py: fft_overlap=0.5, crop_factor=overlap если --crop.
# soapy_power/power.py: после setFrequency крутит read_stream, пока не пройдёт tune_delay.
FFT_SIZES = (1024, 2048, 4096)
WELCH_FRAMES = 8
FFT_MIN = 1024
FFT_OVERLAP = 0.5
CROP_FACTOR = 0.5
DIO_SAMPLE_RATE_HZ = 40_000_000
DIO_BANDWIDTH_HZ = 40_000_000
# Слух Атаки: analog 56 / ADC 61.44 (Nuand). Не трогает scan() DIO-40.
ATTACK_LISTEN_FS_HZ = 61_440_000
ATTACK_LISTEN_BW_HZ = 56_000_000
ATTACK_FD_FS_HZ = 40_000_000
ATTACK_FFT_N = 4096
ATTACK_FFT_N_FULL = 8192
ATTACK_EDGE_CROP = 0.05
TRANSFER_SAMPLES = 4096
USB_RX_BUFFERS = 32
RING_CAP = 1 << 18
RX_GAIN_DB = 30


def dio_rx_rate(_analog_bw_mhz: float = 0.0) -> float:
    """DIO-sys capture.hpp SAMPLE_RATE_HZ = 40e6.
    analog BW платы (x40: 28 МГц) — это фильтр, не частота дискретизации."""
    return float(DIO_SAMPLE_RATE_HZ)


def attack_crop_factor(fs_hz: float, filter_hz: float) -> float:
    """Край фильтра. 61.44/56 → неиспользуемый Nyquist; fs=filter → 5%."""
    span = float(fs_hz)
    filt = float(filter_hz)
    if span <= 0:
        return ATTACK_EDGE_CROP
    if filt + 5e4 >= span:
        return ATTACK_EDGE_CROP
    return min(0.49, max(0.0, 1.0 - filt / span))


def attack_pick_fft_n(hint: int, available: int) -> int:
    """4096 сразу; 8192 если в кольце хватает на Welch-8 (GQRX default)."""
    want = int(hint) if hint else ATTACK_FFT_N
    need_full = welch_need_samples(ATTACK_FFT_N_FULL)
    if want >= ATTACK_FFT_N_FULL and int(available) >= need_full:
        return ATTACK_FFT_N_FULL
    return ATTACK_FFT_N


def rx_is_parked(
    rx_on: bool,
    rx_hz: float | None,
    rx_fs: float | None,
    center_hz: float,
    fs: float,
    discard_left: int,
    capture_alive: bool,
) -> bool:
    """DIO-sys capture.cpp: USB-команды только если частота/gain реально сменились."""
    return (
        bool(rx_on)
        and capture_alive
        and discard_left <= 0
        and rx_hz == center_hz
        and rx_fs == fs
    )


# Оседание после смены LO: AD9361 LO lock без fast lock ~200 мкс (EZ t=87062),
# ADF4351 20 мкс band select + 100–300 мкс петля (docs/architecture.md).
# 5 мс — запас ×10 к худшему PLL. DIO-sys после retune вообще не дискардит
# (capture.cpp: set_frequency и дальше sync_rx), а 32×4096 на 2 MSPS — это
# 65.5 мс задержки handoff на каждой парковке, не физика.
SETTLE_TIME_S = 5e-3
# soapy_power setup(tune_delay=...): у нас то же 5 мс, что уже обоснованы PLL.
TUNE_DELAY_S = SETTLE_TIME_S


def settle_samples(fs: float = 0.0) -> int:
    """Дискард после смены LO: min(глубина USB DIO-sys 32×4096, SETTLE_TIME_S × fs).
    На 40 MSPS скане — как раньше 131072 (время режет сильнее USB); на 2 MSPS
    park — 10000 сэмплов (5 мс) вместо 65.5 мс. fs<=0 → глубина USB."""
    usb_depth = USB_RX_BUFFERS * TRANSFER_SAMPLES
    if not fs or fs <= 0:
        return usb_depth
    return min(usb_depth, math.ceil(SETTLE_TIME_S * fs))


class IqRing:
    """Кольцо DIO-sys CircularBuffer: SPSC, ёмкость 2^n, старое затирается."""

    def __init__(self, capacity: int) -> None:
        if not NUMPY:
            raise RuntimeError("numpy required")
        if capacity < 2 or (capacity & (capacity - 1)) != 0:
            raise ValueError("IqRing: ёмкость должна быть степенью двойки")
        self.buf = np.zeros(capacity, dtype=np.complex64)
        self.cap = int(capacity)
        self.mask = int(capacity - 1)
        self._w = 0
        self._r = 0
        self._lock = threading.Lock()

    def reset(self) -> None:
        with self._lock:
            self._w = 0
            self._r = 0

    def available(self) -> int:
        with self._lock:
            return int(self._w - self._r)

    def push_block(self, samples: Any) -> None:
        n = int(len(samples))
        if n <= 0:
            return
        with self._lock:
            w = self._w
            start = w & self.mask
            end = start + n
            if end <= self.cap:
                self.buf[start:end] = samples
            else:
                first = self.cap - start
                self.buf[start:] = samples[:first]
                self.buf[: n - first] = samples[first:]
            w += n
            r = self._r
            if w - r > self.cap:
                r = w - self.cap
            self._w = w
            self._r = r

    def pop_batch(self, n: int) -> Any:
        n = int(n)
        with self._lock:
            if self._w - self._r < n:
                return None
            out = np.empty(n, dtype=np.complex64)
            r = self._r
            start = r & self.mask
            end = start + n
            if end <= self.cap:
                out[:] = self.buf[start:end]
            else:
                first = self.cap - start
                out[:first] = self.buf[start:]
                out[first:] = self.buf[: n - first]
            self._r = r + n
            return out

    def drop_oldest(self, n: int) -> int:
        """Выбросить хвост — как processing thread DIO, который всегда на самом свежем IQ."""
        n = max(0, int(n))
        with self._lock:
            have = int(self._w - self._r)
            n = min(n, have)
            self._r += n
            return n


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
        # Кольцо DIO-sys + кэш fs/bw/LO. SoapyBladeRF setSampleRate при каждом
        # вызове перепрограммирует clock chain (стенд 2026-08-27: buf_ready
        # timeout 1000 ms). USB-команды только если значение реально сменилось.
        self._rx_hz: float | None = None
        self._rx_fs: float | None = None
        self._rx_bw: float | None = None
        self._rx_cap_stop = threading.Event()
        self._rx_cap_stop.set()
        self._rx_pause = threading.Event()
        self._rx_cap_thr: threading.Thread | None = None
        self._ring: IqRing | None = None
        self._discard_left = 0
        self._rx_gen = 0
        self._tune_until = 0.0
        self._rx_io = threading.Lock()
        self._tone = None
        self._tx_fs = float(TX_FS)
        self.tx_error: str | None = None
        self.tx_fail = 0
        self.hardware_key = ""

    def tx_live(self) -> bool:
        if self.tx_mhz is None or self.tx_error:
            return False
        if self.fake:
            return True
        return self._thr is not None and self._thr.is_alive()

    def close(self) -> None:
        self.tx_off()
        self._stop_rx_capture()
        self._rx_hz = None
        self._rx_fs = None
        self._rx_bw = None
        self._discard_left = 0
        with self._lock:
            if self.dev is not None and SOAPY:
                try:
                    if self.rx is not None:
                        self.dev.deactivateStream(self.rx)
                        self.dev.closeStream(self.rx)
                except Exception as e:
                    _log(f"close: RX-стрим не закрылся чисто: {e}")
                try:
                    if self.tx is not None:
                        self.dev.deactivateStream(self.tx)
                        self.dev.closeStream(self.tx)
                except Exception as e:
                    _log(f"close: TX-стрим не закрылся чисто: {e}")
                # Детерминированный unmake USB-handle (SoapySDR issue #225:
                # иначе устройство занято до сборки мусора → -7 при re-open).
                try:
                    self.dev.close()
                except Exception as e:
                    _log(f"close: Soapy Device.close() отказал — re-open может дать -7: {e}")
            self.dev = None
            self.rx = None
            self.tx = None
            self._rx_on = False
            self._rx_fs = None
            self._rx_bw = None
            self.args = ""
            self.tx_error = None
            self.hardware_key = ""
        # Soapy-Device держит USB-handle до GC: без принудительного сбора
        # быстрый re-open ловит -7 NODEV (поймано на стенде 2026-08-27).
        gc.collect()

    def _unmake(self) -> None:
        with self._lock:
            if self.dev is not None and SOAPY:
                try:
                    self.dev.close()
                except Exception as e:
                    _log(f"unmake: Soapy Device.close() отказал: {e}")
            self.dev = None
            self.rx = None
            self.tx = None
            self._rx_on = False
        gc.collect()

    def open(
        self,
        args: str,
        analog_bw: float,
        can_tx: bool,
        full_duplex: bool,
        require_hw: str = "",
    ) -> dict[str, Any]:
        self.close()
        self.analog_bw = analog_bw if analog_bw > 0 else 20.0
        self.can_tx = can_tx
        self.full_duplex = full_duplex
        self.args = args
        if self.fake or args.startswith("driver=fake"):
            self.fake = True
            if require_hw:
                return {
                    "ok": False,
                    "reason": "FAKE worker — не эфир, FPGA ARM нельзя",
                    "fake": True,
                    "hardwareKey": "",
                }
            return {"ok": True, "reason": "FAKE worker — не эфир", "fake": True, "hardwareKey": ""}
        if not SOAPY:
            return {"ok": False, "reason": soapy_missing_reason()}
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
            full = {str(k): str(v) for k, v in dict(found[0]).items()}
            # Ключ device=bus:addr меняется при каждом переподключении USB —
            # Device::make() с ним ловит "no match". Стабильный селектор: driver+serial.
            kw = {k: full[k] for k in ("driver", "serial") if k in full}
            if not kw:
                kw = full
        candidates = [kw]
        # requireHw: bladerf1 = LMS6002D (x40/x115), bladerf2 = AD9361 (micro).
        # Проверка по getHardwareKey — драйвер bladerf общий для обеих.
        want_class = {"bladerf1": "lms", "bladerf2": "ad9361"}.get(require_hw)
        if want_class:
            # Soapy enumerate не пишет board name. Открываем каждую bladeRF
            # и смотрим getHardwareKey (bladerf1 vs bladerf2).
            try:
                filt = dict(kw) if kw.get("remote") else {"driver": "bladerf"}
                rows = list(SoapySDR.Device.enumerate(filt))
                found_kw: list[dict[str, str]] = []
                for row in rows:
                    full = {str(k): str(v) for k, v in dict(row).items()}
                    sel = {k: full[k] for k in ("driver", "serial") if k in full}
                    if kw.get("remote"):
                        sel = {**kw, **sel}
                    if sel:
                        found_kw.append(sel)
                if found_kw:
                    candidates = found_kw
            except Exception:
                pass
        last_err: Exception | None = None
        last_hw = ""
        for cand in candidates:
            self.dev = None
            for _ in range(4):
                try:
                    self.dev = SoapySDR.Device(kwargs_str(cand))
                    _setup_front_end(self.dev, self.can_tx)
                    last_err = None
                    break
                except Exception as e:
                    last_err = e
                    self.dev = None
                    gc.collect()
                    time.sleep(0.4)
            if self.dev is None:
                continue
            snap = soapy_hw_snapshot(self.dev)
            self.hardware_key = str(snap["hardwareKey"])
            last_hw = self.hardware_key
            if want_class and snap["class"] != want_class:
                last_err = RuntimeError(
                    f"открыт {self.hardware_key or 'плата без hardwareKey'} — "
                    f"нужен {require_hw}, а это {snap['class'] or 'не bladeRF'}"
                )
                self._unmake()
                continue
            return {
                "ok": True,
                "reason": f"открыт Soapy {cand}"
                + (f" · {self.hardware_key}" if self.hardware_key else ""),
                "fake": False,
                "hardwareKey": self.hardware_key,
            }
        return {
            "ok": False,
            "reason": f"Soapy Device(): {last_err}",
            "hardwareKey": last_hw,
        }

    def _stop_rx_capture(self) -> None:
        self._rx_cap_stop.set()
        self._rx_pause.set()
        thr = self._rx_cap_thr
        if thr is not None and thr.is_alive():
            thr.join(timeout=2.5)
            if thr.is_alive():
                # Поток-демон умрёт с процессом, но до тех пор держит readStream.
                _log("RX-захват пережил join 2.5 с — readStream завис в Soapy (плата отвалилась?)")
        self._rx_cap_thr = None

    def _start_rx_capture(self) -> None:
        if self.fake or not NUMPY:
            return
        if self._ring is None:
            self._ring = IqRing(RING_CAP)
        self._rx_cap_stop.clear()
        if self._rx_cap_thr is not None and self._rx_cap_thr.is_alive():
            return
        self._rx_cap_thr = threading.Thread(
            target=self._rx_capture_loop, name="legion-sdr-rx", daemon=True
        )
        self._rx_cap_thr.start()

    def _rx_capture_loop(self) -> None:
        """DIO-sys CaptureThread: непрерывный readStream в кольцо — иначе overflow."""
        if not NUMPY:
            return
        buf = np.zeros(TRANSFER_SAMPLES, dtype=np.complex64)
        last_err_log = 0.0
        while not self._rx_cap_stop.is_set():
            if self._rx_pause.is_set() or not self._rx_on or self.dev is None or self.rx is None:
                time.sleep(0.0002)
                continue
            fs = self._rx_fs or float(DIO_SAMPLE_RATE_HZ)
            timeout = max(50_000, int(8.0 * TRANSFER_SAMPLES / max(fs, 1.0) * 1e6))
            with self._rx_io:
                if self._rx_pause.is_set() or not self._rx_on or self.dev is None or self.rx is None:
                    continue
                try:
                    sr = self.dev.readStream(self.rx, [buf], TRANSFER_SAMPLES, timeoutUs=timeout)
                except Exception as e:
                    # Ретрай осознанный (краткий сбой шины), но молчание при
                    # мёртвой плате — было слепым пятном: лог не чаще раза в 5 с.
                    now = time.monotonic()
                    if now - last_err_log >= 5.0:
                        last_err_log = now
                        _log(f"readStream исключение (ретрай): {e}")
                    time.sleep(0.001)
                    continue
                if self._rx_pause.is_set():
                    continue
                ret = stream_ret(sr)
                kind = stream_kind(ret)
                if kind in ("error", "overflow"):
                    # overflow: этот блок дырявый, следующий уже из живого USB.
                    continue
                if ret <= 0:
                    continue
                chunk = buf[:ret]
                left = self._discard_left
                if left > 0:
                    take = min(left, ret)
                    self._discard_left = left - take
                    if take < ret and self._ring is not None:
                        self._ring.push_block(chunk[take:])
                    if self._discard_left <= 0:
                        self._rx_gen += 1
                    continue
                if self._ring is not None:
                    self._ring.push_block(chunk)

    def _apply_rx_clock(self, fs: float, bw: float) -> float:
        """setSampleRate + setBandwidth. Фактический rate — из Soapy."""
        assert self.dev is not None
        self.dev.setSampleRate(SOAPY_SDR_RX, 0, fs)
        try:
            self.dev.setBandwidth(SOAPY_SDR_RX, 0, float(bw))
            self._rx_bw = float(bw)
        except Exception:
            self.dev.setBandwidth(SOAPY_SDR_RX, 0, fs)
            self._rx_bw = fs
        try:
            got = float(self.dev.getSampleRate(SOAPY_SDR_RX, 0))
            if got > 0:
                return got
        except Exception:
            pass
        return fs

    def _apply_dio_rx_clock(self, fs: float) -> float:
        """DIO-sys configure_device: 40 MSPS + 40 МГц. Фактический rate — из Soapy."""
        return self._apply_rx_clock(fs, float(DIO_BANDWIDTH_HZ))

    def _ensure_rx(self, fs: float, center_hz: float, bw: float | None = None) -> int:
        """Настроить LO/fs и вернуть поколение кольца, с которого IQ свежий.

        setSampleRate на живом потоке валит bladeRF2 (стенд 2026-08-27).
        Rate — только при смене, через deactivate→перестройка→activate.
        LO (setFrequency) на живом потоке безопасен.
        bw=None — DIO 40 МГц (scan). Атака передаёт фильтр 56 или FD.
        """
        assert self.dev is not None
        want_bw = float(bw) if bw and bw > 0 else float(DIO_BANDWIDTH_HZ)
        alive = self._rx_cap_thr is not None and self._rx_cap_thr.is_alive()
        parked = rx_is_parked(self._rx_on, self._rx_hz, self._rx_fs, center_hz, fs, self._discard_left, alive)
        if parked and self._rx_bw == want_bw:
            return self._rx_gen
        retuned = self._rx_hz != center_hz or self._rx_fs != fs or self._rx_bw != want_bw or not self._rx_on
        self._rx_pause.set()
        try:
            with self._rx_io, self._lock:
                rate_changed = self._rx_fs != fs or self._rx_bw != want_bw or not self._rx_on
                if rate_changed and self.rx is not None and self._rx_on:
                    try:
                        self.dev.deactivateStream(self.rx)
                    except Exception:
                        pass
                    self._rx_on = False
                if rate_changed:
                    fs = self._apply_rx_clock(fs, want_bw)
                if self._rx_hz != center_hz:
                    self.dev.setFrequency(SOAPY_SDR_RX, 0, center_hz)
                if self.rx is None:
                    self.rx = self.dev.setupStream(SOAPY_SDR_RX, SOAPY_SDR_CF32)
                    self.dev.activateStream(self.rx)
                    self._rx_on = True
                elif not self._rx_on:
                    self.dev.activateStream(self.rx)
                    self._rx_on = True
                self._rx_hz = center_hz
                self._rx_fs = fs
                if self._ring is None and NUMPY:
                    self._ring = IqRing(RING_CAP)
                if retuned:
                    if self._ring is not None:
                        self._ring.reset()
                    self._discard_left = settle_samples(fs)
                    self._tune_until = time.monotonic() + TUNE_DELAY_S
                    pending = self._rx_gen + 1
                else:
                    pending = self._rx_gen
                if self._rx_on:
                    self._start_rx_capture()
                return pending
        finally:
            self._rx_pause.clear()

    def _wait_psd(
        self,
        gen: int,
        n: int,
        fs: float,
        center_mhz: float,
        crop_factor: float | None = None,
        fft_n: int | None = None,
    ) -> list[dict[str, float]]:
        size = int(fft_n) if fft_n and fft_n > 0 else _pick_fft_size(n)
        need = welch_need_samples(size)
        deadline = time.monotonic() + 2.5
        while time.monotonic() < deadline:
            if self._tune_until and time.monotonic() < self._tune_until:
                time.sleep(0.0005)
                continue
            if (
                self._rx_gen >= gen
                and self._ring is not None
                and self._ring.available() >= need
            ):
                return _psd_from_ring(self._ring, n, fs, center_mhz, crop_factor, size)
            time.sleep(0.0005)
        raise RuntimeError("RX: нет полного кадра FFT после настройки LO (шлюз/кабель/прошивка?)")

    def scan(self, center_mhz: float, bw_mhz: float, bins: int) -> dict[str, Any]:
        n = max(8, min(int(bins), 4096))
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
            # Живой scan() игнорирует bw: ось = fs = 40 MSPS, потом crop soapy.
            adc_mhz = DIO_SAMPLE_RATE_HZ / 1e6
            raw = _fake_bins(center_mhz, adc_mhz, _pick_fft_size(n))
            return {"ok": True, "bins": crop_psd_bins(raw, CROP_FACTOR), "centerMhz": center_mhz, **extra}
        if self.dev is None:
            return {"ok": False, "reason": "SDR не открыт", "bins": [], **extra}
        if not NUMPY:
            return {"ok": False, "reason": "нужен numpy для FFT эфира", "bins": [], **extra}
        # DIO-sys capture.hpp: 40 MSPS / 40 МГц, не окно walker и не analog-фильтр.
        # Всегда 40 — слух Атаки (61.44) не должен протекать в sweep/band.
        fs = dio_rx_rate()
        try:
            gen = self._ensure_rx(fs, center_mhz * 1e6)
            spec = self._wait_psd(gen, n, self._rx_fs or fs, center_mhz)
        except Exception as e:
            return {"ok": False, "reason": f"RX: {e}", "bins": [], **extra}
        return {"ok": True, "bins": spec, "centerMhz": center_mhz, **extra}

    def attack_scan(
        self,
        center_mhz: float,
        fs_hz: float,
        bw_mhz: float,
        bins: int,
        crop_factor: float,
    ) -> dict[str, Any]:
        """Слух Атаки. Не scan(): свой fs/фильтр/crop/FFT 4096|8192."""
        extra = self._scan_extra()
        if not self.full_duplex and self.tx_mhz is not None:
            return {
                "ok": True,
                "bins": [],
                "centerMhz": center_mhz,
                "reason": "half-duplex: RX пауза, пока TX на RF out",
                **extra,
            }
        fs = float(fs_hz) if fs_hz and fs_hz > 0 else float(ATTACK_LISTEN_FS_HZ)
        filt_mhz = float(bw_mhz) if bw_mhz and bw_mhz > 0 else ATTACK_LISTEN_BW_HZ / 1e6
        crop = float(crop_factor) if crop_factor is not None else attack_crop_factor(fs, filt_mhz * 1e6)
        hint = max(ATTACK_FFT_N, min(int(bins or ATTACK_FFT_N), ATTACK_FFT_N_FULL))
        extra = {**extra, "attack": True, "fsHz": fs, "filterMhz": filt_mhz, "cropFactor": crop}
        if self.fake:
            n = ATTACK_FFT_N_FULL if hint >= ATTACK_FFT_N_FULL else ATTACK_FFT_N
            raw = _fake_bins(center_mhz, fs / 1e6, n)
            return {
                "ok": True,
                "bins": crop_psd_bins(raw, crop),
                "centerMhz": center_mhz,
                "fftN": n,
                **extra,
            }
        if self.dev is None:
            return {"ok": False, "reason": "SDR не открыт", "bins": [], **extra}
        if not NUMPY:
            return {"ok": False, "reason": "нужен numpy для FFT эфира", "bins": [], **extra}
        try:
            gen = self._ensure_rx(fs, center_mhz * 1e6, filt_mhz * 1e6)
            avail = self._ring.available() if self._ring is not None else 0
            fft_n = attack_pick_fft_n(hint, avail)
            spec = self._wait_psd(gen, fft_n, self._rx_fs or fs, center_mhz, crop, fft_n)
        except Exception as e:
            return {"ok": False, "reason": f"RX: {e}", "bins": [], **extra}
        return {"ok": True, "bins": spec, "centerMhz": center_mhz, "fftN": fft_n, **extra}

    def _soapy_get_hz(self, direction: int) -> float | None:
        try:
            hz = float(self.dev.getFrequency(direction, 0))
        except Exception:
            return None
        return hz if hz > 0 else None

    def _soapy_get_fs(self, direction: int) -> float | None:
        try:
            rate = float(self.dev.getSampleRate(direction, 0))
        except Exception:
            return None
        return rate if rate > 0 else None

    def _soapy_get_bw(self, direction: int) -> float | None:
        try:
            bw = float(self.dev.getBandwidth(direction, 0))
        except Exception:
            return None
        return bw if bw > 0 else None

    def park(self, center_mhz: float, bw_mhz: float, fs_hz: float, rx: bool, tx: bool) -> dict[str, Any]:
        """Поставить RX/TX LO без FFT. FPGA потом забирает USB.

        hostScan здесь нельзя: он поднимает 40 MSPS и не трогает TX LO —
        loopback ушёл бы на чужой TX PLL.

        Платы: bladeRF 1 (LMS6002D) и micro (AD9361) — обе паркуются через
        Soapy; разница в подъёме аналога после ухода хоста (x40 — CONTROL
        bit1/2 со шлюза, micro — AIR-регистры NIOS). HackRF/Pluto не
        подменяются.

        После set* читаем getFrequency/getSampleRate. «ok» без readback —
        вайб: драйвер мог проглотить запись, TX PLL остался на другой частоте.
        """
        fs = float(fs_hz) if fs_hz and fs_hz > 0 else float(FPGA_PARK_FS_HZ)
        hz = float(center_mhz) * 1e6
        bw = max(0.2, float(bw_mhz)) * 1e6
        base = {"freqMhz": center_mhz, "fsHz": fs}
        if not rx and not tx:
            return {"ok": False, "reason": "park: нужен RX и/или TX", **base}
        if self.fake:
            return {
                "ok": True,
                "reason": f"FAKE park {center_mhz:.3f} МГц · {fs / 1e6:.1f} MSPS",
                "fake": True,
                **base,
            }
        if self.dev is None:
            return {"ok": False, "reason": "SDR не открыт", **base}

        def _fail(why: str) -> dict[str, Any]:
            return {"ok": False, "reason": why, **base}

        snap = soapy_hw_snapshot(self.dev)
        if snap["class"] not in ("lms", "ad9361"):
            return _fail(
                f"park: {snap['hardwareKey'] or 'плата без hardwareKey'} — "
                "FPGA эфир: bladeRF 1 / micro (LMS6002D/AD9361); прочие не подменяются"
            )
        if tx and self.tx is not None:
            # setSampleRate на живом потоке валит bladeRF2 (стенд 2026-08-27)
            return _fail("park: TX стрим активен — сначала tx_off")

        # 1 МГц: ловит «не записалось» (0 / другой ГГц), не фазовый шум PLL.
        lo_tol = 1e6
        fs_req_tol = 0.15
        fs_match_tol = 0.02
        bw_min_frac = 0.5
        want_bw = min(bw, fs)
        rx_lo = tx_lo = rx_fs = tx_fs = None
        rx_gain_db: float | None = None
        got = fs
        # Скан держит живой RX на 40 MSPS: перестройка — по дисциплине
        # _ensure_rx (deactivate → retune → activate), кольцо сбрасываем,
        # дискард = settle (после него IQ чистый — на нём считают det_thr).
        retune_rx = rx and (self._rx_hz != hz or self._rx_fs != fs or not self._rx_on)
        live_rx = retune_rx and self._rx_on and self.rx is not None
        if live_rx:
            self._rx_pause.set()
        try:
            with self._rx_io, self._lock:
                if live_rx:
                    try:
                        self.dev.deactivateStream(self.rx)
                    except Exception:
                        pass
                    self._rx_on = False
                if rx:
                    self.dev.setSampleRate(SOAPY_SDR_RX, 0, fs)
                    self.dev.setFrequency(SOAPY_SDR_RX, 0, hz)
                    try:
                        self.dev.setBandwidth(SOAPY_SDR_RX, 0, want_bw)
                    except Exception as e:
                        return _fail(f"park: setBandwidth RX: {e}")
                    rx_bw = self._soapy_get_bw(SOAPY_SDR_RX)
                    if rx_bw is None:
                        return _fail("park: getBandwidth RX не ответил")
                    if rx_bw < bw_min_frac * want_bw:
                        return _fail(
                            f"park: RX BW {rx_bw / 1e6:.1f} МГц << {want_bw / 1e6:.1f} — "
                            "окно не analog (LMS дефолт ~1.5 МГц)"
                        )
                    rx_lo = self._soapy_get_hz(SOAPY_SDR_RX)
                    rx_fs = self._soapy_get_fs(SOAPY_SDR_RX)
                    if rx_lo is None:
                        return _fail("park: getFrequency RX не ответил")
                    if abs(rx_lo - hz) > lo_tol:
                        return _fail(
                            f"park: RX LO {rx_lo / 1e6:.3f} ≠ {center_mhz:.3f} МГц"
                        )
                    if rx_fs is None:
                        return _fail("park: getSampleRate RX не ответил")
                    if abs(rx_fs - fs) / fs > fs_req_tol:
                        return _fail(
                            f"park: RX fs {rx_fs / 1e6:.1f} MSPS ≠ запрошенные {fs / 1e6:.1f}"
                        )
                    got = rx_fs
                    self._rx_hz = rx_lo
                    self._rx_fs = rx_fs
                    if snap["class"] == "ad9361":
                        # Порог детектора FPGA считается по захвату при
                        # усилении парковки; AGC после ухода хоста уплыл бы —
                        # фиксируем ручной gain (факт: AGC AD9361 автономен).
                        try:
                            self.dev.setGainMode(SOAPY_SDR_RX, 0, False)
                        except Exception as e:
                            return _fail(f"park: AGC не выключается (setGainMode): {e}")
                        # Readback режима, не только gain: «записал» без
                        # подтверждения — вайб (та же философия, что LO/fs).
                        try:
                            gm = self.dev.getGainMode(SOAPY_SDR_RX, 0)
                        except Exception as e:
                            return _fail(f"park: getGainMode не ответил: {e}")
                        if bool(gm):
                            return _fail("park: AGC остался включённым после setGainMode(False)")
                        try:
                            # NIOS при ARM ставит ровно это усиление (gain_db в
                            # команде ARM) — полка измерена и применяется на
                            # одном и том же усилении.
                            rx_gain_db = float(self.dev.getGain(SOAPY_SDR_RX, 0))
                        except Exception:
                            rx_gain_db = None
                    # Стрим нужен det_capture (и уже жил у сканера): поднять,
                    # кольцо сбросить, дискард = settle — дальше IQ чистый.
                    if self.rx is None:
                        self.rx = self.dev.setupStream(SOAPY_SDR_RX, SOAPY_SDR_CF32)
                        self.dev.activateStream(self.rx)
                        self._rx_on = True
                    elif not self._rx_on:
                        self.dev.activateStream(self.rx)
                        self._rx_on = True
                    if NUMPY and self._ring is None:
                        self._ring = IqRing(RING_CAP)
                    if retune_rx:
                        if self._ring is not None:
                            self._ring.reset()
                        self._discard_left = settle_samples(fs)
                    self._start_rx_capture()
                if tx:
                    self.dev.setSampleRate(SOAPY_SDR_TX, 0, fs)
                    self.dev.setFrequency(SOAPY_SDR_TX, 0, hz)
                    try:
                        self.dev.setBandwidth(SOAPY_SDR_TX, 0, want_bw)
                    except Exception as e:
                        if rx:
                            return _fail(f"park: setBandwidth TX: {e}")
                    if rx:
                        tx_bw = self._soapy_get_bw(SOAPY_SDR_TX)
                        if tx_bw is None:
                            return _fail("park: getBandwidth TX не ответил")
                        if tx_bw < bw_min_frac * want_bw:
                            return _fail(
                                f"park: TX BW {tx_bw / 1e6:.1f} МГц << {want_bw / 1e6:.1f}"
                            )
                    tx_lo = self._soapy_get_hz(SOAPY_SDR_TX)
                    tx_fs = self._soapy_get_fs(SOAPY_SDR_TX)
                    if tx_lo is None:
                        return _fail("park: getFrequency TX не ответил")
                    if abs(tx_lo - hz) > lo_tol:
                        return _fail(
                            f"park: TX LO {tx_lo / 1e6:.3f} ≠ {center_mhz:.3f} МГц"
                        )
                    if tx_fs is None:
                        return _fail("park: getSampleRate TX не ответил")
                    if abs(tx_fs - fs) / fs > fs_req_tol:
                        return _fail(
                            f"park: TX fs {tx_fs / 1e6:.1f} MSPS ≠ запрошенные {fs / 1e6:.1f}"
                        )
                    if not rx:
                        got = tx_fs
                if rx and tx and rx_fs and tx_fs:
                    if abs(rx_fs - tx_fs) / max(rx_fs, tx_fs) > fs_match_tol:
                        return _fail(
                            f"park: RX {rx_fs / 1e6:.1f} и TX {tx_fs / 1e6:.1f} MSPS "
                            "разъехались — loopback FIFO не сойдётся"
                        )
                    got = rx_fs
        except Exception as e:
            return _fail(f"park LO: {e}")
        finally:
            if live_rx:
                self._rx_pause.clear()
        sides = "+".join(p for p, on in (("RX", rx), ("TX", tx)) if on)
        out: dict[str, Any] = {
            "ok": True,
            "reason": f"park {sides} {center_mhz:.3f} МГц · {got / 1e6:.1f} MSPS",
            "freqMhz": (rx_lo or tx_lo or hz) / 1e6,
            "fsHz": got,
        }
        if rx_lo is not None:
            out["rxLo"] = rx_lo
        if tx_lo is not None:
            out["txLo"] = tx_lo
        if rx_fs is not None:
            out["rxFs"] = rx_fs
        if tx_fs is not None:
            out["txFs"] = tx_fs
        if rx_gain_db is not None:
            out["rxGainDb"] = rx_gain_db
        return out

    def det_capture(self, win: int, windows: int) -> dict[str, Any]:
        """Захват IQ на припаркованном LO → медиана нижних 60% энергий окон.

        Вызывается между park() и передачей USB агенту (handoff скан→FPGA):
        хост ещё владеет стримом, RX на 2 MSPS. Результат × K уходит в
        det_thr при ARM lb_gated.
        """
        base = {"win": win, "windows": windows, "fsHz": self._rx_fs or 0}
        if self.fake:
            return {"ok": False, "reason": "det_capture: FAKE — не эфир", **base}
        if self.dev is None or not self._rx_on:
            return {"ok": False, "reason": "det_capture: RX не припаркован (сначала park)", **base}
        if not NUMPY:
            return {"ok": False, "reason": "det_capture: нужен numpy", **base}
        win = max(16, min(int(win), 4096))
        windows = max(64, min(int(windows), 4096))
        need = win * windows
        # Ждём, пока дискард settle стечёт (поколение сменится) и кольцо
        # наполнится свежим IQ. Без перестройки (тот же LO/fs) дискард = 0 —
        # данные и так свежие.
        gen0 = self._rx_gen
        deadline = time.monotonic() + 5.0
        got = False
        while time.monotonic() < deadline:
            fresh = self._rx_gen > gen0 or self._discard_left <= 0
            if fresh and self._ring is not None and self._ring.available() >= need:
                got = True
                break
            time.sleep(0.001)
        if not got or self._ring is None:
            return {
                "ok": False,
                "reason": "det_capture: нет свежего IQ после park (settle/поток?)",
                **base,
            }
        data = self._ring.pop_batch(need)
        if data is None:
            return {"ok": False, "reason": "det_capture: кольцо не отдало кадр", **base}
        try:
            med = window_energy_median(data, win)
        except Exception as e:
            return {"ok": False, "reason": f"det_capture: {e}", **base}
        return {"ok": True, "medianEnergy": med, **base}

    def _scan_extra(self) -> dict[str, Any]:
        out: dict[str, Any] = {"txLive": self.tx_live()}
        if self.tx_error:
            out["txError"] = self.tx_error
        return out

    def _tx_prime(self, buf: Any, lo_hz: float, prev_mhz: float | None, fs: float | None = None) -> dict[str, Any] | None:
        """RX-пауза (half-duplex) + tune LO + первый writeStream. None = успех,
        иначе dict с ошибкой. Откат: LO на прежнюю частоту или закрытие стрима.
        Буфер подменяется под локом сразу после первой записи — TX-петля не
        успевает выпустить старую волну на новой частоте.
        fs=None → TX_FS (2 МГц, tx_cue и обычный ПЕРЕДАТЬ). Solo пишет окно."""
        tx_fs = float(fs) if fs and fs > 0 else float(TX_FS)
        prev_fs = float(self._tx_fs) if self._tx_fs and self._tx_fs > 0 else float(TX_FS)
        timeout = stream_timeout_us(len(buf), tx_fs)
        created = False
        if not self.full_duplex:
            self._rx_pause.set()
            # Тот же порядок, что _ensure_rx: сначала _rx_io, потом _lock.
            self._rx_io.acquire()
        try:
            with self._lock:
                try:
                    if not self.full_duplex and self.rx is not None and self._rx_on:
                        self.dev.deactivateStream(self.rx)
                        self._rx_on = False
                    self.dev.setSampleRate(SOAPY_SDR_TX, 0, tx_fs)
                    try:
                        # Широким волнам (шум, OFDM — до fs) нужен весь фильтр TX,
                        # иначе дефолтный (~1.5 МГц у LMS6002D) режет края спектра.
                        self.dev.setBandwidth(SOAPY_SDR_TX, 0, min(tx_fs, self.analog_bw * 1e6))
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
                            self.dev.setFrequency(SOAPY_SDR_TX, 0, cw_lo_hz(prev_mhz * 1e6, prev_fs))
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
                    self._tx_fs = tx_fs
                except Exception as e:
                    return {"ok": False, "reason": f"TX tune: {e}", "latencyUs": 0}
        finally:
            if not self.full_duplex:
                self._rx_io.release()
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

    def tx_wave(self, freq_mhz: float, wave: str, params: dict[str, Any], fs_hz: float | None = None) -> dict[str, Any]:
        """TX произвольной baseband-волны из WAVE_KINDS (вкладка ТИП СИГНАЛА).
        Буфер гетеродинируется на +fs/8, LO = RF − fs/8: ось 0 Гц волны
        оказывается на запрошенной RF, DC-волны не давятся IQ-коррекцией.
        fs_hz=None → TX_FS (2 МГц). Solo передаёт fs окна, чтобы 4096 сэмплов
        в player RAM заняли ту же полосу, что analog/AIR_FS после ARM."""
        tx_fs = float(fs_hz) if fs_hz and fs_hz > 0 else float(TX_FS)
        if wave not in WAVE_KINDS:
            return {"ok": False, "reason": f"неизвестный тип сигнала: {wave}", "latencyUs": 0}
        if not self.can_tx:
            return {"ok": False, "reason": "нет TX — усилитель подключать некуда", "latencyUs": 0}
        t0 = time.perf_counter()
        if self.fake:
            if NUMPY:
                try:
                    make_waveform(wave, tx_fs, WAVE_N, params)
                except Exception as e:
                    return {"ok": False, "reason": f"синтез {wave}: {e}", "latencyUs": 0}
            self.tx_mhz = freq_mhz
            self._tx_fs = tx_fs
            self.tx_error = None
            us = int((time.perf_counter() - t0) * 1e6)
            return {
                "ok": True,
                "reason": f"FAKE TX {wave} {freq_mhz:.6f} МГц",
                "latencyUs": us,
                "freqMhz": freq_mhz,
                "fsHz": tx_fs,
                "fake": True,
            }
        if self.dev is None:
            return {"ok": False, "reason": "SDR не открыт", "latencyUs": 0}
        if not SOAPY:
            return {"ok": False, "reason": "нет Soapy", "latencyUs": 0}
        if not NUMPY:
            return {"ok": False, "reason": "нет numpy — сигнал не синтезировать", "latencyUs": 0}
        try:
            buf = make_waveform(wave, tx_fs, WAVE_N, params)
        except Exception as e:
            return {"ok": False, "reason": f"синтез {wave}: {e}", "latencyUs": 0}
        n = len(buf)
        t = np.arange(n, dtype=np.float64) / tx_fs
        buf = (buf * np.exp(1j * 2.0 * np.pi * (tx_fs / 8.0) * t)).astype(np.complex64)
        rf_hz = freq_mhz * 1e6
        lo_hz = cw_lo_hz(rf_hz, tx_fs)
        err = self._tx_prime(buf, lo_hz, self.tx_mhz, tx_fs)
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
                    timeout = stream_timeout_us(len(buf), self._tx_fs if self._tx_fs > 0 else TX_FS)
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
            if self._thr.is_alive():
                _log("TX-поток пережил join 3 с — writeStream завис в Soapy; стрим закрываем из-под него")
            self._thr = None
        self.tx_mhz = None
        self.tx_error = None
        self.tx_fail = 0
        if self.dev is not None and self.tx is not None and SOAPY:
            with self._lock:
                try:
                    self.dev.deactivateStream(self.tx)
                    self.dev.closeStream(self.tx)
                except Exception as e:
                    _log(f"tx_off: TX-стрим не закрылся чисто: {e}")
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
    """Антенна/gain/DC как DIO-sys capture.cpp. AGC не включаем — на антенне качает пол.
    Каждый шаг best-effort (не все платы/драйверы всё умеют), но отказ — в лог:
    молчаливый пропуск setGain оставлял бы тракт на неизвестном усилении."""
    try:
        rx_ants = list(dev.listAntennas(SOAPY_SDR_RX, 0) or [])
        pick = next((a for a in rx_ants if str(a).upper() in ("RX", "RX1", "RX2", "LNAL", "LNAH")), None)
        if pick or rx_ants:
            dev.setAntenna(SOAPY_SDR_RX, 0, pick or rx_ants[0])
    except Exception as e:
        _log(f"setup: RX-антенна не выставлена: {e}")
    try:
        dev.setGainMode(SOAPY_SDR_RX, 0, False)
    except Exception as e:
        _log(f"setup: ручной gain mode RX не выставлен: {e}")
    try:
        dev.setGain(SOAPY_SDR_RX, 0, RX_GAIN_DB)
    except Exception as e:
        _log(f"setup: RX gain {RX_GAIN_DB} дБ не выставлен: {e}")
    # DIO-sys: bladerf_set_correction DCOFF_I/Q = 0, дальше интерполяция DC-бина.
    try:
        dev.setDCOffsetMode(SOAPY_SDR_RX, 0, False)
    except Exception as e:
        _log(f"setup: DC offset mode не выставлен: {e}")
    try:
        dev.setDCOffset(SOAPY_SDR_RX, 0, 0.0 + 0.0j)
    except Exception as e:
        _log(f"setup: DC offset не выставлен: {e}")
    if not can_tx:
        return
    try:
        tx_ants = list(dev.listAntennas(SOAPY_SDR_TX, 0) or [])
        pick = next((a for a in tx_ants if "TX" in str(a).upper()), None)
        if pick or tx_ants:
            dev.setAntenna(SOAPY_SDR_TX, 0, pick or tx_ants[0])
    except Exception as e:
        _log(f"setup: TX-антенна не выставлена: {e}")
    try:
        rng = dev.getGainRange(SOAPY_SDR_TX, 0)
        lo, hi = float(rng.minimum()), float(rng.maximum())
        dev.setGain(SOAPY_SDR_TX, 0, lo + 0.4 * (hi - lo))
    except Exception as e:
        _log(f"setup: TX gain из диапазона не выставлен ({e}) — пробую 20 дБ")
        try:
            dev.setGain(SOAPY_SDR_TX, 0, 20)
        except Exception as e2:
            _log(f"setup: TX gain 20 дБ тоже не выставлен: {e2}")


def _pick_fft_size(n: int) -> int:
    """DIO-sys dropdown: 1024 / 2048 / 4096."""
    want = max(int(n), FFT_MIN)
    for size in FFT_SIZES:
        if want <= size:
            return size
    return FFT_SIZES[-1]


def welch_overlap_bins(fft_n: int, overlap: float = FFT_OVERLAP) -> int:
    """soapy_power/psd.py: floor(bins * fft_overlap) → noverlap Welch."""
    return int(math.floor(int(fft_n) * float(overlap)))


def welch_hop_samples(fft_n: int, overlap: float = FFT_OVERLAP) -> int:
    return max(1, int(fft_n) - welch_overlap_bins(fft_n, overlap))


def welch_need_samples(fft_n: int, frames: int = WELCH_FRAMES, overlap: float = FFT_OVERLAP) -> int:
    """Кадры с перекрытием: N + (frames−1)*hop. soapy welch noverlap=floor(N/2)."""
    return int(fft_n) + max(0, int(frames) - 1) * welch_hop_samples(fft_n, overlap)


def crop_psd_bins(bins: list[dict[str, float]], crop_factor: float = CROP_FACTOR) -> list[dict[str, float]]:
    """soapy_power/psd.py result(): crop_bins_half = round((crop_factor * bins) / 2)."""
    n = len(bins)
    if crop_factor <= 0 or n < 4:
        return bins
    half = int(round((float(crop_factor) * n) / 2.0))
    if half <= 0 or 2 * half >= n:
        return bins
    return bins[half : n - half]


def _hann(n: int) -> Any:
    """w[n] = 0.5 * (1 − cos(2πn / (N−1))) — processing.cpp rebuild_plan."""
    idx = np.arange(n, dtype=np.float64)
    return (0.5 * (1.0 - np.cos(2.0 * np.pi * idx / (n - 1)))).astype(np.float32)


def welch_dbm(frames: Any) -> Any:
    """DIO-sys convert_to_dbm + fftshift + интерполяция DC.
    frames: (WELCH_FRAMES, N) complex. power = |X|² / N²."""
    n = int(frames.shape[1])
    win = _hann(n)
    accum = np.zeros(n, dtype=np.float64)
    for i in range(frames.shape[0]):
        x = frames[i] * win
        spec = np.fft.fft(x)
        accum += np.abs(spec) ** 2
    avg = accum / float(frames.shape[0])
    power = np.maximum(avg / (n * n), 1e-20)
    db = 10.0 * np.log10(power)
    db = np.fft.fftshift(db)
    half = n // 2
    db[half] = 0.5 * (db[half - 1] + db[half + 1])
    return db


def estimate_noise_floor(db: Any) -> float:
    """DIO-sys psd_plot.estimate_noise_floor: медиана нижних 60%."""
    sorted_vals = np.sort(np.asarray(db, dtype=np.float64))
    lower = sorted_vals[: max(1, int(len(sorted_vals) * 0.60))]
    return float(np.median(lower))


def window_energy_median(samples: Any, win: int) -> float:
    """Медиана нижних 60% средних энергий окон I²+Q², единицы SC16Q11.

    Нижние 60% — тот же приём, что estimate_noise_floor: захват делается
    НА припаркованном пике, сигнал в нём присутствует; медиана всех окон
    поднялась бы до энергии сигнала, и det_thr = медиана × K стал бы выше
    самого сигнала (гейт глухой). Нижняя часть окон — шумовая полка.
    """
    n = (int(len(samples)) // win) * win
    if n <= 0:
        raise RuntimeError("window_energy_median: сэмплов меньше окна")
    # complex128, не float64: каст в float молча выбросил бы Q (ComplexWarning).
    x = np.asarray(samples[:n], dtype=np.complex64).astype(np.complex128) * CF32_FULL_SCALE
    e = (x.real**2 + x.imag**2).reshape(-1, win).mean(axis=1)
    lower = np.sort(e)[: max(1, int(len(e) * 0.60))]
    return float(np.median(lower))


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


def _psd_from_ring(
    ring: IqRing,
    n: int,
    fs: float,
    center_mhz: float,
    crop_factor: float | None = None,
    fft_n: int | None = None,
) -> list[dict[str, float]]:
    """Hann + Welch-8 + overlap 0.5. crop по умолчанию soapy 0.5; Атака передаёт свой."""
    if not NUMPY:
        raise RuntimeError("нужен numpy для FFT эфира (pip install numpy)")
    size = int(fft_n) if fft_n and fft_n > 0 else _pick_fft_size(n)
    crop = CROP_FACTOR if crop_factor is None else float(crop_factor)
    hop = welch_hop_samples(size)
    need = welch_need_samples(size)
    extra = ring.available() - need
    if extra > 0:
        ring.drop_oldest(extra)
    block = ring.pop_batch(need)
    if block is None:
        raise RuntimeError("кольцо RX: нет полного кадра FFT")
    frames = np.zeros((WELCH_FRAMES, size), dtype=np.complex64)
    for i in range(WELCH_FRAMES):
        a = i * hop
        frames[i] = block[a : a + size]
    db = welch_dbm(frames)
    # display.cpp: freq[k] = (center − fs/2) + k * (fs / N). Crop — после оси.
    span = fs / 1e6
    freqs = (center_mhz - span / 2.0) + np.arange(size, dtype=np.float64) * (span / size)
    raw = [{"freqMhz": float(f), "powerDbm": float(p)} for f, p in zip(freqs, db)]
    return crop_psd_bins(raw, crop)


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
            # readline без таймаута вис бы вечно при мёртвом шлюзе, а Rust
            # убивает воркер на 15 с. 12 с: больше 10-с AIR_PREP шлюза (полный
            # ad9361_init на NIOS при первом подъёме), меньше убийства.
            s.settimeout(12.0)
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
        "reason": "SoapySDR ок" if SOAPY else soapy_missing_reason(),
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
            str(msg.get("requireHw") or ""),
        )
    if op == "scan":
        return radio.scan(float(msg["centerMhz"]), float(msg["bwMhz"]), int(msg.get("bins") or 64))
    if op == "attack_scan":
        return radio.attack_scan(
            float(msg["centerMhz"]),
            float(msg.get("fsHz") or ATTACK_LISTEN_FS_HZ),
            float(msg.get("bwMhz") or (ATTACK_LISTEN_BW_HZ / 1e6)),
            int(msg.get("bins") or ATTACK_FFT_N),
            float(msg["cropFactor"]) if msg.get("cropFactor") is not None else attack_crop_factor(
                float(msg.get("fsHz") or ATTACK_LISTEN_FS_HZ),
                float(msg.get("bwMhz") or (ATTACK_LISTEN_BW_HZ / 1e6)) * 1e6,
            ),
        )
    if op == "park":
        return radio.park(
            float(msg["centerMhz"]),
            float(msg.get("bwMhz") or 2),
            float(msg.get("fsHz") or FPGA_PARK_FS_HZ),
            bool(msg.get("rx", True)),
            bool(msg.get("tx", True)),
        )
    if op == "det_capture":
        return radio.det_capture(int(msg.get("win") or 16), int(msg.get("windows") or 512))
    if op == "tx":
        return radio.tx_cue(float(msg["freqMhz"]))
    if op == "tx_wave":
        params = msg.get("params")
        fs_raw = msg.get("fsHz", msg.get("fs_hz"))
        fs_hz = float(fs_raw) if fs_raw not in (None, "") else None
        return radio.tx_wave(
            float(msg["freqMhz"]),
            str(msg.get("wave") or ""),
            params if isinstance(params, dict) else {},
            fs_hz,
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
