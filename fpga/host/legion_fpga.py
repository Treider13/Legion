#!/usr/bin/env python3
"""LEGION FPGA — хост-сторона регистрового канала bladeRF 1 x40 и
bladeRF 2.0 micro xA4/xA9.

Формат пакета — байт-в-байт nios_pkt_8x32_pack() из
fpga_common/include/nios_pkt_8x32.h (Nuand): 16 байт, magic 'C',
target 0x80 (диапазон 0x80..0xFF официально зарезервирован Nuand за
пользовательскими расширениями). Соответствие проверяется тестом
fpga/test/test_legion_fpga.py против реального C-заголовка (gcc).

Транспорт: USB bulk на PERIPHERAL_EP (как nios_access.c в libbladeRF).
Реализация транспорта — в legion_gateway.py (pyusb на шлюзе).

Эфирные регистры AIR_* (micro/AD9361): живут только в NIOS
(legion_cmds.c) — частота/усиление парковки и подъём тракта через
rfic_command_write_immed (Nuand FPGA-tuning интерфейс). На bladeRF 1
эфир поднимает шлюз через CONTROL bit1/2, AIR_* там no-op.
"""
from __future__ import annotations

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
# Эфир micro (AD9361) — только NIOS, HDL не декодирует (зеркало legion_pkg.vhd)
REG_AIR_FREQ_KHZ = 0x09
REG_AIR_GAIN_DB = 0x0A
REG_AIR_PREP = 0x0B  # bit0: 1=поднять тракт / 0=standby; bit1: RX; bit2: TX
REG_AIR_FS_HZ = 0x0C  # sample rate эфира/solo, Гц; 0 = 2 МГц (NIOS)
REG_AIR_BW_HZ = 0x0D  # analog BW эфира/solo, Гц; 0 = 2 МГц (NIOS)

# Режимы MODE (CTRL bits 3:1)
MODE_PASS = 0x0
MODE_PLAYER = 0x1
MODE_NCO = 0x2
MODE_LB_GATED = 0x3
MODE_LB_ALWAYS = 0x4

CTRL_ARM = 1 << 0
CTRL_WD_EN = 1 << 4

# VHDL: timeout = limit × 2^16 тактов tx_clock. Дефолт 0x3D=61 ≈ 1 с при
# tx_clock=4 МГц (x40 @ 2 MSPS). Kick хоста = 500 мс. На micro
# tx_clock = ad9361.clock = fs — при окне ≥8 МГц 61 тика < 500 мс.
WD_TICK = 65536
WD_LIMIT_DEFAULT = 61


def watchdog_limit_for_fs(fs_hz: int, board: str) -> int:
    """limit, чтобы limit×65536/tx_clock ≈ 1 с. Clamp 1..65535."""
    fs = int(fs_hz) if fs_hz else 2_000_000
    tx_clk = fs if board == "bladerf2" else fs * 2
    if tx_clk <= 0:
        return WD_LIMIT_DEFAULT
    return max(1, min(0xFFFF, int(round(tx_clk / WD_TICK))))


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

    def write_reg(self, addr: int, data: int, timeout_ms: int | None = None) -> bool:
        req = pack_8x32(LEGION_TARGET, True, addr, data)
        if timeout_ms is None:
            ok, _ = unpack_8x32_resp(self._t.xfer(req))
        else:
            ok, _ = unpack_8x32_resp(self._t.xfer(req, timeout_ms))
        return ok

    def read_reg(self, addr: int) -> tuple[bool, int]:
        """Чтение регистра (status — addr 0; AIR_PREP — состояние эфира NIOS)."""
        return unpack_8x32_resp(self._t.xfer(pack_8x32(LEGION_TARGET, False, addr, 0)))

    def read_status(self) -> dict:
        ok, data = self.read_reg(0)
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

    # ---- Эфир micro (AD9361): параметры парковки + подъём тракта в NIOS ----

    def set_air_freq_mhz(self, freq_mhz: float) -> bool:
        """LO парковки в кГц (32 бита: 47 МГц..6 ГГц влезают с запасом)."""
        khz = int(round(freq_mhz * 1000.0))
        if khz <= 0:
            return False
        return self.write_reg(REG_AIR_FREQ_KHZ, khz & 0xFFFFFFFF)

    def set_air_gain_db(self, gain_db: int) -> bool:
        """Ручной RX gain, дБ — ровно тот, при котором хост мерил полку.
        Код = gain + 1000 (смещение): сентинел «не задан» в NIOS = 0xFFFFFFFF,
        а легальные 0/−1 дБ не должны с ним сталкиваться."""
        return self.write_reg(REG_AIR_GAIN_DB, (int(gain_db) + 1000) & 0xFFFFFFFF)

    def set_air_fs_hz(self, fs_hz: int) -> bool:
        """Sample rate AD9361, Гц. 0 = дефолт NIOS 2 МГц (эфир lb_gated)."""
        return self.write_reg(REG_AIR_FS_HZ, int(fs_hz) & 0xFFFFFFFF)

    def set_air_bw_hz(self, bw_hz: int) -> bool:
        """Analog BW AD9361, Гц. 0 = дефолт NIOS 2 МГц."""
        return self.write_reg(REG_AIR_BW_HZ, int(bw_hz) & 0xFFFFFFFF)

    def air_prepare(self, up: bool, rx: bool, tx: bool) -> bool:
        """Подъём/стендбай воздушного тракта на micro. На x40 — no-op true.

        Первый подъём после подачи питания — полный ad9361_init на NIOS
        (сотни мс): длинный таймаут, ответ придёт по готовности.
        """
        data = (1 if up else 0) | (0x2 if rx else 0) | (0x4 if tx else 0)
        return self.write_reg(REG_AIR_PREP, data, timeout_ms=10_000)
