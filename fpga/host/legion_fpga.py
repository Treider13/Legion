#!/usr/bin/env python3
"""LEGION FPGA — хост-сторона регистрового канала bladeRF 1 x40.

Формат пакета — байт-в-байт nios_pkt_8x32_pack() из
fpga_common/include/nios_pkt_8x32.h (Nuand): 16 байт, magic 'C',
target 0x80 (диапазон 0x80..0xFF официально зарезервирован Nuand за
пользовательскими расширениями). Соответствие проверяется тестом
fpga/test/test_legion_fpga.py против реального C-заголовка (gcc).

Транспорт: USB bulk на PERIPHERAL_EP (как nios_access.c в libbladeRF).
Реализация транспорта — в legion_gateway.py (pyusb на шлюзе).
"""
from __future__ import annotations

import time

NIOS_PKT_LEN = 16
NIOS_PKT_8x32_MAGIC = ord("C")
NIOS_PKT_8x32_FLAG_WRITE = 1 << 0
NIOS_PKT_8x32_FLAG_SUCCESS = 1 << 1

LEGION_TARGET = 0x80  # NIOS_PKT_8x32_TARGET_USR1 (зарезервирован Nuand)

# Регистровая карта — зеркало fpga/hdl/legion_pkg.vhd и fpga/nios/legion_cmds.h
REG_CTRL = 0x00
REG_NCO_FTW = 0x01
REG_DET_THR = 0x02
REG_DET_SHIFT = 0x03
REG_PLAYER_LEN = 0x04
REG_PLAYER_CTL = 0x05
REG_LB_SHIFT = 0x06
REG_WD_LIMIT = 0x07
REG_WD_KICK = 0x08

# Режимы MODE (CTRL bits 3:1)
MODE_PASS = 0x0
MODE_PLAYER = 0x1
MODE_NCO = 0x2
MODE_LB_GATED = 0x3
MODE_LB_ALWAYS = 0x4

CTRL_ARM = 1 << 0
CTRL_WD_EN = 1 << 4

# ---------------------------------------------------------------------------
# micro (bladeRF 2, AD9361): RFIC-команды по nios_pkt_16x64.
# Формат — зеркало fpga_common/include/nios_pkt_16x64.h (вендоренное дерево):
# 16 байт, magic 'E', target 0x01 (RFIC), addr = cmd | (ch << 8), data 64 бита.
# Команды/статус — fpga_common/include/bladerf2_common.h (bladerf_rfic_command).
# Каналы — libbladeRF.h: RX(ch)=(ch<<1), TX(ch)=(ch<<1)|1; 0xF = system-wide.
# ---------------------------------------------------------------------------
NIOS_PKT_16x64_MAGIC = ord("E")
NIOS_PKT_16x64_TARGET_RFIC = 0x01

RFIC_CMD_STATUS = 0x00
RFIC_CMD_INIT = 0x01
RFIC_CMD_ENABLE = 0x02
RFIC_CMD_SAMPLERATE = 0x03
RFIC_CMD_FREQUENCY = 0x04
RFIC_CMD_BANDWIDTH = 0x05

RFIC_INIT_ON = 1    # BLADERF_RFIC_INIT_STATE_ON
RFIC_INIT_STANDBY = 2  # BLADERF_RFIC_INIT_STATE_STANDBY

RFIC_CH_RX0 = 0x0
RFIC_CH_TX0 = 0x1
RFIC_CH_SYSTEM = 0xF  # 1111 = system-wide (nios_pkt_16x64.h)

# Статус-регистр RFIC (bladerf2_common.h)
RFIC_STATUS_INIT = 1 << 0        # 1 = initialized (state ON)
RFIC_STATUS_WQSUCCESS = 1 << 1   # последняя запись из очереди успешна
RFIC_STATUS_WQLEN_SHIFT = 8
RFIC_STATUS_WQLEN_MASK = 0xFF

# _rfic_fpga_spinwait (rfic_fpga.c Nuand): 30 попыток × 100 мкс.
RFIC_SPIN_TRIES = 30
RFIC_SPIN_DELAY_S = 100e-6


def board_name_for_pid(pid: int) -> str:
    """bladeRF USB PID (firmware_common/bladeRF.h): 0x5246 = bladeRF 1,
    0x5250 = bladeRF 2 micro. Класс RFIC по плате: LMS6002D vs AD9361."""
    if pid == 0x5246:
        return "bladerf1"
    if pid == 0x5250:
        return "bladerf2"
    return "unknown"


