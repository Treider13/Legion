"""Владелец USB на время удара — libbladeRF, не bladeRF-cli.

Поток SC16_Q11_META, иначе schedule_retune отвергается.
quick_tune на bladeRF 2.0 micro не NULL.
Пара RX+TX ставится на одну метку и занимает два места очереди (16).
"""
from __future__ import annotations

import ctypes
from ctypes import c_int, c_uint, c_uint64, c_void_p, POINTER

_LIB = ctypes.CDLL("libbladeRF.so.2")

FORMAT_SC16_Q11 = 0
FORMAT_SC16_Q11_META = 1
LAYOUT_RX_X1 = 0
LAYOUT_TX_X1 = 1
CH_RX = 0
CH_TX = 1
QUEUE_SLOTS = 16
MAX_PAIRS = 8
# libbladeRF.h: принять «сейчас», не ждать метку 0 (она уже в прошлом → -14).
BLADERF_META_FLAG_RX_NOW = 1 << 31
# Коды libbladeRF.h. Отдельного кода «PLL» в API нет.
BLADERF_ERR_UNEXPECTED = -1
BLADERF_ERR_IO = -5
BLADERF_ERR_TIMEOUT = -6
BLADERF_ERR_NODEV = -7
BLADERF_ERR_TIME_PAST = -14
BLADERF_ERR_QUEUE_FULL = -15
BLADERF_ERR_FPGA_OP = -16
USB_FAULT = (BLADERF_ERR_IO, BLADERF_ERR_TIMEOUT, BLADERF_ERR_NODEV)


class _QuickTune(ctypes.Structure):
    _fields_ = [
        ("nios_profile", ctypes.c_uint16),
        ("rffe_profile", ctypes.c_uint8),
        ("port", ctypes.c_uint8),
        ("spdt", ctypes.c_uint8),
        ("_pad", ctypes.c_uint8 * 11),
    ]


_LIB.bladerf_open.argtypes = [POINTER(c_void_p), ctypes.c_char_p]
_LIB.bladerf_open.restype = c_int
_LIB.bladerf_close.argtypes = [c_void_p]
_LIB.bladerf_close.restype = None
_LIB.bladerf_set_frequency.argtypes = [c_void_p, c_int, c_uint64]
_LIB.bladerf_set_frequency.restype = c_int
_LIB.bladerf_get_quick_tune.argtypes = [c_void_p, c_int, POINTER(_QuickTune)]
_LIB.bladerf_get_quick_tune.restype = c_int
_LIB.bladerf_schedule_retune.argtypes = [
    c_void_p, c_int, c_uint64, c_uint64, POINTER(_QuickTune)]
_LIB.bladerf_schedule_retune.restype = c_int
_LIB.bladerf_sync_config.argtypes = [
    c_void_p, c_int, c_int, c_uint, c_uint, c_uint, c_uint]
_LIB.bladerf_sync_config.restype = c_int
_LIB.bladerf_enable_module.argtypes = [c_void_p, c_int, ctypes.c_bool]
_LIB.bladerf_enable_module.restype = c_int
_LIB.bladerf_set_sample_rate.argtypes = [
    c_void_p, c_int, c_uint, POINTER(c_uint)]
_LIB.bladerf_set_sample_rate.restype = c_int
_LIB.bladerf_set_bandwidth.argtypes = [
    c_void_p, c_int, c_uint, POINTER(c_uint)]
_LIB.bladerf_set_bandwidth.restype = c_int
_LIB.bladerf_set_gain.argtypes = [c_void_p, c_int, c_int]
_LIB.bladerf_set_gain.restype = c_int
_LIB.bladerf_sync_rx.argtypes = [
    c_void_p, c_void_p, c_uint, c_void_p, c_uint]
_LIB.bladerf_sync_rx.restype = c_int


class _Meta(ctypes.Structure):
    """Метка FPGA: счётчик растёт с частотой дискретизации канала."""
    _fields_ = [
        ("timestamp", ctypes.c_uint64),
        ("flags", ctypes.c_uint32),
        ("status", ctypes.c_uint32),
        ("actual_count", ctypes.c_uint),
        ("reserved", ctypes.c_uint8 * 32),
    ]


