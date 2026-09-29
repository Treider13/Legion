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
    -- D=1 bypasses RAM; for D>=2 read and write addresses never collide.
    -- Keep the hint family-neutral: Cyclone IV uses M9K, Cyclone V uses M10K.
    attribute ramstyle of ram : signal is "no_rw_check";

    signal wr_addr : unsigned(11 downto 0) := (others => '0');
    signal dly_c   : unsigned(11 downto 0);
    signal rd_addr : unsigned(11 downto 0);
    signal ram_q   : std_logic_vector(31 downto 0) := (others => '0');
    signal d1_q    : std_logic_vector(31 downto 0) := (others => '0');
    signal accept  : std_logic;
    signal rd_en   : std_logic;

    type q_src_t is (Q_ZERO, Q_D1, Q_RAM);
    signal q_src : q_src_t := Q_ZERO;
begin
    dly_c <= delay when delay <= DEPTH - 1 else to_unsigned(DEPTH - 1, 12);
    accept <= '1' when reset = '0' and sample_en = '1' and dly_c /= 0 else '0';
    rd_en  <= '1' when accept = '1' and dly_c > 1 else '0';
    rd_addr <= wr_addr - (dly_c - 1) when dly_c > 1 else wr_addr;

    -- q_src records which value the previous accepted sample produced.  Using
    -- the live delay as the output mux would corrupt transitions between D=1
    -- and D>=2 while sample_en is low.
    dout <= din   when dly_c = 0 else
            d1_q  when q_src = Q_D1 else
            ram_q when q_src = Q_RAM else
            (others => '0');

    -- Canonical synchronous simple-dual-port inference.  Intel M9K/M10K RAM
    -- accesses must stay in a clock-only process; reset applies to control and
    -- output selection below, never to the memory array or its read register.
    ram_access : process(clock)
    begin
        if rising_edge(clock) then
            if accept = '1' then
                ram(to_integer(wr_addr)) <= din;
            end if;
            if rd_en = '1' then
                ram_q <= ram(to_integer(rd_addr));
            end if;
        end if;
    end process;

    control : process(clock, reset)
    begin
        if reset = '1' then
            wr_addr <= (others => '0');
            d1_q    <= (others => '0');
            q_src   <= Q_ZERO;
        elsif rising_edge(clock) then
            if accept = '1' then
                wr_addr <= wr_addr + 1;
                if dly_c = 1 then
                    d1_q  <= din;
                    q_src <= Q_D1;
                else
                    q_src <= Q_RAM;
                end if;
            end if;
        end if;
    end process;
end architecture;
