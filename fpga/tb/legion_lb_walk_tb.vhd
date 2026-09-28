-- Тестбенч legion_lb_walk: обход, фронт det, потолок, смена LB_DELAY.
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
use work.legion_pkg.all;

entity legion_lb_walk_tb is
end entity;

architecture tb of legion_lb_walk_tb is
    signal clock      : std_logic := '0';
    signal reset      : std_logic := '1';
    signal enable     : std_logic := '0';
    signal arm        : std_logic := '1';
    signal hold_max   : std_logic := '0';
    signal delay_init : unsigned(11 downto 0) := to_unsigned(8, 12);
    signal walk_step  : unsigned(31 downto 0) := to_unsigned(4, 32);
    signal walk_max   : unsigned(31 downto 0) := to_unsigned(16, 32);
    signal det_active : std_logic := '0';
    signal tap        : unsigned(11 downto 0);
    signal cur_delay  : unsigned(31 downto 0);
    signal done       : boolean := false;

    procedure tick(n : natural) is
    begin
        for i in 1 to n loop
            wait until rising_edge(clock);
        end loop;
    end procedure;

    procedure pulse_det(signal det : out std_logic) is
    begin
        det <= '1';
        tick(2);
        det <= '0';
        tick(2);
    end procedure;
begin
    clock <= not clock after 5 ns when not done;

    dut : entity work.legion_lb_walk
        port map (
            clock => clock, reset => reset,
            enable => enable, arm => arm, hold_max => hold_max,
            delay_init => delay_init, walk_step => walk_step, walk_max => walk_max,
            det_active => det_active, tap => tap, cur_delay => cur_delay
        );

    stim : process
    begin
        tick(4);
        reset <= '0';
        tick(4);

        -- EN=0: отвод = LB_DELAY, фронт не шагает
        pulse_det(det_active);
        assert tap = to_unsigned(8, 12)
            report "FAIL: bypass tap != init" severity failure;

        enable <= '1';
        tick(2);
        assert tap = to_unsigned(8, 12)
            report "FAIL: arm start != init" severity failure;

        pulse_det(det_active);
        assert tap = to_unsigned(12, 12)
            report "FAIL: first rise 8+4" severity failure;
        pulse_det(det_active);
        assert tap = to_unsigned(16, 12)
            report "FAIL: second rise 12+4" severity failure;

        -- потолок 16, HOLD=0 → сброс к init
        pulse_det(det_active);
        assert tap = to_unsigned(8, 12)
            report "FAIL: wrap to init" severity failure;

        hold_max <= '1';
        pulse_det(det_active); -- 12
        pulse_det(det_active); -- 16
        pulse_det(det_active); -- hold 16
        assert tap = to_unsigned(16, 12)
            report "FAIL: hold at max" severity failure;

        -- новый LB_DELAY сбрасывает отвод
        delay_init <= to_unsigned(3, 12);
        tick(2);
        assert tap = to_unsigned(3, 12)
            report "FAIL: new init resets tap" severity failure;

        walk_step <= (others => '0');
        pulse_det(det_active);
        assert tap = to_unsigned(3, 12)
            report "FAIL: step 0 frozen" severity failure;

        -- det_active — уровень (legion_detector). Уже высокий на EN — фронта нет.
        enable <= '0';
        hold_max <= '0';
        delay_init <= to_unsigned(8, 12);
        walk_step <= to_unsigned(4, 32);
        walk_max <= to_unsigned(16, 32);
        det_active <= '1';
        tick(4);
        enable <= '1';
        tick(4);
        assert tap = to_unsigned(8, 12)
            report "FAIL: det already high at EN must not step" severity failure;
        det_active <= '0';
        tick(2);
        pulse_det(det_active);
        assert tap = to_unsigned(12, 12)
            report "FAIL: first real rise after already-high" severity failure;

        report "legion_lb_walk_tb: PASS" severity note;
        done <= true;
        wait;
    end process;
end architecture;
