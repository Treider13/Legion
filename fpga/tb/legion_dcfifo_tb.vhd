-- Тестбенч legion_dcfifo: запись в одном домене, чтение в другом (разные
-- периоды — фазовый разнос), порядок данных, флаги empty/full.
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity legion_dcfifo_tb is
end entity;

architecture tb of legion_dcfifo_tb is
    signal wr_clk   : std_logic := '0';
    signal rd_clk   : std_logic := '0';
    signal wr_reset : std_logic := '1';
    signal rd_reset : std_logic := '1';
    signal wr_data  : std_logic_vector(31 downto 0) := (others => '0');
    signal wr_en    : std_logic := '0';
    signal wr_full  : std_logic;
    signal rd_data  : std_logic_vector(31 downto 0);
    signal rd_en    : std_logic := '0';
    signal rd_empty : std_logic;
    signal rd_level : unsigned(7 downto 0);
    signal done     : boolean := false;
begin
    -- Домены с разным периодом (10 нс vs 11 нс) — настоящий CDC
    wr_clk <= not wr_clk after 5 ns when not done;
    rd_clk <= not rd_clk after 5.5 ns when not done;

    dut : entity work.legion_dcfifo
        port map (
            wr_clk => wr_clk, wr_reset => wr_reset,
            wr_data => wr_data, wr_en => wr_en, wr_full => wr_full,
            rd_clk => rd_clk, rd_reset => rd_reset,
            rd_data => rd_data, rd_en => rd_en,
            rd_empty => rd_empty, rd_level => rd_level
        );

    stim : process
        variable got : integer;
    begin
        wait for 30 ns;
        wr_reset <= '0';
        rd_reset <= '0';
        wait for 30 ns;
        assert rd_empty = '1' report "FAIL: FIFO not empty after reset" severity failure;

        -- Пишем 32 значения (0..31 в старшей половине слова)
        for k in 0 to 31 loop
            wr_data <= std_logic_vector(to_unsigned(k * 65536, 32));
            wr_en <= '1';
            wait until rising_edge(wr_clk);
        end loop;
        wr_en <= '0';
        wait until rising_edge(wr_clk);
        assert wr_full = '0' report "FAIL: full at 32/64" severity failure;

        -- Читаем всё в другом домене, проверяем порядок.
        -- Протокол как у потребителя в legion_tx_mux: rd_en пульсом на 1 такт,
        -- данные захватываем на такте, когда rd_en высок (comb rd_data).
        got := 0;
        while got < 32 loop
            wait until rising_edge(rd_clk);
            if rd_empty = '0' and rd_en = '0' then
                rd_en <= '1';   -- пульс на один такт
            elsif rd_en = '1' then
                assert rd_data = std_logic_vector(to_unsigned(got * 65536, 32))
                    report "FAIL: FIFO order, element " & integer'image(got)
                    severity failure;
                got := got + 1;
                rd_en <= '0';
            end if;
        end loop;
        rd_en <= '0';
        wait until rising_edge(rd_clk);
        wait until rising_edge(rd_clk);
        wait until rising_edge(rd_clk);
        assert rd_empty = '1' report "FAIL: FIFO not drained" severity failure;

        report "legion_dcfifo_tb: PASS" severity note;
        done <= true;
        wait;
    end process;
end architecture;
