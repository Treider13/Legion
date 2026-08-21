-- ============================================================================
-- LEGION — двухтактовый FIFO для CDC RX→TX (loopback).
-- Gray-указатели + 2-ступенчатые синхронизаторы — классическая схема
-- (Cummings, "Simulation and Synthesis Techniques for Asynchronous FIFO
-- Design"); аналог по функции — lb_fifo в bladerf-hosted.vhd.
-- Глубина 64×32: часы номинально одинаковой частоты (оба от LMS6002D),
-- FIFO гасит только фазовый разнос доменов.
-- ============================================================================
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity legion_dcfifo is
    generic (
        DEPTH : natural := 64;   -- степень двойки
        WIDTH : natural := 32
    );
    port (
        -- Запись (rx_clock)
        wr_clk    : in  std_logic;
        wr_reset  : in  std_logic;
        wr_data   : in  std_logic_vector(WIDTH-1 downto 0);
        wr_en     : in  std_logic;
        wr_full   : out std_logic;
        -- Чтение (tx_clock)
        rd_clk    : in  std_logic;
        rd_reset  : in  std_logic;
        rd_data   : out std_logic_vector(WIDTH-1 downto 0);
        rd_en     : in  std_logic;
        rd_empty  : out std_logic;
        rd_level  : out unsigned(7 downto 0)
    );
end entity;

architecture rtl of legion_dcfifo is
    constant AW : natural := 6;  -- log2(64)

    type ram_t is array (0 to DEPTH-1) of std_logic_vector(WIDTH-1 downto 0);
    signal ram : ram_t := (others => (others => '0'));

    signal wr_ptr_bin : unsigned(AW downto 0);
    signal wr_ptr_gry : unsigned(AW downto 0);
    signal rd_ptr_bin : unsigned(AW downto 0);
    signal rd_ptr_gry : unsigned(AW downto 0);

    signal rd_ptr_gry_w : unsigned(AW downto 0);  -- rd ptr в домене записи
    signal wr_ptr_gry_r : unsigned(AW downto 0);  -- wr ptr в домене чтения
    signal rd_sync1, rd_sync2 : unsigned(AW downto 0);
    signal wr_sync1, wr_sync2 : unsigned(AW downto 0);

    function bin2gray(b : unsigned) return unsigned is
    begin
        return b xor (b srl 1);
    end function;

    function gray2bin(g : unsigned) return unsigned is
        variable b : unsigned(g'range);
    begin
        b(g'high) := g(g'high);
        for i in g'high-1 downto 0 loop
            b(i) := b(i+1) xor g(i);
        end loop;
        return b;
    end function;
begin
    -- Память: запись в домене wr_clk, чтение comb/синхронно в rd_clk
    mem : process(wr_clk)
    begin
        if rising_edge(wr_clk) then
            if wr_en = '1' and wr_full = '0' then
                ram(to_integer(wr_ptr_bin(AW-1 downto 0))) <= wr_data;
            end if;
        end if;
    end process;

    rd_data <= ram(to_integer(rd_ptr_bin(AW-1 downto 0)));

    -- Указатель записи
    wr_side : process(wr_clk, wr_reset)
    begin
        if wr_reset = '1' then
            wr_ptr_bin <= (others => '0');
            wr_ptr_gry <= (others => '0');
            rd_sync1   <= (others => '0');
            rd_sync2   <= (others => '0');
        elsif rising_edge(wr_clk) then
            rd_sync1 <= rd_ptr_gry;
            rd_sync2 <= rd_sync1;
            if wr_en = '1' and wr_full = '0' then
                wr_ptr_bin <= wr_ptr_bin + 1;
                wr_ptr_gry <= bin2gray(wr_ptr_bin + 1);
            end if;
        end if;
    end process;

    rd_ptr_gry_w <= rd_sync2;
    wr_full <= '1' when wr_ptr_gry = (not rd_ptr_gry_w(AW downto AW-1)) & rd_ptr_gry_w(AW-2 downto 0) else '0';

    -- Указатель чтения
    rd_side : process(rd_clk, rd_reset)
        variable level_v : unsigned(AW downto 0);
    begin
        if rd_reset = '1' then
            rd_ptr_bin <= (others => '0');
            rd_ptr_gry <= (others => '0');
            wr_sync1   <= (others => '0');
            wr_sync2   <= (others => '0');
            rd_level   <= (others => '0');
        elsif rising_edge(rd_clk) then
            wr_sync1 <= wr_ptr_gry;
            wr_sync2 <= wr_sync1;
            if rd_en = '1' and rd_empty = '0' then
                rd_ptr_bin <= rd_ptr_bin + 1;
                rd_ptr_gry <= bin2gray(rd_ptr_bin + 1);
            end if;
            level_v := gray2bin(wr_sync2) - rd_ptr_bin;
            rd_level <= resize(level_v, 8);
        end if;
    end process;

    wr_ptr_gry_r <= wr_sync2;
    rd_empty <= '1' when rd_ptr_gry = wr_ptr_gry_r else '0';
end architecture;
