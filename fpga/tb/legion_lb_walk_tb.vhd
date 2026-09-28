-- Тестбенч legion_lb_walk: обход, фронт det, период, потолок, FTW0, смена init.
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
use work.legion_pkg.all;

entity legion_lb_walk_tb is
end entity;

architecture tb of legion_lb_walk_tb is
    signal clock        : std_logic := '0';
    signal reset        : std_logic := '1';
    signal enable       : std_logic := '0';
    signal arm          : std_logic := '1';
    signal hold_max     : std_logic := '0';
    signal delay_init   : unsigned(11 downto 0) := to_unsigned(8, 12);
    signal delay1_init  : unsigned(11 downto 0) := to_unsigned(2, 12);
    signal walk_step    : unsigned(31 downto 0) := to_unsigned(4, 32);
    signal walk_max     : unsigned(31 downto 0) := to_unsigned(16, 32);
    signal walk_period  : unsigned(31 downto 0) := (others => '0');
    signal proto_period : unsigned(31 downto 0) := (others => '0');
    signal step_src     : std_logic := '0';
    signal ftw0_init    : unsigned(31 downto 0) := (others => '0');
    signal ftw1_init    : unsigned(31 downto 0) := to_unsigned(7, 32);
    signal ftw_step     : unsigned(31 downto 0) := (others => '0');
    signal det_active   : std_logic := '0';
    signal sample_en    : std_logic := '0';
    signal tap          : unsigned(11 downto 0);
    signal tap1         : unsigned(11 downto 0);
    signal ftw0         : unsigned(31 downto 0);
    signal ftw1         : unsigned(31 downto 0);
    signal cur_delay    : unsigned(31 downto 0);
    signal done         : boolean := false;

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

    procedure pulse_sample(signal en : out std_logic; n : natural) is
    begin
        for i in 1 to n loop
            en <= '1';
            tick(1);
            en <= '0';
            tick(1);
        end loop;
    end procedure;
begin
    clock <= not clock after 5 ns when not done;

    dut : entity work.legion_lb_walk
        port map (
            clock => clock, reset => reset,
            enable => enable, arm => arm, hold_max => hold_max,
            delay_init => delay_init, delay1_init => delay1_init,
            walk_step => walk_step, walk_max => walk_max,
            walk_period => walk_period, proto_period => proto_period,
            step_src => step_src,
            ftw0_init => ftw0_init, ftw1_init => ftw1_init, ftw_step => ftw_step,
            det_active => det_active, sample_en => sample_en,
            tap => tap, tap1 => tap1, ftw0 => ftw0, ftw1 => ftw1,
            cur_delay => cur_delay
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
        assert tap1 = to_unsigned(2, 12)
            report "FAIL: bypass tap1 != init" severity failure;
        assert ftw0 = 0 and ftw1 = to_unsigned(7, 32)
            report "FAIL: bypass FTW != init" severity failure;

        enable <= '1';
        tick(2);
        assert tap = to_unsigned(8, 12)
            report "FAIL: arm start != init" severity failure;

        pulse_det(det_active);
        assert tap = to_unsigned(12, 12)
            report "FAIL: first rise 8+4" severity failure;
        assert tap1 = to_unsigned(6, 12)
            report "FAIL: tap1 first rise 2+4" severity failure;
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

        -- PERIOD>0: шаг каждые N сэмплов, пока det=1. Не фронт.
        enable <= '0';
        delay_init <= to_unsigned(0, 12);
        delay1_init <= to_unsigned(64, 12);
        walk_step <= to_unsigned(1, 32);
        walk_max <= to_unsigned(4095, 32);
        walk_period <= to_unsigned(4, 32);
        ftw0_init <= to_unsigned(10, 32);
        ftw1_init <= to_unsigned(3, 32);
        ftw_step <= to_unsigned(2, 32);
        hold_max <= '1';
        det_active <= '0';
        tick(2);
        enable <= '1';
        tick(2);
        det_active <= '1';
        pulse_sample(sample_en, 3);
        assert tap = to_unsigned(0, 12) and ftw0 = to_unsigned(10, 32)
            report "FAIL: period 4, 3 samples must not step" severity failure;
        pulse_sample(sample_en, 1);
        assert tap = to_unsigned(1, 12)
            report "FAIL: period 4 fourth sample steps tap" severity failure;
        assert tap1 = to_unsigned(65, 12)
            report "FAIL: period step tap1" severity failure;
        assert ftw0 = to_unsigned(12, 32)
            report "FAIL: FTW0 += step" severity failure;
        assert ftw1 = to_unsigned(3, 32)
            report "FAIL: FTW1 must stay" severity failure;

        -- det упал — счётчик сброшен, шага нет
        det_active <= '0';
        pulse_sample(sample_en, 8);
        assert tap = to_unsigned(1, 12)
            report "FAIL: no step while det=0" severity failure;
        det_active <= '1';
        pulse_sample(sample_en, 4);
        assert tap = to_unsigned(2, 12)
            report "FAIL: period restarts after det gap" severity failure;

        -- SRC=1: шаг по PROTO_PERIOD, det=0 не сбрасывает и не запрещает.
        enable <= '0';
        delay_init <= to_unsigned(0, 12);
        delay1_init <= to_unsigned(0, 12);
        walk_step <= to_unsigned(1, 32);
        walk_period <= to_unsigned(4096, 32);
        proto_period <= to_unsigned(3, 32);
        step_src <= '1';
        ftw0_init <= to_unsigned(0, 32);
        ftw_step <= to_unsigned(0, 32);
        det_active <= '0';
        tick(2);
        enable <= '1';
        tick(2);
        pulse_sample(sample_en, 2);
        assert tap = to_unsigned(0, 12)
            report "FAIL: proto 3, 2 samples must not step" severity failure;
        pulse_sample(sample_en, 1);
        assert tap = to_unsigned(1, 12)
            report "FAIL: proto 3 third sample steps without det" severity failure;
        pulse_sample(sample_en, 3);
        assert tap = to_unsigned(2, 12)
            report "FAIL: proto continues across det=0" severity failure;

        report "legion_lb_walk_tb: PASS" severity note;
        done <= true;
        wait;
    end process;
end architecture;
