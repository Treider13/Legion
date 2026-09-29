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
# Онбордовый обзор коридора — только NIOS (HDL не декодирует)
REG_SCAN_F1_KHZ = 0x0E
REG_SCAN_F2_KHZ = 0x0F
REG_SCAN_CTRL = 0x10  # bit0 enable, bit1 turn, bit2 park, bit3 survey
REG_SCAN_DWELL_US = 0x11  # выдержка на сигнал внутри окна, мкс
REG_SEARCH_BW_HZ = 0x12  # analog BW обзора, Гц; 0 = AIR_BW
REG_FIRE_BW_HZ = 0x13  # leftover; вырез цифровой, analog не узжаем
REG_PEAK_KHZ = 0x14  # найденная частота, кГц (считает NIOS)
REG_PEAK_BIN = 0x15  # слово пика HDL: bin/mag/frame/valid
REG_FFT_CTRL = 0x16  # bit0 enable, bit1 dc_notch, bit2 lock, bit3 xlat bypass
REG_BAND_IDX = 0x17
REG_BAND_F1_KHZ = 0x18
REG_BAND_F2_KHZ = 0x19
REG_BAND_COUNT = 0x1A  # 0 = один коридор SCAN_F1/F2
REG_SETTLE_N = 0x1B  # сэмплы после hop; 0 = 4096
REG_SCAN_EVENT = 0x1D  # [7:0] код, [31:8] seq
REG_AIR_TX_GAIN_DB = 0x1E  # ручной TX gain, дБ; код = gain+1000; только NIOS
REG_DELAY = 0x1F  # начальная задержка, сэмплы
REG_WALK_STEP = 0x20
REG_WALK_MAX = 0x21
REG_WALK_CTL = 0x22  # bit0 EN, bit1 AUTO, bit2 HOLD
REG_WALK_CUR = 0x23  # STATUS mux: текущая задержка
REG_LB_DELAY = 0x24  # tap0, сэмплы; 0 = без отвода
REG_LB_FTW = 0x25  # tap0 смеситель; 0 = обход
REG_LB_DELAY1 = 0x26  # tap1
REG_LB_FTW1 = 0x27
REG_LB_AMP = 0x28  # [15:0] A0 Q15, [31:16] A1
REG_WALK_PERIOD = 0x29  # сэмплы между шагами; 0 = фронт det
REG_WALK_FTW_STEP = 0x2A  # прирост FTW0 за шаг
REG_CH_CTRL = 0x2B  # HDL [15:0]; NIOS preset [17:16]
REG_CH_IDX = 0x2C
REG_CH_PWR = 0x2D  # STATUS mux: слово канала
REG_PEAK1 = 0x2E
REG_PEAK2 = 0x2F
REG_PEAK3 = 0x30
REG_CH_LUT = 0x31  # write {idx[15:8], ch[7:0]}
REG_PROTO_PERIOD = 0x32  # период пакета, сэмплы
REG_PROTO_PULSE = 0x33  # длительность пакета, сэмплы
REG_DRFM_STEP_SRC = 0x34  # 0=WALK_PERIOD, 1=PROTO_PERIOD
REG_CH_THR = 0x35
REG_CH_HYST = 0x36
REG_CH_TARGET = 0x37
REG_CH_MODE = 0x38
REG_CH_ACTIVE_0 = 0x39
REG_CH_ACTIVE_1 = 0x3A
REG_CH_ACTIVE_2 = 0x3B
REG_CH_ACTIVE_3 = 0x3C
REG_CH_ENERGY_0 = 0x3D
REG_CH_ENERGY_1 = 0x3E
REG_CH_ENERGY_2 = 0x3F
REG_CH_ENERGY_3 = 0x40
REG_CH_ENERGY_4 = 0x41
REG_CH_ENERGY_5 = 0x42
REG_CH_ENERGY_6 = 0x43
REG_CH_ENERGY_7 = 0x44
REG_CH_HITS_0 = 0x45
REG_CH_HITS_1 = 0x46
REG_CH_HITS_2 = 0x47
REG_CH_HITS_3 = 0x48
REG_CH_HITS_4 = 0x49
REG_CH_HITS_5 = 0x4A
REG_CH_HITS_6 = 0x4B
REG_CH_HITS_7 = 0x4C
REG_CH_BINS_03 = 0x4D
REG_CH_BINS_47 = 0x4E
REG_CH_FS_HZ = 0x4F
REG_CH_LO_KHZ = 0x50
REG_GRID_META = 0x51
REG_GRID_F0_HZ = 0x52
REG_GRID_STEP_HZ = 0x53
REG_GRID_PRI_US = 0x54
REG_GRID_SHIFT_HZ = 0x55
REG_GRID_FLAGS = 0x56
REG_GRID_RSV = 0x57
REG_CH_PWR_THR = 0x58
REG_AIM_CH = 0x59
CH_MODE_OCUSYNC = 0
CH_MODE_ELRS = 1
AIM_NONE = 0xFF
CH_PWR_THR_DEFAULT = 0x40
CH_THR_SLOT_DEFAULT = 256
GRID_KIND_UNKNOWN = 0
GRID_KIND_FHSS = 1
GRID_KIND_OFDM = 2
GRID_KIND_ANALOG = 3
GRID_KIND_ZC = 4
GRID_KIND_CW = 5
GRID_SRC_NONE = 0
GRID_SRC_MATCHER = 1
GRID_SRC_PRESET = 2
GRID_SRC_OPERATOR = 3
GRID_FLAG_WINLIM = 1 << 0
GRID_FLAG_F0UNC = 1 << 1
GRID_FLAG_ZC = 1 << 2
GRID_FLAG_FCORR = 1 << 3
GRID_F0_KHZ_GATE = 10_000_000
C58_MHZ = 5100.0

