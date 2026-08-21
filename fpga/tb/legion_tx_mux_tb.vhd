-- Тестбенч legion_tx_mux: PASS сквозной, PLAYER без ARM → тишина с каденсом,
-- LB_ALWAYS гонит данные из FIFO, LB_GATED закрыт без детекта, watchdog рубит.
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
use work.legion_pkg.all;

entity legion_tx_mux_tb is
end entity;

architecture tb of legion_tx_mux_tb is
    signal clock      : std_logic := '0';
    signal reset      : std_logic := '1';
    signal arm        : std_logic := '0';
    signal mode       : std_logic_vector(2 downto 0) := LEGION_MODE_PASS;
    signal wd_ok      : std_logic := '1';
    signal det_active : std_logic := '0';
    signal lb_shift   : unsigned(3 downto 0) := (others => '0');
    signal host_i     : signed(15 downto 0) := to_signed(111, 16);
    signal host_q     : signed(15 downto 0) := to_signed(222, 16);
    signal host_valid : std_logic := '0';
    signal play_i     : signed(15 downto 0) := to_signed(333, 16);
    signal play_q     : signed(15 downto 0) := to_signed(444, 16);
    signal play_valid : std_logic := '0';
    signal nco_i      : signed(15 downto 0) := to_signed(555, 16);
    signal nco_q      : signed(15 downto 0) := to_signed(666, 16);
    signal nco_valid  : std_logic := '0';
    signal lb_data    : std_logic_vector(31 downto 0) := x"0300" & x"FD00"; -- I=768, Q=-768
    signal lb_empty   : std_logic := '1';
    signal lb_rd_en   : std_logic;
    signal out_i      : signed(15 downto 0);
    signal out_q      : signed(15 downto 0);
    signal out_valid  : std_logic;
    signal done       : boolean := false;
begin
    clock <= not clock after 5 ns when not done;

    dut : entity work.legion_tx_mux
        port map (
            clock => clock, reset => reset,
            arm => arm, mode => mode, wd_ok => wd_ok, det_active => det_active,
            lb_shift => lb_shift,
            host_i => host_i, host_q => host_q, host_valid => host_valid,
            play_i => play_i, play_q => play_q, play_valid => play_valid,
            nco_i => nco_i, nco_q => nco_q, nco_valid => nco_valid,
            lb_data => lb_data, lb_empty => lb_empty, lb_rd_en => lb_rd_en,
            out_i => out_i, out_q => out_q, out_valid => out_valid
        );

    stim : process
        variable saw_valid : boolean;
    begin
        wait for 20 ns;
        reset <= '0';
        wait until rising_edge(clock);

        -- 1) PASS: хост-поток идёт сквозь
        host_valid <= '1';
        wait until rising_edge(clock);
        wait until rising_edge(clock);
        assert out_valid = '1' and out_i = 111 and out_q = 222
            report "FAIL: PASS does not pass host" severity failure;
        host_valid <= '0';
        wait until rising_edge(clock);

        -- 2) PLAYER без ARM: тишина — нули, но valid pulсирует (каденс LMS!)
        mode <= LEGION_MODE_PLAYER;
        play_valid <= '1';
        wait until rising_edge(clock);
        saw_valid := false;
        for k in 0 to 7 loop
            wait until rising_edge(clock);
            assert out_i = 0 and out_q = 0
                report "FAIL: silence not zero (PLAYER w/o ARM)" severity failure;
            if out_valid = '1' then saw_valid := true; end if;
        end loop;
        assert saw_valid report "FAIL: silence w/o valid cadence (DAC holds last sample!)"
            severity failure;

        -- 3) PLAYER с ARM: данные плеера сквозь
        arm <= '1';
        wait until rising_edge(clock);
        wait until rising_edge(clock);
        assert out_valid = '1' and out_i = 333 and out_q = 444
            report "FAIL: PLAYER armed does not pass player" severity failure;

        -- 4) Watchdog expired → снова тишина
        wd_ok <= '0';
        wait until rising_edge(clock);
        wait until rising_edge(clock);
        assert out_i = 0 report "FAIL: watchdog does not cut PLAYER" severity failure;
        wd_ok <= '1';
        wait until rising_edge(clock);

        -- 5) LB_GATED без детекта → тишина; с детектом → данные FIFO
        mode <= LEGION_MODE_LB_GATED;
        lb_empty <= '0';
        det_active <= '0';
        for k in 0 to 5 loop wait until rising_edge(clock); end loop;
        assert out_i = 0 report "FAIL: LB_GATED open w/o detect" severity failure;
        det_active <= '1';
        saw_valid := false;
        for k in 0 to 9 loop
            wait until rising_edge(clock);
            if out_valid = '1' then
                -- Контракт: valid-импульс несёт либо нули тишины (переход
                -- гейта), либо данные FIFO. Мусора быть не должно.
                assert (out_i = 0 and out_q = 0) or (out_i = 768 and out_q = -768)
                    report "FAIL: LB garbage data" severity failure;
                if out_i = 768 then saw_valid := true; end if;
            end if;
        end loop;
        assert saw_valid report "FAIL: LB_GATED did not open on detect" severity failure;

        -- 6) LB_ALWAYS, FIFO опустел на открытом гейте: каденс valid ЖИВЁТ,
        --    данные — нули (иначе DAC завис бы на последнем сэмпле).
        -- 4 такта на рассасывание in-flight сэмпла из шага 5 (конвейер).
        mode <= LEGION_MODE_LB_ALWAYS;
        lb_empty <= '1';
        det_active <= '0';
        for k in 0 to 3 loop wait until rising_edge(clock); end loop;
        saw_valid := false;
        for k in 0 to 7 loop
            wait until rising_edge(clock);
            if out_valid = '1' then
                saw_valid := true;
                assert out_i = 0 and out_q = 0
                    report "FAIL: starved LB not zero" severity failure;
            end if;
        end loop;
        assert saw_valid report "FAIL: starved LB lost valid cadence (stale DAC)" severity failure;

        report "legion_tx_mux_tb: PASS" severity note;
        done <= true;
        wait;
    end process;
end architecture;