def pack_16x64(target: int, write: bool, addr: int, data: int) -> bytes:
    """Зеркало nios_pkt_16x64_pack() из nios_pkt_16x64.h (Nuand)."""
    buf = bytearray(NIOS_PKT_LEN)
    buf[0] = NIOS_PKT_16x64_MAGIC
    buf[1] = target & 0xFF
    buf[2] = NIOS_PKT_8x32_FLAG_WRITE if write else 0x00
    buf[3] = 0x00
    buf[4] = addr & 0xFF
    buf[5] = (addr >> 8) & 0xFF
    for i in range(8):
        buf[6 + i] = (data >> (8 * i)) & 0xFF
    # buf[14..15] = 0 (RESV2)
    return bytes(buf)


def unpack_16x64_resp(buf: bytes) -> tuple[bool, int]:
    """Зеркало nios_pkt_16x64_resp_unpack(): (success, data64)."""
    if len(buf) != NIOS_PKT_LEN:
        return False, 0
    if buf[0] != NIOS_PKT_16x64_MAGIC:
        return False, 0
    success = bool(buf[2] & NIOS_PKT_8x32_FLAG_SUCCESS)
    data = 0
    for i in range(8):
        data |= buf[6 + i] << (8 * i)
    return success, data


def pack_8x32(target: int, write: bool, addr: int, data: int) -> bytes:
    """Зеркало nios_pkt_8x32_pack() из nios_pkt_8x32.h (Nuand)."""
    buf = bytearray(NIOS_PKT_LEN)
    buf[0] = NIOS_PKT_8x32_MAGIC
    buf[1] = target & 0xFF
    buf[2] = NIOS_PKT_8x32_FLAG_WRITE if write else 0x00
    buf[3] = 0x00
    buf[4] = addr & 0xFF
    buf[5] = data & 0xFF
    buf[6] = (data >> 8) & 0xFF
    buf[7] = (data >> 16) & 0xFF
    buf[8] = (data >> 24) & 0xFF
    # buf[9..15] = 0 (RESV2)
    return bytes(buf)


def unpack_8x32_resp(buf: bytes) -> tuple[bool, int]:
    """Зеркало nios_pkt_8x32_resp_unpack(): (success, data)."""
    if len(buf) != NIOS_PKT_LEN:
        return False, 0
    if buf[0] != NIOS_PKT_8x32_MAGIC:
        return False, 0
    success = bool(buf[2] & NIOS_PKT_8x32_FLAG_SUCCESS)
    data = buf[5] | (buf[6] << 8) | (buf[7] << 16) | (buf[8] << 24)
    return success, data