# xA4 lab DRFM (не RFSoC 4×256 км): два отвода, mux потом ×0.9
LB_AMP_Q15_UNITY = 0x7FFF
LB_AMP_Q15_HALF = 16384
LB_DELAY1_DEFAULT = 64
WALK_PERIOD_DEFAULT = 4096
WALK_STEP_LIVE_DEFAULT = 1
WALK_MAX_LIVE_DEFAULT = 4095

WALK_CTL_EN = 1 << 0
WALK_CTL_AUTO = 1 << 1
WALK_CTL_HOLD = 1 << 2

SCAN_CTRL_EN = 1 << 0
SCAN_CTRL_TURN = 1 << 1
SCAN_CTRL_PARK = 1 << 2  # ИИ: 56 МГц на всплеск (с SURVEY не схлопывает плитку)
SCAN_CTRL_SURVEY = 1 << 3  # глухой обзор → окно → период → снова обзор
FFT_CTRL_EN = 1 << 0
FFT_CTRL_DC_NOTCH = 1 << 1
FFT_CTRL_LOCK = 1 << 2
FFT_CTRL_XLAT_BYPASS = 1 << 3  # xlat=passthrough; Gemini / два тона ≥ fs/16
CH_MAP_RAW = 0
CH_MAP_LUT = 1
CH_FFTSHIFT = 1 << 5
CH_DC_SKIP = 1 << 6
CH_N80 = 1 << 7
CH_PRESET_MANUAL = 0
CH_PRESET_ELRS = 1  # ExpressLRS FHSS.cpp ISM2G4 80×1 МГц
CH_PRESET_ISM8 = 2  # 2400–2480 / 8×10 МГц, не OcuSync
CH_PRESET_O4VID3 = 3  # DJI O4 20/10 МГц: 5768.5/5789.5/5814.5
FIRE_BW_DEFAULT_HZ = 2_000_000
SETTLE_N_DEFAULT = 4096
LO_SETTLE_S = 0.006  # AD9361/LMS hop; 4096 сэмплов мало на 56e6

# Режимы MODE (CTRL bits 3:1)
MODE_PASS = 0x0
MODE_PLAYER = 0x1
MODE_NCO = 0x2
MODE_LB_GATED = 0x3
MODE_LB_ALWAYS = 0x4
MODE_AIM = 0x5  # NCO по CH_TARGET

CTRL_ARM = 1 << 0
CTRL_WD_EN = 1 << 4

# VHDL: timeout = limit × 2^16 тактов tx_clock. Дефолт прошивки 0x3D=61 ≈ 1 с
# при tx_clock=4 МГц. Хост при ARM пишет ≈2 с: первый kick сразу, дальше
# каждые 500 мс. 2 с переживает один опоздавший пульс и короче сторожа
# шлюза (2.5 с).
# tx_clock на обеих платах = 2×fs:
#   x40 — c4_tx_clock, valid каждый 2-й такт (legion_nco.vhd).
#   micro — ad9361.clock = axi_ad9361 l_clk = rx_outclock SERDES.
#   Интерфейс LVDS 2R2T (ad936x_params.c, pins.tcl IO_STANDARD LVDS).
#   DATA_CLK = 4×fs (UG-570: 61.44 MSPS → 245.76 МГц; SDC стережёт
#   adi_rx_clock как 250 МГц). altlvds_rx: deserialization_factor=4, DDR,
#   rx_outclock = DATA_CLK/2. Nuand мерил DATA_CLK, не l_clk
#   (блог 2023.02: частота DATA_CLK подтвердила разгон выборки).
WD_TICK = 65536
WD_LIMIT_DEFAULT = 61
WD_TIMEOUT_S = 2.0


