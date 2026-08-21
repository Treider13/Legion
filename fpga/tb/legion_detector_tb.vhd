-- Тестбенч legion_detector: порог, окно, счётчик детектов.
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity legion_detector_tb is
end entity;

architecture tb of legion_detector_tb is
    signal clock      : std_logic := '0';
    signal reset      : std_logic := '1';
    signal in_i       : signed(15 downto 0) := (others => '0');
    signal in_q       : signed(15 downto 0) := (others => '0');
    signal in_valid   : std_logic := '0';
    signal threshold  : unsigned(31 downto 0) := to_unsigned(1000, 32);
    signal win_shift  : unsigned(3 downto 0) := to_unsigned(4, 4);  -- окно 16
    signal det_active : std_logic;
    signal det_count  : unsigned(15 downto 0);
    signal done       : boolean := false;
begin
    clock <= not clock after 5 ns when not done;

    dut : entity work.legion_detector
        port map (
            clock => clock, reset => reset,
            in_i => in_i, in_q => in_q, in_valid => in_valid,
            threshold => threshold, win_shift => win_shift,
            det_active => det_active, det_count => det_count
        );

    stim : process
        -- Каденс как у LMS RX: valid каждый 2-й такт
        procedure send_sample(iv : integer; qv : integer) is
        begin
            in_i <= to_signed(iv, 16);
            in_q <= to_signed(qv, 16);
            in_valid <= '1';
            wait until rising_edge(clock);
            in_valid <= '0';
            wait until rising_edge(clock);
        end procedure;
    begin
        wait for 20 ns;
        reset <= '0';
        wait until rising_edge(clock);

        -- 16 сэмплов тишины (0) → детекта быть не должно (0 < 1000)
        for k in 0 to 15 loop
            send_sample(0, 0);
        end loop;
        wait until rising_edge(clock);
        assert det_active = '0' report "FAIL: detect on silence" severity failure;
        assert det_count = 0 report "FAIL: count on silence" severity failure;

        -- 16 сэмплов с энергией: I=100,Q=0 → avg=10000 ≥ 1000 → детект
        for k in 0 to 15 loop
            send_sample(100, 0);
        end loop;
        wait until rising_edge(clock);
        wait until rising_edge(clock);
        assert det_active = '1' report "FAIL: no detect at energy" severity failure;
        assert det_count = 1 report "FAIL: count not incremented" severity failure;

        -- Снова тишина → det_active снимается, счётчик не растёт
        for k in 0 to 15 loop
            send_sample(0, 0);
        end loop;
        wait until rising_edge(clock);
        wait until rising_edge(clock);
        assert det_active = '0' report "FAIL: detect not cleared" severity failure;
        assert det_count = 1 report "FAIL: count grew on silence" severity failure;

        -- Подпороговая энергия: I=20,Q=20 → 800 < 1000 → нет детекта
        for k in 0 to 15 loop
            send_sample(20, 20);
        end loop;
        wait until rising_edge(clock);
        wait until rising_edge(clock);
        assert det_active = '0' report "FAIL: detect below threshold" severity failure;

        -- Кламп shift=15 → окно 4096 (не мусор): энергия 10000 ≥ 1000,
        -- детект должен взвестись ровно после 4096 сэмплов, не раньше
        win_shift <= to_unsigned(15, 4);
        for k in 0 to 15 loop
            send_sample(100, 0);
        end loop;
        wait until rising_edge(clock);
        assert det_count = 1 report "FAIL: shift=15 early detect (window overflow)" severity failure;
        win_shift <= to_unsigned(4, 4);

        report "legion_detector_tb: PASS" severity note;
        done <= true;
        wait;
    end process;
end architecture;