class UsbOwner:
    """Один процесс держит плату. Консоль в это время устройство не открывает."""

    def __init__(self) -> None:
        self.dev = c_void_p()
        self.open = False
        self.tunes: dict[tuple[int, int], _QuickTune] = {}
        self.last_timestamp = 0
        self.last_status = 0
        self.overruns = 0
        self.last_rc = 0
        self.last_fallback = False
        self.tune_fails = 0

    def acquire(self, ident: str = "") -> int:
        rc = _LIB.bladerf_open(ctypes.byref(self.dev), ident.encode() or None)
        self.open = rc == 0
        return int(rc)

    def release(self) -> None:
        if self.open:
            _LIB.bladerf_close(self.dev)
        self.open = False
        self.dev = c_void_p()

    def configure(self, lo_hz: int, fs_hz: int, bw_hz: int,
                  lna_db: int = 20) -> int:
        """Частота, полоса и LNA на уже открытой плате. Консоль к этому моменту закрыта."""
        actual = c_uint()
        for ch in (CH_RX, CH_TX):
            rc = _LIB.bladerf_set_sample_rate(
                self.dev, ch, c_uint(int(fs_hz)), ctypes.byref(actual))
            if rc != 0:
                return int(rc)
            rc = _LIB.bladerf_set_bandwidth(
                self.dev, ch, c_uint(int(bw_hz)), ctypes.byref(actual))
            if rc != 0:
                return int(rc)
            rc = _LIB.bladerf_set_frequency(self.dev, ch, c_uint64(int(lo_hz)))
            if rc != 0:
                return int(rc)
        return int(_LIB.bladerf_set_gain(self.dev, CH_RX, c_int(int(lna_db))))

    def set_frequency(self, lo_hz: int) -> int:
        """Только LO. set_sample_rate на живом потоке срывает окно."""
        return int(_LIB.bladerf_set_frequency(self.dev, CH_RX, c_uint64(int(lo_hz))))

    def enable_rx(self, on: bool = True) -> int:
        return int(_LIB.bladerf_enable_module(self.dev, CH_RX, on))

    def read_sc16(self, n_samples: int, timeout_ms: int = 1000):
        """SC16_Q11_META. Буфер — голые IQ, метка в metadata.timestamp."""
        meta = _Meta()
        meta.flags = BLADERF_META_FLAG_RX_NOW
        buf = (ctypes.c_int16 * (int(n_samples) * 2))()
        rc = _LIB.bladerf_sync_rx(
            self.dev, ctypes.cast(buf, c_void_p), c_uint(int(n_samples)),
            ctypes.byref(meta), c_uint(int(timeout_ms)))
        self.last_timestamp = int(meta.timestamp)
        self.last_status = int(meta.status)
        if self.last_status & 1:
            self.overruns += 1
        return int(rc), buf, int(meta.timestamp), int(meta.actual_count)

    def read_frame_bytes(self, n_samples: int, timeout_ms: int = 1000):
        """Ровно один кадр SC16, либо пусто. Метка — timestamp первого сэмпла."""
        rc, buf, ts, n = self.read_sc16(n_samples, timeout_ms)
        count = int(n)
        if rc != 0 or count <= 0:
            return int(rc), b"", ts
        return 0, ctypes.string_at(buf, count * 4), ts

    def arm_meta_stream(self) -> int:
        """Оба направления SC16 без META. На этом образе META-RX даёт 508
        сэмплов и overrun, анализатор не видит кадр."""
        rc = 0
        for layout in (LAYOUT_RX_X1, LAYOUT_TX_X1):
            rc = _LIB.bladerf_sync_config(
                self.dev, layout, FORMAT_SC16_Q11,
                16, 8192, 8, 1000)
            if rc != 0:
                return int(rc)
        return 0

    def _set_frequency(self, ch: int, lo_hz: int, tries: int = 3) -> int:
        """Три попытки. В libbladeRF нет отдельного кода отказа PLL."""
        last = 0
        for _ in range(max(1, tries)):
            last = int(_LIB.bladerf_set_frequency(
                self.dev, ch, c_uint64(int(lo_hz))))
            self.last_rc = last
            if last == 0:
                self.tune_fails = 0
                return 0
            self.tune_fails += 1
        return last

    def capture_pair(self, slot: int, lo_hz: int) -> int:
        """Снимок пары. get_quick_tune на xA4 сам кладёт профиль в NIOS.

        Публичного «сохрани в слот N» в libbladeRF нет (Nuand #1033, 2025).
        Номер профиля возвращается в nios_profile. Повтор того же номера
        на другом слоте — это alias, не восемь профилей.
        """
        slot = int(slot)
        if not 0 <= slot < MAX_PAIRS:
            return BLADERF_ERR_UNEXPECTED
        qt_rx, qt_tx = _QuickTune(), _QuickTune()
        rc = self._set_frequency(CH_RX, lo_hz)
        if rc != 0:
            return rc
        rc = self._set_frequency(CH_TX, lo_hz)
        if rc != 0:
            return rc
        rc = int(_LIB.bladerf_get_quick_tune(
            self.dev, CH_RX, ctypes.byref(qt_rx)))
        if rc != 0:
            return rc
        rc = int(_LIB.bladerf_get_quick_tune(
            self.dev, CH_TX, ctypes.byref(qt_tx)))
        if rc != 0:
            return rc
        for (other, ch), prev in self.tunes.items():
            if other == slot:
                continue
            got = qt_rx if ch == CH_RX else qt_tx
            if int(prev.nios_profile) == int(got.nios_profile):
                return BLADERF_ERR_UNEXPECTED
        self.tunes[(slot, CH_RX)] = qt_rx
        self.tunes[(slot, CH_TX)] = qt_tx
        return 0

    def schedule_pair(self, slot: int, lo_hz: int, timestamp: int) -> int:
        """Оба профиля на одну метку. NULL quick_tune на xA4 не передаём.

        Нет снимка — полный set_frequency сразу, не в метку.
        BLADERF_ERR_QUEUE_FULL (−15) возвращается вызывающему.
        """
        ts = c_uint64(int(timestamp))
        freq = c_uint64(int(lo_hz))
        self.last_fallback = False
        missing = any(self.tunes.get((int(slot), ch)) is None
                      for ch in (CH_RX, CH_TX))
        if missing:
            self.last_fallback = True
            for ch in (CH_RX, CH_TX):
                rc = self._set_frequency(ch, lo_hz)
                if rc != 0:
                    return rc
            return 0
        for ch in (CH_RX, CH_TX):
            qt = self.tunes[(int(slot), ch)]
            rc = int(_LIB.bladerf_schedule_retune(
                self.dev, ch, ts, freq, ctypes.byref(qt)))
            self.last_rc = rc
            if rc != 0:
                return rc
        return 0
