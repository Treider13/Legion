-- ============================================================================
-- LEGION — живая линия задержки RX→TX (tx_clock). Не walk-off (тот — снимок
-- в RAM плеера, DELAY 0x1F). Здесь непрерывный DRFM: FIFO CDC → эта RAM → mux.
-- Классика store-and-forward (mesarcik/DRFM, лабораторный repeater):
--   delay=0  — обход, dout=din, walk-off и PASS не меняются;
--   delay≥1  — синхронная BRAM, mux видит сэмпл N тактов sample_en назад.
-- Глубина 4096×32 = как плеер (16 M9K / M10K). xA4 Cyclone V: M10K только
-- синхронное чтение (Intel cv_5v2: M10K address registered). Comb-read
-- dout<=ram(rd) на xA4 в M10K не садится.
-- Каденс — sample_en (rd_en mux), не каждый такт: иначе задержка в тактах
-- tx_clock, а не в сэмплах (каденс LMS/ADI valid каждый 2-й такт).
-- Walk-off читает FIFO напрямую (lg_wo_rd_en) — эта сущность на его пути нет.
-- delay=0 не добавляет регистр (FIFO show-ahead → mux в том же такте).
-- delay≥1: mux берёт q прошлого sample_en, поэтому читаем wr-(delay-1)
-- (delay=1 — регистр din). Вместе = ровно delay сэмплов на захвате mux.
-- ============================================================================
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
use work.legion_pkg.all;

entity legion_delayline is
    generic (
        DEPTH : natural := LEGION_RAM_DEPTH
    );
    port (
        clock     : in  std_logic;
        reset     : in  std_logic;
        delay     : in  unsigned(11 downto 0);  -- 0 = обход, 1..4095
        din       : in  std_logic_vector(31 downto 0);
        sample_en : in  std_logic;
        dout      : out std_logic_vector(31 downto 0)
    );
end entity;

architecture rtl of legion_delayline is
    type ram_t is array (0 to DEPTH-1) of std_logic_vector(31 downto 0);
    signal ram : ram_t := (others => (others => '0'));
    attribute ramstyle : string;
    attribute ramstyle of ram : signal is "M9K";

    signal wr_addr : unsigned(11 downto 0) := (others => '0');
    signal dly_c   : unsigned(11 downto 0);
    signal q       : std_logic_vector(31 downto 0) := (others => '0');
begin
    dly_c <= delay when delay <= DEPTH - 1 else to_unsigned(DEPTH - 1, 12);
    dout  <= din when dly_c = 0 else q;

    process(clock, reset)
        variable rd : unsigned(11 downto 0);
    begin
        if reset = '1' then
            wr_addr <= (others => '0');
            q       <= (others => '0');
        elsif rising_edge(clock) then
            if sample_en = '1' and dly_c /= 0 then
                if dly_c = 1 then
                    q <= din;
                else
                    rd := wr_addr - (dly_c - 1);
                    q <= ram(to_integer(rd));
                end if;
                ram(to_integer(wr_addr)) <= din;
                wr_addr <= wr_addr + 1;
            end if;
        end if;
    end process;
end architecture;
