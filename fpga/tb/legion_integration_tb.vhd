-- Интеграционный тестбенч: legion_dcfifo + legion_tx_mux вместе.
-- Реальный путь loopback: запись в rx-домене (10 нс), мукс читает в
-- tx-домене (10 нс, другая фаза) в режиме LB_ALWAYS. Проверяем, что
-- сэмплы доходят по порядку и без потерь на границе доменов.
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
use work.legion_pkg.all;

entity legion_integration_tb is
end entity;

architecture tb of legion_integration_tb is
    signal rx_clock   : std_logic := '0';
    signal tx_clock   : std_logic := '0';
    signal rx_reset   : std_logic := '1';
    signal tx_reset   : std_logic := '1';

    signal wr_data  : std_logic_vector(31 downto 0) := (others => '0');
    signal wr_en    : std_logic := '0';
    signal wr_full  : std_logic;
    signal rd_data  : std_logic_vector(31 downto 0);
    signal rd_empty : std_logic;
    signal rd_level : unsigned(7 downto 0);
    signal lb_rd_en : std_logic;

    signal out_i     : signed(15 downto 0);
    signal out_q     : signed(15 downto 0);
    signal out_valid : std_logic;
    signal done      : boolean := false;
begin
    -- Одинаковая частота, разная фаза (как rx_clock/tx_clock от LMS6002D)
    rx_clock <= not rx_clock after 5 ns when not done;
    tx_clock <= not tx_clock after 5.3 ns when not done;

    fifo : entity work.legion_dcfifo
        port map (
            wr_clk => rx_clock, wr_reset => rx_reset,
            wr_data => wr_data, wr_en => wr_en, wr_full => wr_full,
            rd_clk => tx_clock, rd_reset => tx_reset,
            rd_data => rd_data, rd_en => lb_rd_en,
            rd_empty => rd_empty, rd_level => rd_level
        );

    mux : entity work.legion_tx_mux
        port map (
            clock => tx_clock, reset => tx_reset,
            arm => '1', mode => LEGION_MODE_LB_ALWAYS, wd_ok => '1',
            det_active => '0', lb_shift => "0000",
            host_i => (others => '0'), host_q => (others => '0'), host_valid => '0',
            play_i => (others => '0'), play_q => (others => '0'), play_valid => '0',
            nco_i => (others => '0'), nco_q => (others => '0'), nco_valid => '0',
            lb_data => rd_data, lb_empty => rd_empty, lb_rd_en => lb_rd_en,
            out_i => out_i, out_q => out_q, out_valid => out_valid
        );

    -- Loopback — ЖИВОЙ поток: мукс выдаёт сэмплы по мере поступления,
    -- буфера на 16 нет. Поэтому писатель и читатель — параллельные процессы
    -- (факт из VCD: первый out_valid на 143 нс, задолго до конца записи).
    writer : process
    begin
        wait for 40 ns;
        rx_reset <= '0';
        tx_reset <= '0';
        wait for 40 ns;
        for k in 1 to 16 loop
            wr_data <= std_logic_vector(to_signed(k * 100, 16)) &
                       std_logic_vector(to_signed(-k * 100, 16));
            wr_en <= '1';
            wait until rising_edge(rx_clock);
            wr_en <= '0';
            wait until rising_edge(rx_clock);
        end loop;
        wait;
    end process;

    reader : process
        variable got  : integer := 0;
        variable last : integer := 0;
    begin
        while got < 16 loop
            wait until rising_edge(tx_clock);
            if out_valid = '1' and out_i /= 0 then
                got := got + 1;
                -- Порядок через CDC: каждый следующий на +100
                assert to_integer(out_i) = last + 100 and to_integer(out_q) = -(last + 100)
                    report "FAIL: CDC order at sample " & integer'image(got) &
                           " got I=" & integer'image(to_integer(out_i)) &
                           " expected " & integer'image(last + 100)
                    severity failure;
                last := to_integer(out_i);
            end if;
        end loop;
        assert got = 16 report "FAIL: not all samples" severity failure;
        report "legion_integration_tb: PASS (16/16 via CDC)" severity note;
        done <= true;
        wait;
    end process;
end architecture;
