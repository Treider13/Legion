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
BLADERF_META_FLAG_TX_BURST_START = 1 << 0
BLADERF_META_FLAG_TX_BURST_END = 1 << 1
BLADERF_META_FLAG_TX_NOW = 1 << 2
BLADERF_TX = 1
NIOS_SLOTS = 256
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
_LIB.bladerf_sync_tx.argtypes = [
    c_void_p, c_void_p, c_uint, c_void_p, c_uint]
_LIB.bladerf_sync_tx.restype = c_int
_LIB.bladerf_get_timestamp.argtypes = [c_void_p, c_int, POINTER(c_uint64)]
_LIB.bladerf_get_timestamp.restype = c_int
_LIB.bladerf_cancel_scheduled_retunes.argtypes = [c_void_p, c_int]
_LIB.bladerf_cancel_scheduled_retunes.restype = c_int
BLADERF_RETUNE_NOW = 0


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
        self.digital_tunes: dict[int, _QuickTune] = {}
        self.last_bw = 0

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
                  lna_db: int = 20, tx_only: bool = False) -> int:
        """Частота и полоса. tx_only — цифровой режим: RX не поднимаем."""
        actual = c_uint()
        chans = (CH_TX,) if tx_only else (CH_RX, CH_TX)
        # sample_rate сбрасывает analog LPF — bandwidth только после него и после LO.
        for ch in chans:
            rc = _LIB.bladerf_set_sample_rate(
                self.dev, ch, c_uint(int(fs_hz)), ctypes.byref(actual))
            if rc != 0:
                return int(rc)
            rc = _LIB.bladerf_set_frequency(self.dev, ch, c_uint64(int(lo_hz)))
            if rc != 0:
                return int(rc)
            rc = _LIB.bladerf_set_bandwidth(
                self.dev, ch, c_uint(int(bw_hz)), ctypes.byref(actual))
            if rc != 0:
                return int(rc)
            self.last_bw = int(actual.value)
        if tx_only:
            return 0
        return int(_LIB.bladerf_set_gain(self.dev, CH_RX, c_int(int(lna_db))))

    def set_frequency(self, lo_hz: int) -> int:
        """Только LO приёма. set_sample_rate на живом потоке срывает окно."""
        return int(_LIB.bladerf_set_frequency(self.dev, CH_RX, c_uint64(int(lo_hz))))

    def set_tx_frequency(self, lo_hz: int) -> int:
        """LO передачи. На xA4 он отдельный от приёма."""
        return self._set_frequency(CH_TX, int(lo_hz))

    def enable_rx(self, on: bool = True) -> int:
        return int(_LIB.bladerf_enable_module(self.dev, CH_RX, on))

    def enable_tx(self, on: bool = True) -> int:
        return int(_LIB.bladerf_enable_module(self.dev, CH_TX, on))

    def set_bandwidth(self, ch: int, hz: int) -> int:
        actual = c_uint()
        rc = int(_LIB.bladerf_set_bandwidth(
            self.dev, int(ch), c_uint(int(hz)), ctypes.byref(actual)))
        if rc == 0:
            self.last_bw = int(actual.value)
        return rc

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

    def capture_one(self, key: int, lo_hz: int) -> int:
        """Снимок только TX. Ключ 0..255, не лимит 8 слотов кристалла.

        capture_pair не трогает. Повтор того же nios_profile — отказ.
        """
        key = int(key)
        if not 0 <= key < NIOS_SLOTS:
            return BLADERF_ERR_UNEXPECTED
        qt = _QuickTune()
        rc = self._set_frequency(CH_TX, lo_hz)
        if rc != 0:
            return rc
        rc = int(_LIB.bladerf_get_quick_tune(
            self.dev, CH_TX, ctypes.byref(qt)))
        if rc != 0:
            return rc
        for other, prev in self.digital_tunes.items():
            if other == key:
                continue
            if int(prev.nios_profile) == int(qt.nios_profile):
                return BLADERF_ERR_UNEXPECTED
        self.digital_tunes[key] = qt
        return 0

    def schedule_one(self, key: int, lo_hz: int, timestamp: int) -> int:
        """Только TX. Одно место очереди. NULL quick_tune на xA4 не передаём."""
        ts = c_uint64(int(timestamp))
        freq = c_uint64(int(lo_hz))
        self.last_fallback = False
        qt = self.digital_tunes.get(int(key))
        if qt is None:
            self.last_fallback = True
            return self._set_frequency(CH_TX, lo_hz)
        rc = int(_LIB.bladerf_schedule_retune(
            self.dev, CH_TX, ts, freq, ctypes.byref(qt)))
        self.last_rc = rc
        return rc

    def cancel_one(self) -> int:
        """Снять очередь TX. RX умной атаки не трогает."""
        return int(_LIB.bladerf_cancel_scheduled_retunes(self.dev, CH_TX))

    def get_timestamp(self, direction: int = BLADERF_TX) -> tuple[int, int]:
        ts = c_uint64(0)
        rc = int(_LIB.bladerf_get_timestamp(
            self.dev, c_int(int(direction)), ctypes.byref(ts)))
        return rc, int(ts.value)

    def arm_tx_meta_stream(self) -> int:
        """TX SC16_Q11_META. Нужен schedule_retune. RX-поток умной атаки не меняет."""
        return int(_LIB.bladerf_sync_config(
            self.dev, LAYOUT_TX_X1, FORMAT_SC16_Q11_META,
            32, 8192, 16, 1000))

    def write_sc16_tx(self, raw: bytes, timeout_ms: int = 1000,
                      start: bool = False, end: bool = False) -> int:
        """Первый кусок — старт пачки. Дальше без TX_NOW, чтобы метка росла."""
        n = len(raw) // 4
        if n <= 0:
            return BLADERF_ERR_UNEXPECTED
        buf = (ctypes.c_int16 * (n * 2)).from_buffer_copy(raw)
        meta = _Meta()
        if start:
            meta.flags = BLADERF_META_FLAG_TX_BURST_START | BLADERF_META_FLAG_TX_NOW
        elif end:
            meta.flags = BLADERF_META_FLAG_TX_BURST_END
        return int(_LIB.bladerf_sync_tx(
            self.dev, ctypes.cast(buf, c_void_p), c_uint(n),
            ctypes.byref(meta), c_uint(int(timeout_ms))))
