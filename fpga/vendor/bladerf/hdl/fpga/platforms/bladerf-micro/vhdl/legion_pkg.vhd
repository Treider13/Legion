-- ============================================================================
-- LEGION FPGA revision — пакет констант и регистровой карты.
-- Целевая платформа: bladeRF 1 x40 (Cyclone IV E, LMS6002D).
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

    -- Статус (читается NIOS по STATUS-PIO), биты:
    --   0 armed, 1 playing, 2 det_active, 3 capture_done, 4 wd_fired,
    --   5 lb_fifo_empty, 6 lb_fifo_full, 15..8 lb_fifo_level, 31..16 det_count

    constant LEGION_RAM_DEPTH      : natural := 4096;   -- 4096×32бит = 16 M9K на EP4CE40
    constant LEGION_LB_FIFO_DEPTH  : natural := 64;     -- CDC RX→TX, Gray-указатели

end package;

package body legion_pkg is
end package body;
