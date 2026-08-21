-- Тестбенч legion_watchdog: expiry без heartbeat, сброс heartbeat'ом.
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity legion_watchdog_tb is
end entity;

architecture tb of legion_watchdog_tb is
    signal clock     : std_logic := '0';
    signal reset     : std_logic := '1';
    signal enable    : std_logic := '0';
    signal heartbeat : std_logic := '0';
    signal limit     : unsigned(15 downto 0) := to_unsigned(2, 16);  -- 2×65536 тактов
    signal expired   : std_logic;
    signal done      : boolean := false;
begin
    clock <= not clock after 5 ns when not done;

    dut : entity work.legion_watchdog
        port map (
            clock => clock, reset => reset, enable => enable,
            heartbeat => heartbeat, limit => limit, expired => expired
        );

    stim : process
    begin
        wait for 20 ns;
        reset <= '0';
        wait until rising_edge(clock);

        -- WD выключен: expired никогда не взводится
        enable <= '0';
        for k in 0 to 200 loop wait until rising_edge(clock); end loop;
        assert expired = '0' report "FAIL: expired while WD disabled" severity failure;

        -- WD включён, heartbeat регулярно → expired = 0
        enable <= '1';
        for k in 0 to 3 loop
            for i in 0 to 40000 loop wait until rising_edge(clock); end loop;
            heartbeat <= '1';
            wait until rising_edge(clock);
            heartbeat <= '0';
            assert expired = '0' report "FAIL: expired with live heartbeat" severity failure;
        end loop;

        -- Heartbeat пропал → через 2×65536 тактов expired = 1
        for i in 0 to 2 * 65536 + 1000 loop
            wait until rising_edge(clock);
        end loop;
        assert expired = '1' report "FAIL: no expiry without heartbeat" severity failure;

        -- Heartbeat вернулся → expired снялся
        heartbeat <= '1';
        wait until rising_edge(clock);
        heartbeat <= '0';
        wait until rising_edge(clock);
        assert expired = '0' report "FAIL: expired not cleared by heartbeat" severity failure;

        report "legion_watchdog_tb: PASS" severity note;
        done <= true;
        wait;
    end process;
end architecture;