def pack_grid_f0(f0_hz: int) -> int:
    """5.8 ГГц не влезает в uint32 Hz → кГц (<10e6). 2.4 — Hz."""
    hz = int(f0_hz)
    if hz <= 0:
        return 0
    if hz > 0xFFFFFFFF:
        return int(round(hz / 1000.0)) & 0xFFFFFFFF
    return hz & 0xFFFFFFFF


def pack_grid_meta(n: int, n_used: int = 0, conf: int = 0,
                   source: int = 0, kind: int = 0) -> int:
    return ((int(n) & 0xFF) | ((int(n_used) & 0xFF) << 8) |
            ((int(conf) & 0xFF) << 16) | ((int(source) & 0xF) << 24) |
            ((int(kind) & 0xF) << 28)) & 0xFFFFFFFF


def settle_n_for_fs(fs_hz: int) -> int:
    """Сэмплы после hop LO: max(4096, round(fs × 6 мс))."""
    fs = int(fs_hz) if fs_hz else 2_000_000
    if fs <= 0:
        return SETTLE_N_DEFAULT
    return max(SETTLE_N_DEFAULT, int(round(fs * LO_SETTLE_S)))


def watchdog_limit_for_fs(fs_hz: int, board: str) -> int:
    """limit, чтобы limit×65536/tx_clock ≈ WD_TIMEOUT_S. Clamp 1..65535.

    board оставлен в сигнатуре: x40 и micro оба тикают на 2×fs
    (см. комментарий у WD_TIMEOUT_S). Неизвестный board не угадываем
    как fs — тот же 2×fs, иначе micro снова получит вдвое короткий сторож.
    """
    _ = board  # обе платы: tx_clock = 2×fs, см. шапку WD_TIMEOUT_S
    fs = int(fs_hz) if fs_hz else 2_000_000
    tx_clk = fs * 2
    if tx_clk <= 0:
        return WD_LIMIT_DEFAULT
    return max(1, min(0xFFFF, int(round(tx_clk * WD_TIMEOUT_S / WD_TICK))))


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
            # bit3 — HDL (живой expired), bit4 — липкий латч NIOS: после
            # автономного DISARM (legion_work) HDL-бит гаснет за мкс
            # (enable=0 сбрасывает expired), хост читает латч.
            "wd_fired": bool(data & 0x18),
            "walk_state": (data >> 5) & 0x7,
            "delaying": ((data >> 5) & 0x7) == 3,
            "lb_level": (data >> 8) & 0xFF,
            "det_count": (data >> 16) & 0xFFFF,
        }

    def set_scan_corridor(self, f1_mhz: float, f2_mhz: float,
                          enable: bool, turn: bool, dwell_us: int,
                          park: bool = False, survey: bool = False) -> bool:
        """Коридор онбордового обзора. enable=0 — walker молчит (эфир/solo).
        dwell_us — выдержка на сигнал внутри окна (0 → 3 с).
        park — ICE9 один LO / с survey — ИИ (плитка не схлопывается).
        survey — глухой проход, затем LO на пик. Биты OR, не взаимно исключены.
        turn при survey — обычный внутри окна; иначе приоритет."""
        f1 = int(round(float(f1_mhz) * 1000.0))
        f2 = int(round(float(f2_mhz) * 1000.0))
        if f1 <= 0 or f2 < f1:
            return False
        ctrl = ((SCAN_CTRL_EN if enable else 0) |
                (SCAN_CTRL_TURN if turn else 0) |
                (SCAN_CTRL_PARK if park else 0) |
                (SCAN_CTRL_SURVEY if survey else 0))
        dwell = max(0, int(dwell_us))
        return (self.write_reg(REG_SCAN_F1_KHZ, f1 & 0xFFFFFFFF) and
                self.write_reg(REG_SCAN_F2_KHZ, f2 & 0xFFFFFFFF) and
                self.write_reg(REG_SCAN_DWELL_US, dwell & 0xFFFFFFFF) and
                self.write_reg(REG_SCAN_CTRL, ctrl))

    def set_fft(self, enable: bool, dc_notch: bool = False,
                search_bw_hz: int = 0, fire_bw_hz: int = 0,
                settle_n: int = 0, xlat_bypass: bool = False) -> bool:
        """FFT-пик на FPGA. enable=0 — walker как раньше (центр взгляда).
        fire_bw_hz пишется в регистр (совместимость); NIOS analog не узжает.
        xlat_bypass — MA-16 обход (Gemini ~40 МГц, два тона ≥ fs/16)."""
        ctrl = ((FFT_CTRL_EN if enable else 0) |
                (FFT_CTRL_DC_NOTCH if dc_notch else 0) |
                (FFT_CTRL_XLAT_BYPASS if xlat_bypass else 0))
        return (self.write_reg(REG_SEARCH_BW_HZ, int(search_bw_hz) & 0xFFFFFFFF) and
                self.write_reg(REG_FIRE_BW_HZ, int(fire_bw_hz) & 0xFFFFFFFF) and
                self.write_reg(REG_SETTLE_N, int(settle_n) & 0xFFFFFFFF) and
                self.write_reg(REG_FFT_CTRL, ctrl))


    def set_channelize(self, preset: int = 0, map_lut: bool = False,
                       grp_shift: int = 0, fftshift: bool = False,
                       dc_skip: bool = False, n80: bool = False,
                       excl: int = 0, idx: int = 0) -> bool:
        """Occupancy после FFT. preset: 0 manual / 1 ELRS / 2 ISM-OCC-8 / 3 O4-VID-3.
        map [1:0] — значение, не бит: 0=raw, 1=lut. NIOS при preset≠0 сам
        пишет LUT (ELRS 80×1 МГц / 8×10 МГц / три центра DJI O4)."""
        ctrl = ((CH_MAP_LUT if map_lut else CH_MAP_RAW) |
                ((int(grp_shift) & 7) << 2) |
                (CH_FFTSHIFT if fftshift else 0) |
                (CH_DC_SKIP if dc_skip else 0) |
                (CH_N80 if n80 else 0) |
                ((int(excl) & 0xFF) << 8) |
                ((int(preset) & 3) << 16))
        return (self.write_reg(REG_CH_CTRL, ctrl & 0xFFFFFFFF) and
                self.write_reg(REG_CH_IDX, int(idx) & 0x7F))

    def write_ch_lut(self, bin_idx: int, ch: int) -> bool:
        """Один бин FFT → канал. ch=0xFF — не копить."""
        return self.write_reg(REG_CH_LUT,
                              ((int(bin_idx) & 0xFF) << 8) | (int(ch) & 0xFF))

    def set_band_table(self, bands: list[tuple[float, float]]) -> bool:
        """До 8 коридоров. Пусто / BAND_COUNT=0 — сетка от SCAN_F1/F2."""
        n = min(8, len(bands))
        if not self.write_reg(REG_BAND_COUNT, 0):
            return False
        for i, (f1_mhz, f2_mhz) in enumerate(bands[:n]):
            f1 = int(round(float(f1_mhz) * 1000.0))
            f2 = int(round(float(f2_mhz) * 1000.0))
            if f1 <= 0 or f2 < f1:
                return False
            if not (self.write_reg(REG_BAND_IDX, i) and
                    self.write_reg(REG_BAND_F1_KHZ, f1 & 0xFFFFFFFF) and
                    self.write_reg(REG_BAND_F2_KHZ, f2 & 0xFFFFFFFF)):
                return False
        return self.write_reg(REG_BAND_COUNT, n)

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

    def set_walkoff(self, delay: int = 0, step: int = 0, maximum: int = 0,
                    enable: bool = False, auto: bool = False,
                    hold: bool = False) -> bool:
        """Лабораторный walk-off: задержка (сэмплы) и наращивание после play."""
        ctl = ((WALK_CTL_EN if enable else 0) |
               (WALK_CTL_AUTO if auto else 0) |
               (WALK_CTL_HOLD if hold else 0))
        return (self.write_reg(REG_DELAY, int(delay) & 0xFFFFFFFF) and
                self.write_reg(REG_WALK_STEP, int(step) & 0xFFFFFFFF) and
                self.write_reg(REG_WALK_MAX, int(maximum) & 0xFFFFFFFF) and
                self.write_reg(REG_WALK_CTL, ctl))

    def set_live_drfm(self, delay0: int = 0, delay1: int = 0,
                      ftw0: int = 0, ftw1: int = 0,
                      amp0: int = LB_AMP_Q15_UNITY, amp1: int = 0,
                      period: int = 0, ftw_step: int = 0) -> bool:
        """Живые отводы после CDC: delay + mix + Q15. Не DELAY 0x1F."""
        amp = (int(amp0) & 0xFFFF) | ((int(amp1) & 0xFFFF) << 16)
        return (self.write_reg(REG_LB_DELAY, int(delay0) & 0xFFF) and
                self.write_reg(REG_LB_FTW, int(ftw0) & 0xFFFFFFFF) and
                self.write_reg(REG_LB_DELAY1, int(delay1) & 0xFFF) and
                self.write_reg(REG_LB_FTW1, int(ftw1) & 0xFFFFFFFF) and
                self.write_reg(REG_LB_AMP, amp) and
                self.write_reg(REG_WALK_PERIOD, int(period) & 0xFFFFFFFF) and
                self.write_reg(REG_WALK_FTW_STEP, int(ftw_step) & 0xFFFFFFFF))

    def set_proto_timing(self, period: int = 0, pulse: int = 0,
                         step_src: int = 0) -> bool:
        """PRI: PROTO_PERIOD/PULSE в сэмплах; step_src=1 шагает walk по PRI."""
        return (self.write_reg(REG_PROTO_PERIOD, int(period) & 0xFFFFFFFF) and
                self.write_reg(REG_PROTO_PULSE, int(pulse) & 0xFFFFFFFF) and
                self.write_reg(REG_DRFM_STEP_SRC, int(step_src) & 1))

    def set_channel_map(self, thr: int = 0, hyst: int = 0,
                        target: int = AIM_NONE, mode: int = 0) -> bool:
        """Карта 8×10 МГц / ELRS 80. thr=0 — слот выкл. target=0xFF — нет цели (0 = DC)."""
        return (self.write_reg(REG_CH_THR, int(thr) & 0xFFFFFFFF) and
                self.write_reg(REG_CH_HYST, int(hyst) & 0xFFFFFFFF) and
                self.write_reg(REG_CH_MODE, int(mode) & 1) and
                self.write_reg(REG_CH_TARGET, int(target) & 0xFF))

    def set_grid(self, meta: int = 0, f0_hz: int = 0, step_hz: int = 0,
                 pri_us: int = 0, shift_hz: int = 0, flags: int = 0,
                 pwr_thr: int = 0) -> bool:
        """Сетка умной атаки 0x51–0x58. Пусто — нули, не leftover ELRS."""
        sh = int(shift_hz) & 0xFFFFFFFF
        return (self.write_reg(REG_GRID_META, int(meta) & 0xFFFFFFFF) and
                self.write_reg(REG_GRID_F0_HZ, int(f0_hz) & 0xFFFFFFFF) and
                self.write_reg(REG_GRID_STEP_HZ, int(step_hz) & 0xFFFFFFFF) and
                self.write_reg(REG_GRID_PRI_US, int(pri_us) & 0xFFFFFFFF) and
                self.write_reg(REG_GRID_SHIFT_HZ, sh) and
                self.write_reg(REG_GRID_FLAGS, int(flags) & 0xFFFFFFFF) and
                self.write_reg(REG_GRID_RSV, 0) and
                self.write_reg(REG_CH_PWR_THR, int(pwr_thr) & 0xFFFF))

    def set_loopback_shift(self, shift: int) -> bool:
        return self.write_reg(REG_LB_SHIFT, shift & 0xF)

    def set_lb_delay(self, delay: int) -> bool:
        """Живой DRFM после CDC. 0 = обход. Не DELAY walk-off 0x1F."""
        n = int(delay)
        if n < 0:
            n = 0
        if n > 4095:
            n = 4095
        return self.write_reg(REG_LB_DELAY, n & 0xFFF)

    def set_lb_ftw(self, ftw: int) -> bool:
        """Частотный сдвиг после delayline. 0 = обход смесителя."""
        return self.write_reg(REG_LB_FTW, int(ftw) & 0xFFFFFFFF)

    def set_lb_shift_hz(self, hz: float, fs_hz: float) -> bool:
        """FTW = round(hz/fs · 2³²), знак как uint32 wrap. |hz|<0.5 → 0."""
        fs = float(fs_hz) if fs_hz else 0.0
        f = float(hz) if hz is not None else 0.0
        if fs <= 0.0 or abs(f) < 0.5:
            return self.set_lb_ftw(0)
        return self.set_lb_ftw(int(round(f / fs * (1 << 32))) & 0xFFFFFFFF)

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

    def set_air_tx_gain_db(self, gain_db: int) -> bool:
        """Ручной TX gain, дБ. Тот же код +1000, что у RX: сентинел NIOS не задан."""
        return self.write_reg(REG_AIR_TX_GAIN_DB, (int(gain_db) + 1000) & 0xFFFFFFFF)

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
