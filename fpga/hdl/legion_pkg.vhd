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

    -- Режимы TX-мультиплексора (CTRL.MODE, биты 3:1)
    constant LEGION_MODE_PASS      : std_logic_vector(2 downto 0) := "000"; -- обычный стрим с хоста
    constant LEGION_MODE_PLAYER    : std_logic_vector(2 downto 0) := "001"; -- волна из RAM
    constant LEGION_MODE_NCO       : std_logic_vector(2 downto 0) := "010"; -- тон DDS
    constant LEGION_MODE_LB_GATED  : std_logic_vector(2 downto 0) := "011"; -- RX→TX по детектору
    constant LEGION_MODE_LB_ALWAYS : std_logic_vector(2 downto 0) := "100"; -- RX→TX всегда
    constant LEGION_MODE_AIM       : std_logic_vector(2 downto 0) := "101"; -- NCO по CH_TARGET

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
    constant LEGION_REG_SCAN_CTRL    : natural := 16#10#; -- bit0 en, bit1 turn, bit2 park, bit3 survey
    constant LEGION_REG_SCAN_DWELL_US : natural := 16#11#; -- выдержка на сигнал в окне, мкс
    -- Точный Гц в взгляде: FFT-пик + цифровой вырез на стоящем LO. 0x12–0x14/0x17–0x1B —
    -- только NIOS (HDL when others => null), кроме FFT_CTRL и mux 0x15.
    constant LEGION_REG_SEARCH_BW_HZ : natural := 16#12#; -- analog BW обзора, Гц; 0 = AIR_BW
    constant LEGION_REG_FIRE_BW_HZ   : natural := 16#13#; -- leftover; вырез цифровой, analog не узжаем
    constant LEGION_REG_PEAK_KHZ     : natural := 16#14#; -- найденная частота, кГц (пишет NIOS)
    constant LEGION_REG_PEAK_BIN     : natural := 16#15#; -- STATUS mux: слово пика HDL
    constant LEGION_REG_FFT_CTRL     : natural := 16#16#; -- bit0 enable, bit1 dc_notch, bit2 lock
    constant LEGION_REG_BAND_IDX     : natural := 16#17#; -- индекс 0..7 для записи пары
    constant LEGION_REG_BAND_F1_KHZ  : natural := 16#18#;
    constant LEGION_REG_BAND_F2_KHZ  : natural := 16#19#;
    constant LEGION_REG_BAND_COUNT   : natural := 16#1A#; -- 0 = один коридор SCAN_F1/F2
    constant LEGION_REG_SETTLE_N     : natural := 16#1B#; -- сэмплы после hop; 0 = 4096
    constant LEGION_REG_SCAN_SURVEY_US : natural := 16#1C#; -- период глухого прохода, мкс; 0 = 5e6
    constant LEGION_REG_SCAN_EVENT   : natural := 16#1D#; -- [7:0] код, [31:8] seq
    -- Только NIOS (HDL when others => null). Код = gain+1000, 0xFFFFFFFF = не задан.
    constant LEGION_REG_AIR_TX_GAIN_DB : natural := 16#1E#; -- ручной TX gain, дБ
    -- Лабораторный walk-off: задержка capture_done → play_en и наращивание.
    -- Единица — период сэмпла (2 такта tx_clock, каденс LMS/ADI valid).
    constant LEGION_REG_DELAY      : natural := 16#1F#; -- начальная задержка, сэмплы
    constant LEGION_REG_WALK_STEP  : natural := 16#20#; -- прирост задержки за цикл
    constant LEGION_REG_WALK_MAX   : natural := 16#21#; -- потолок; 0 = до 2^32−1
    constant LEGION_REG_WALK_CTL   : natural := 16#22#; -- bit0 EN, bit1 AUTO, bit2 HOLD
    constant LEGION_REG_WALK_CUR   : natural := 16#23#; -- STATUS mux: текущая задержка
    -- Живой DRFM после CDC (mesarcik: delay + mix + scale). Не DELAY 0x1F.
    -- xA4: два отвода 4096, не RFSoC 4×256 км.
    constant LEGION_REG_LB_DELAY   : natural := 16#24#; -- tap0, сэмплы; 0 = без отвода
    constant LEGION_REG_LB_FTW     : natural := 16#25#; -- tap0 смеситель; 0 = обход
    constant LEGION_REG_LB_DELAY1  : natural := 16#26#; -- tap1
    constant LEGION_REG_LB_FTW1    : natural := 16#27#; -- tap1 смеситель
    constant LEGION_REG_LB_AMP     : natural := 16#28#; -- [15:0] A0 Q15, [31:16] A1
    constant LEGION_REG_WALK_PERIOD : natural := 16#29#; -- сэмплы между шагами; 0 = фронт det
    constant LEGION_REG_WALK_FTW_STEP : natural := 16#2A#; -- прирост FTW0 за шаг
    -- Occupancy после FFT (FOSDEM energy-window) + Top-N (SciPy find_peaks).
    -- Не 88 PIO: CH_PWR/PEAKk — STATUS mux, как 0x15/0x23.
    -- 0x2B–0x31 заняты production main (PR #86). PROTO/8-slot карта — с 0x32.
    constant LEGION_REG_CH_CTRL    : natural := 16#2B#; -- HDL [15:0]; NIOS preset [17:16]
    constant LEGION_REG_CH_IDX     : natural := 16#2C#; -- индекс 0..79 (как BAND_IDX)
    constant LEGION_REG_CH_PWR     : natural := 16#2D#; -- STATUS mux: слово канала
    constant LEGION_REG_PEAK1      : natural := 16#2E#; -- STATUS mux: пик 1
    constant LEGION_REG_PEAK2      : natural := 16#2F#;
    constant LEGION_REG_PEAK3      : natural := 16#30#;
    constant LEGION_REG_CH_LUT     : natural := 16#31#; -- write {idx[15:8], ch[7:0]}
    -- PROTO_PERIOD: период пакета в сэмплах (хост). Пример @40 MSPS:
    --   ELRS 1000 Гц = 40000; OcuSync двойной пакет 6.8 мс = 272000.
    -- PROTO_PULSE: длительность пакета в сэмплах (хост; walk не гейтит).
    -- DRFM_STEP_SRC: 0 = WALK_PERIOD (лабораторные часы), 1 = PROTO_PERIOD.
    --   SRC=1 считает sample_en непрерывно (не сбрасывает на паузе det).
    -- Карта каналов 8×10 МГц (не 0x24–0x2A и не 0x2B–0x31):
    --   CH_MODE 0 = 8×10 МГц на 2400…2480 (грубая карта ISM 2.4).
    --     Занятая полоса 10 МГц — Goggles RE / FCC 1.4/3/10/20/40.
    --     Официальная сетка Air Unit 2.4 — 7 каналов×10 МГц, не 8;
    --     8 слотов = 80 МГц ISM и CH_ENERGY_0..7, не таблица DJI.
    --   CH_MODE 1 = ELRS ISM2G4: 2400.4…2479.4 / 80 / 1 МГц (FHSS.cpp).
    --   CH_ACTIVE_0: 8 бит слотов 10 МГц. ACTIVE_1..3: 80 бит ELRS.
    --   CH_ENERGY_0..7 / CH_HITS_0..7: энергия и окна подряд ≥ CH_THR.
    --   CH_TARGET: номер FFT-бина (не индекс группы). CH_HYST = N хитов.
    --   CH_FS_HZ / CH_LO_KHZ: NIOS → HDL для абсолютной сетки 2.4.
    --   fs=0 или lo=0: 8 октантов по 32 бина (стенд без LO).
    constant LEGION_REG_PROTO_PERIOD  : natural := 16#32#;
    constant LEGION_REG_PROTO_PULSE   : natural := 16#33#;
    constant LEGION_REG_DRFM_STEP_SRC : natural := 16#34#; -- bit0
    constant LEGION_REG_CH_THR        : natural := 16#35#; -- порог энергии (NIOS)
    constant LEGION_REG_CH_HYST       : natural := 16#36#; -- N окон подряд (NIOS)
    constant LEGION_REG_CH_TARGET     : natural := 16#37#; -- FFT bin 0..255
    constant LEGION_REG_CH_MODE       : natural := 16#38#; -- 0 OcuSync / 1 ELRS
    constant LEGION_REG_CH_ACTIVE_0   : natural := 16#39#; -- [7:0] 10 МГц
    constant LEGION_REG_CH_ACTIVE_1   : natural := 16#3A#; -- ELRS bits 0..31
    constant LEGION_REG_CH_ACTIVE_2   : natural := 16#3B#; -- ELRS bits 32..63
    constant LEGION_REG_CH_ACTIVE_3   : natural := 16#3C#; -- ELRS bits 64..79
    constant LEGION_REG_CH_ENERGY_0   : natural := 16#3D#;
    constant LEGION_REG_CH_ENERGY_1   : natural := 16#3E#;
    constant LEGION_REG_CH_ENERGY_2   : natural := 16#3F#;
    constant LEGION_REG_CH_ENERGY_3   : natural := 16#40#;
    constant LEGION_REG_CH_ENERGY_4   : natural := 16#41#;
    constant LEGION_REG_CH_ENERGY_5   : natural := 16#42#;
    constant LEGION_REG_CH_ENERGY_6   : natural := 16#43#;
    constant LEGION_REG_CH_ENERGY_7   : natural := 16#44#;
    constant LEGION_REG_CH_HITS_0     : natural := 16#45#;
    constant LEGION_REG_CH_HITS_1     : natural := 16#46#;
    constant LEGION_REG_CH_HITS_2     : natural := 16#47#;
    constant LEGION_REG_CH_HITS_3     : natural := 16#48#;
    constant LEGION_REG_CH_HITS_4     : natural := 16#49#;
    constant LEGION_REG_CH_HITS_5     : natural := 16#4A#;
    constant LEGION_REG_CH_HITS_6     : natural := 16#4B#;
    constant LEGION_REG_CH_HITS_7     : natural := 16#4C#;
    constant LEGION_REG_CH_BINS_03    : natural := 16#4D#; -- пики слотов 0..3
    constant LEGION_REG_CH_BINS_47    : natural := 16#4E#; -- пики слотов 4..7
    constant LEGION_REG_CH_FS_HZ      : natural := 16#4F#; -- NIOS → HDL
    constant LEGION_REG_CH_LO_KHZ     : natural := 16#50#; -- центр взгляда

    constant LEGION_DRFM_STEP_SRC_LAB   : natural := 0;
    constant LEGION_DRFM_STEP_SRC_PROTO : natural := 1;
    -- 80 каналов occupancy LUT (main). 8 слотов 10 МГц — отдельная карта.
    constant LEGION_CH_N                : natural := 80;
    constant LEGION_CH_SLOT_N           : natural := 8;
    constant LEGION_CH_MODE_OCUSYNC     : natural := 0;
    constant LEGION_CH_MODE_ELRS        : natural := 1;
    constant LEGION_CH_ELRS_N           : natural := 80;
    -- 2400…2480 МГц / 10 МГц — 8 слотов на ширину ISM 2.4 (83.5 МГц).
    constant LEGION_OCUSYNC_F0_KHZ      : natural := 2400000;
    constant LEGION_OCUSYNC_BW_KHZ      : natural := 10000;
    -- ExpressLRS FHSS.cpp RADIO_SX128X ISM2G4.
    constant LEGION_ELRS_F0_KHZ         : natural := 2400400;
    constant LEGION_ELRS_F1_KHZ         : natural := 2479400;
    constant LEGION_ELRS_SPACING_KHZ    : natural := 1000;

    type legion_ch_energy_t is array (0 to 7) of std_logic_vector(31 downto 0);

    constant LEGION_WALK_CTL_EN    : natural := 0;
    constant LEGION_WALK_CTL_AUTO  : natural := 1;
    constant LEGION_WALK_CTL_HOLD  : natural := 2;

    -- Состояния автомата walk-off (STATUS bits 7:5, когда EN=1)
    constant LEGION_WALK_ST_IDLE     : std_logic_vector(2 downto 0) := "000";
    constant LEGION_WALK_ST_WAIT_DET : std_logic_vector(2 downto 0) := "001";
    constant LEGION_WALK_ST_CAPTURE  : std_logic_vector(2 downto 0) := "010";
    constant LEGION_WALK_ST_DELAY    : std_logic_vector(2 downto 0) := "011";
    constant LEGION_WALK_ST_PLAY     : std_logic_vector(2 downto 0) := "100";
    constant LEGION_WALK_ST_STEP     : std_logic_vector(2 downto 0) := "101";

    constant LEGION_FFT_CTRL_EN      : natural := 0;
    constant LEGION_FFT_CTRL_DC_NOTCH : natural := 1;
    constant LEGION_FFT_CTRL_LOCK    : natural := 2;
    constant LEGION_FFT_CTRL_XLAT_BYPASS : natural := 3; -- xlat=passthrough; два FTW отводов

    -- CH_CTRL (HDL 16 бит): [1:0] map 0=raw 1=lut, [4:2] grp_shift,
    -- [5] fftshift, [6] dc_skip, [7] n80, [15:8] excl (0 → 8).
    -- NIOS [17:16] preset: 0 manual / 1 ELRS / 2 ISM-OCC-8 / 3 O4-VID-3.
    -- ELRS: ExpressLRS FHSS.cpp ISM2G4 2400.4…2479.4 / 80 / 1.000 МГц.
    -- ISM-OCC-8: геометрическая занятость 2400…2480 / 8×10 МГц (FOSDEM
    -- energy-window), не таблица DJI OcuSync.
    -- O4-VID-3: DJI specs 20/10 МГц CH1 5768.5 / CH2 5789.5 / CH3 5814.5.
    constant LEGION_CH_MAP_RAW     : natural := 0;
    constant LEGION_CH_MAP_LUT     : natural := 1;
    constant LEGION_CH_FFTSHIFT    : natural := 5;
    constant LEGION_CH_DC_SKIP     : natural := 6;
    constant LEGION_CH_N80         : natural := 7;
    constant LEGION_CH_EXCL_DEFAULT : natural := 8;
    constant LEGION_CH_PRESET_MANUAL : natural := 0;
    constant LEGION_CH_PRESET_ELRS   : natural := 1;
    constant LEGION_CH_PRESET_ISM8   : natural := 2;
    constant LEGION_CH_PRESET_O4VID3 : natural := 3;

    -- Статус (читается NIOS по STATUS-PIO), биты:
    --   0 playing, 1 capture_done, 2 det_active, 3 wd_fired (живой expired),
    --   15..8 lb_fifo_level, 31..16 det_count.
    --   Бит 4 подмешивает NIOS (липкий латч deadman, legion_cmds.c) — после
    --   автономного DISARM expired гаснет за мкс (enable=0), хост читает латч.
    --   7:5 — состояние walk-off (LEGION_WALK_ST_*), 000 если EN=0.

    constant LEGION_RAM_DEPTH      : natural := 4096;   -- 4096×32бит = 16 M9K на EP4CE40
    constant LEGION_LB_FIFO_DEPTH  : natural := 64;     -- CDC RX→TX, Gray-указатели
    -- Цифровая амплитуда ЦАП: 0.9·2^15. NCO / lb_gated / lb_always
    -- масштабирует mux. PASS и PLAYER — хост (дефолт каталога тоже 0.9).
    -- Защита ЦАП, не AGC и не аналоговый gain.
    constant LEGION_LB_AMP_Q15     : natural := 29491;

end package;

package body legion_pkg is
end package body;
