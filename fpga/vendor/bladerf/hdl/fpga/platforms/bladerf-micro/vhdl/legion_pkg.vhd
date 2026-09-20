-- ============================================================================
-- LEGION FPGA revision — пакет констант и регистровой карты.
-- Платформы: bladeRF 1 x40 (Cyclone IV E, LMS6002D) и bladeRF 2.0 micro
-- xA4/xA9 (Cyclone V, AD9361 — эфир поднимает NIOS через AIR-регистры).
-- Источники интерфейсов (не выдуманы, сверены с деревом Nuand):
--   - TX-контракт LMS6002D: valid импульс каждый 2-й tx_clock
--     (hdl/fpga/ip/nuand/synthesis/lms6002d/vhdl/lms6002d.vhd, процесс tx_sample)
--   - Точка врезки TX: между fifo_reader и iq_correction
--     (wiki Nuand FPGA Development: "between iq_correction and sample fifos")
--   - Регистровый канал: NIOS 8x32-пакеты, target 0x80 — официально
--     зарезервирован Nuand под пользовательские расширения
--     (fpga_common/include/nios_pkt_8x32.h, комментарий к TARGET_USR1)
-- ============================================================================
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

package legion_pkg is

    -- Режимы TX-мультиплексора (CTRL.MODE, биты 2:1)
    constant LEGION_MODE_PASS      : std_logic_vector(2 downto 0) := "000"; -- обычный стрим с хоста
    constant LEGION_MODE_PLAYER    : std_logic_vector(2 downto 0) := "001"; -- волна из RAM
    constant LEGION_MODE_NCO       : std_logic_vector(2 downto 0) := "010"; -- тон DDS
    constant LEGION_MODE_LB_GATED  : std_logic_vector(2 downto 0) := "011"; -- RX→TX по детектору
    constant LEGION_MODE_LB_ALWAYS : std_logic_vector(2 downto 0) := "100"; -- RX→TX всегда

    -- Адреса регистров (адрес на отдельном PIO, данные 32 бита на wdata-PIO)
    -- CTRL: bit0=ARM, bits3:1=MODE, bit4=WD_EN
    constant LEGION_REG_CTRL       : natural := 16#00#;
    constant LEGION_REG_NCO_FTW    : natural := 16#01#; -- FTW = round(f/fs * 2^32)
    constant LEGION_REG_DET_THR    : natural := 16#02#; -- порог средней энергии (I²+Q²)
    constant LEGION_REG_DET_SHIFT  : natural := 16#03#; -- окно = 2^shift сэмплов (4..12)
    constant LEGION_REG_PLAYER_LEN : natural := 16#04#; -- длина волны-1 (0..4095)
    constant LEGION_REG_PLAYER_CTL : natural := 16#05#; -- bit0: capture_arm (самосброс)
    constant LEGION_REG_LB_SHIFT   : natural := 16#06#; -- сдвиг усиления loopback 0..8
    constant LEGION_REG_WD_LIMIT   : natural := 16#07#; -- таймаут: limit × 2^16 тактов tx_clock
    constant LEGION_REG_WD_KICK    : natural := 16#08#; -- любая запись = heartbeat (toggle)
    -- Эфирные регистры micro (AD9361): живут только в NIOS (legion_cmds.c),
    -- HDL их не декодирует (when others => null). На bladeRF 1 эфир поднимает
    -- шлюз через CONTROL bit1/2, эти регистры там no-op.
    constant LEGION_REG_AIR_FREQ_KHZ : natural := 16#09#; -- LO парковки, кГц (47М..6Г)
    constant LEGION_REG_AIR_GAIN_DB  : natural := 16#0A#; -- ручной RX gain, дБ (0 = не трогать)
    constant LEGION_REG_AIR_PREP     : natural := 16#0B#; -- bit0 up/down, bit1 RX, bit2 TX
    constant LEGION_REG_AIR_FS_HZ    : natural := 16#0C#; -- sample rate, Гц; 0 = 2 МГц
    constant LEGION_REG_AIR_BW_HZ    : natural := 16#0D#; -- analog BW, Гц; 0 = 2 МГц
    -- Онбордовый обзор (только NIOS, HDL не декодирует): коридор и стратегия
    -- шага LO. Хост пишет при ARM перехвата; USB в гейт RX→TX не входит.
    constant LEGION_REG_SCAN_F1_KHZ  : natural := 16#0E#; -- начало коридора, кГц
    constant LEGION_REG_SCAN_F2_KHZ  : natural := 16#0F#; -- конец коридора, кГц
    constant LEGION_REG_SCAN_CTRL    : natural := 16#10#; -- bit0 enable, bit1 turn
    constant LEGION_REG_SCAN_DWELL_US : natural := 16#11#; -- выдержка turn от детекта, мкс
    -- Точный Гц в взгляде: FFT-пик на FPGA, hop LO. 0x12–0x14/0x17–0x1B —
    -- только NIOS (HDL when others => null), кроме FFT_CTRL и mux 0x15.
    constant LEGION_REG_SEARCH_BW_HZ : natural := 16#12#; -- analog BW обзора, Гц; 0 = AIR_BW
    constant LEGION_REG_FIRE_BW_HZ   : natural := 16#13#; -- analog BW удержания, Гц; 0 = 2 МГц
    constant LEGION_REG_PEAK_KHZ     : natural := 16#14#; -- найденная частота, кГц (пишет NIOS)
    constant LEGION_REG_PEAK_BIN     : natural := 16#15#; -- STATUS mux: слово пика HDL
    constant LEGION_REG_FFT_CTRL     : natural := 16#16#; -- bit0 enable, bit1 dc_notch
    constant LEGION_REG_BAND_IDX     : natural := 16#17#; -- индекс 0..7 для записи пары
    constant LEGION_REG_BAND_F1_KHZ  : natural := 16#18#;
    constant LEGION_REG_BAND_F2_KHZ  : natural := 16#19#;
    constant LEGION_REG_BAND_COUNT   : natural := 16#1A#; -- 0 = один коридор SCAN_F1/F2
    constant LEGION_REG_SETTLE_N     : natural := 16#1B#; -- сэмплы после hop; 0 = 4096

    constant LEGION_FFT_CTRL_EN      : natural := 0;
    constant LEGION_FFT_CTRL_DC_NOTCH : natural := 1;

    -- Статус (читается NIOS по STATUS-PIO), биты:
    --   0 playing, 1 capture_done, 2 det_active, 3 wd_fired (живой expired),
    --   15..8 lb_fifo_level, 31..16 det_count; 7..4 в HDL нули.
    --   Бит 4 подмешивает NIOS (липкий латч deadman, legion_cmds.c) — после
    --   автономного DISARM expired гаснет за мкс (enable=0), хост читает латч.

    constant LEGION_RAM_DEPTH      : natural := 4096;   -- 4096×32бит = 16 M9K на EP4CE40
    constant LEGION_LB_FIFO_DEPTH  : natural := 64;     -- CDC RX→TX, Gray-указатели

end package;

package body legion_pkg is
end package body;