class LegionFpga:
    """Регистровый API поверх транспорта (transport.xfer(bytes)->bytes)."""

    def __init__(self, transport):
        self._t = transport

    def write_reg(self, addr: int, data: int) -> bool:
        ok, _ = unpack_8x32_resp(self._t.xfer(pack_8x32(LEGION_TARGET, True, addr, data)))
        return ok

    def read_status(self) -> dict:
        ok, data = unpack_8x32_resp(self._t.xfer(pack_8x32(LEGION_TARGET, False, 0, 0)))
        if not ok:
            return {"ok": False}
        return {
            "ok": True,
            "playing": bool(data & (1 << 0)),
            "capture_done": bool(data & (1 << 1)),
            "det_active": bool(data & (1 << 2)),
            "wd_fired": bool(data & (1 << 3)),
            "lb_level": (data >> 8) & 0xFF,
            "det_count": (data >> 16) & 0xFFFF,
        }

    # ---- высокоуровневые команды ----

    def arm(self, mode: int, wd_en: bool = True) -> bool:
        ctrl = CTRL_ARM | ((mode & 0x7) << 1) | (CTRL_WD_EN if wd_en else 0)
        return self.write_reg(REG_CTRL, ctrl)

    def disarm(self) -> bool:
        return self.write_reg(REG_CTRL, 0)

    def set_nco_freq(self, freq_hz: float, fs_hz: float = 2.0e6) -> bool:
        ftw = int(round(freq_hz / fs_hz * (1 << 32))) & 0xFFFFFFFF
        return self.write_reg(REG_NCO_FTW, ftw)

    def set_detector(self, threshold: int, win_shift: int = 8) -> bool:
        return self.write_reg(REG_DET_THR, threshold & 0xFFFFFFFF) and \
            self.write_reg(REG_DET_SHIFT, win_shift & 0xF)

    def set_player_len(self, n_samples: int) -> bool:
        return self.write_reg(REG_PLAYER_LEN, (n_samples - 1) & 0xFFF)

    def capture_arm(self, on: bool = True) -> bool:
        return self.write_reg(REG_PLAYER_CTL, 1 if on else 0)

    def set_loopback_shift(self, shift: int) -> bool:
        return self.write_reg(REG_LB_SHIFT, shift & 0xF)

    def set_watchdog(self, limit: int) -> bool:
        return self.write_reg(REG_WD_LIMIT, limit & 0xFFFF)

    def heartbeat(self) -> bool:
        return self.write_reg(REG_WD_KICK, 1)

    # ---- RFIC (AD9361 на micro): nios_pkt_16x64, target RFIC ----
    # Семантика — rfic_fpga.c Nuand: запись ставится в очередь NIOS,
    # хост ждёт осушения очереди по STATUS (spinwait 30 × 100 мкс).

    def rfic_read(self, cmd: int, ch: int = RFIC_CH_SYSTEM) -> tuple[bool, int]:
        addr = (cmd & 0xFF) | ((ch & 0xF) << 8)
        return unpack_16x64_resp(
            self._t.xfer(pack_16x64(NIOS_PKT_16x64_TARGET_RFIC, False, addr, 0)))

    def rfic_write(self, cmd: int, ch: int, data: int) -> bool:
        addr = (cmd & 0xFF) | ((ch & 0xF) << 8)
        ok, _ = unpack_16x64_resp(
            self._t.xfer(pack_16x64(NIOS_PKT_16x64_TARGET_RFIC, True, addr, data)))
        return ok

    def rfic_status(self) -> tuple[bool, int]:
        return self.rfic_read(RFIC_CMD_STATUS)

    def rfic_spinwait(self) -> bool:
        """Ждать осушения очереди записи RFIC (биты 15:8 STATUS).
        После осушения проверяем бит WQSUCCESS — последняя команда удалась."""
        for _ in range(RFIC_SPIN_TRIES):
            ok, st = self.rfic_status()
            if not ok:
                return False
            if ((st >> RFIC_STATUS_WQLEN_SHIFT) & RFIC_STATUS_WQLEN_MASK) == 0:
                return bool(st & RFIC_STATUS_WQSUCCESS)
            time.sleep(RFIC_SPIN_DELAY_S)
        return False

    def rfic_cmd(self, cmd: int, ch: int, data: int) -> bool:
        """Запись RFIC-команды + spinwait (как _rfic_cmd_write в rfic_fpga.c)."""
        return self.rfic_write(cmd, ch, data) and self.rfic_spinwait()

    def rfic_is_initialized(self) -> bool | None:
        """STATUS bit0: RFIC в состоянии ON. None — шина не ответила."""
        ok, st = self.rfic_status()
        if not ok:
            return None
        return bool(st & RFIC_STATUS_INIT)

    def rfic_initialize(self) -> bool:
        """INIT=ON. Из STANDBY частота/rate сохраняются (devices_rfic_cmds.c:
        пер-настройка только из состояния OFF), из OFF — полный init с
        дефолтной частотой (тогда park надо повторить — ловим readback)."""
        return self.rfic_cmd(RFIC_CMD_INIT, RFIC_CH_SYSTEM, RFIC_INIT_ON)

    def rfic_standby(self) -> bool:
        return self.rfic_cmd(RFIC_CMD_INIT, RFIC_CH_SYSTEM, RFIC_INIT_STANDBY)

    def rfic_enable_channel(self, ch: int, on: bool) -> bool:
        return self.rfic_cmd(RFIC_CMD_ENABLE, ch, 1 if on else 0)

    def rfic_frequency_hz(self, ch: int) -> int | None:
        """Readback LO канала (RFIC_CMD_FREQUENCY, Гц). None — нет ответа."""
        ok, data = self.rfic_read(RFIC_CMD_FREQUENCY, ch)
        return data if ok else None
