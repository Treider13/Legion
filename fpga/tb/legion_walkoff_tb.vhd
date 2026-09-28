-- Тестбенч legion_walkoff: обход, задержка, walk-off, автоцикл detect→play.
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
use work.legion_pkg.all;

entity legion_walkoff_tb is
end entity;

architecture tb of legion_walkoff_tb is
    signal clock        : std_logic := '0';
    signal reset        : std_logic := '1';
    signal enable       : std_logic := '0';
    signal auto         : std_logic := '0';
    signal hold_max     : std_logic := '0';
    signal delay_init   : unsigned(31 downto 0) := (others => '0');
    signal walk_step    : unsigned(31 downto 0) := (others => '0');
    signal walk_max     : unsigned(31 downto 0) := (others => '0');
    signal len_m1       : unsigned(11 downto 0) := to_unsigned(7, 12);
    signal arm          : std_logic := '0';
    signal mode_player  : std_logic := '0';
    signal det_active   : std_logic := '0';
    signal host_cap_arm : std_logic := '0';
    signal host_i       : signed(15 downto 0) := (others => '0');
    signal host_q       : signed(15 downto 0) := (others => '0');
    signal host_valid   : std_logic := '0';
    signal lb_data      : std_logic_vector(31 downto 0) := (others => '0');
    signal lb_empty     : std_logic := '1';
    signal lb_rd_en     : std_logic;
    signal cap_i        : signed(15 downto 0);
    signal cap_q        : signed(15 downto 0);
    signal cap_valid    : std_logic;
    signal capture_arm  : std_logic;
    signal play_en      : std_logic;
    signal capture_done : std_logic;
    signal play_i       : signed(15 downto 0);
    signal play_q       : signed(15 downto 0);
    signal play_valid   : std_logic;
    signal playing      : std_logic;
    signal delaying     : std_logic;
    signal lb_need      : std_logic;
    signal cur_delay    : unsigned(31 downto 0);
    signal wstate       : std_logic_vector(2 downto 0);
    signal done         : boolean := false;

    -- Модель RX FIFO: stim пишет fifo_stock (сколько слов доступно).
    signal fifo_stock : integer := 0;
    signal fifo_n     : integer := 0;
begin
    clock <= not clock after 5 ns when not done;

    wo : entity work.legion_walkoff
        port map (
            clock => clock, reset => reset,
            enable => enable, auto => auto, hold_max => hold_max,
            delay_init => delay_init, walk_step => walk_step, walk_max => walk_max,
            len_m1 => len_m1, lb_shift => "0000",
            arm => arm, mode_player => mode_player, det_active => det_active,
            host_cap_arm => host_cap_arm, host_i => host_i, host_q => host_q,
            host_valid => host_valid,
            lb_data => lb_data, lb_empty => lb_empty, lb_rd_en => lb_rd_en,
            cap_i => cap_i, cap_q => cap_q, cap_valid => cap_valid,
            capture_arm => capture_arm, play_en => play_en,
            capture_done => capture_done, play_valid => play_valid,
            delaying => delaying, lb_need => lb_need,
            cur_delay => cur_delay, state => wstate
        );

    ply : entity work.legion_player
        port map (
            clock => clock, reset => reset,
            cap_i => cap_i, cap_q => cap_q, cap_valid => cap_valid,
            capture_arm => capture_arm, capture_done => capture_done,
            play_en => play_en, len_m1 => len_m1,
            out_i => play_i, out_q => play_q, out_valid => play_valid,
            playing => playing
        );

    -- Слово уже на шине; rd_en забирает текущее и выставляет следующее.
    fifo : process(clock)
        variable n : integer;
    begin
        if rising_edge(clock) then
            if reset = '1' then
                fifo_n   <= 0;
                lb_empty <= '1';
                lb_data  <= (others => '0');
            else
                n := fifo_n;
                if n = 0 and fifo_stock > 0 then
                    n := 1;
                    fifo_n <= 1;
                    lb_data <= std_logic_vector(to_signed(10, 16)) &
                               std_logic_vector(to_signed(-10, 16));
                    lb_empty <= '0';
                elsif lb_rd_en = '1' and n < fifo_stock then
                    n := n + 1;
                    fifo_n <= n;
                    lb_data <= std_logic_vector(to_signed(n * 10, 16)) &
                               std_logic_vector(to_signed(-n * 10, 16));
                    if n >= fifo_stock then
                        lb_empty <= '1';
                    end if;
                elsif n >= fifo_stock then
                    lb_empty <= '1';
                end if;
            end if;
        end if;
    end process;

    stim : process
        variable play_ticks : integer;
        variable delay_hi   : integer;
        variable first_i    : integer;
        variable saw_arm    : boolean;
    begin
        wait for 20 ns;
        reset <= '0';
        wait until rising_edge(clock);

        -- ---------- 1. Обход: EN=0, play_en = MODE_PLAYER ----------
        mode_player <= '1';
        arm <= '1';
        wait until rising_edge(clock);
        assert play_en = '1' report "FAIL: bypass play_en" severity failure;
        assert capture_arm = '0' report "FAIL: bypass capture_arm idle" severity failure;
        host_cap_arm <= '1';
        wait until rising_edge(clock);
        assert capture_arm = '1' report "FAIL: bypass capture_arm follow" severity failure;
        host_cap_arm <= '0';
        mode_player <= '0';
        wait until rising_edge(clock);
        assert play_en = '0' report "FAIL: bypass play_en off" severity failure;

        -- ---------- 2. Хост-захват + DELAY=4, без walk ----------
        -- Грузим 8 сэмплов хостом (EN ещё 0 — capture_arm с хоста).
        mode_player <= '0';
        host_cap_arm <= '1';
        wait until rising_edge(clock);
        wait until rising_edge(clock);
        for k in 1 to 8 loop
            host_i <= to_signed(k * 10, 16);
            host_q <= to_signed(-k * 10, 16);
            host_valid <= '1';
            wait until rising_edge(clock);
            host_valid <= '0';
            wait until rising_edge(clock);
        end loop;
        wait until rising_edge(clock);
        assert capture_done = '1' report "FAIL: host capture_done" severity failure;
        host_cap_arm <= '0';
        wait until rising_edge(clock);

        delay_init <= to_unsigned(4, 32);
        walk_step  <= to_unsigned(0, 32);
        enable     <= '1';
        mode_player <= '1';
        wait until rising_edge(clock);
        -- IDLE → DELAY (capture_done уже 1)
        for k in 0 to 9 loop
            wait until rising_edge(clock);
            exit when wstate = LEGION_WALK_ST_DELAY;
        end loop;
        assert wstate = LEGION_WALK_ST_DELAY
            report "FAIL: not in DELAY after enable" severity failure;
        assert play_en = '0' report "FAIL: play_en during delay" severity failure;
        assert delaying = '1' report "FAIL: delaying flag" severity failure;

        -- 4 сэмпла × 2 такта (каденс) в DELAY, затем PLAY
        delay_hi := 0;
        while wstate = LEGION_WALK_ST_DELAY loop
            wait until rising_edge(clock);
            delay_hi := delay_hi + 1;
            exit when delay_hi > 40;
        end loop;
        assert wstate = LEGION_WALK_ST_PLAY
            report "FAIL: did not enter PLAY after delay" severity failure;
        assert play_en = '1' report "FAIL: play_en in PLAY" severity failure;
        assert delay_hi >= 7
            report "FAIL: delay too short (" & integer'image(delay_hi) & ")"
            severity failure;

        -- Один круг 8 сэмплов → STEP → DELAY (step=0, та же задержка)
        play_ticks := 0;
        for k in 0 to 80 loop
            wait until rising_edge(clock);
            if play_valid = '1' then
                play_ticks := play_ticks + 1;
            end if;
            exit when wstate = LEGION_WALK_ST_DELAY and play_en = '0';
        end loop;
        assert play_ticks = 8
            report "FAIL: play window not 8 samples, got " & integer'image(play_ticks)
            severity failure;
        assert cur_delay = to_unsigned(4, 32)
            report "FAIL: delay changed with step=0" severity failure;

        -- ---------- 3. Walk-off: step=3, два цикла ----------
        enable <= '0';
        wait until rising_edge(clock);
        wait until rising_edge(clock);
        walk_step  <= to_unsigned(3, 32);
        walk_max   <= to_unsigned(20, 32);
        delay_init <= to_unsigned(2, 32);
        enable     <= '1';
        wait until rising_edge(clock);
        for k in 0 to 8 loop
            wait until rising_edge(clock);
            exit when wstate = LEGION_WALK_ST_PLAY;
        end loop;
        assert cur_delay = to_unsigned(2, 32)
            report "FAIL: first delay not init" severity failure;
        -- дождаться STEP/следующего DELAY
        for k in 0 to 80 loop
            wait until rising_edge(clock);
            exit when wstate = LEGION_WALK_ST_DELAY and cur_delay = to_unsigned(5, 32);
        end loop;
        assert cur_delay = to_unsigned(5, 32)
            report "FAIL: walk-off did not add step 2+3" severity failure;

        -- ---------- 4. AUTO: det → capture FIFO → delay=0 → play ----------
        enable <= '0';
        arm <= '0';
        mode_player <= '0';
        wait until rising_edge(clock);
        wait until rising_edge(clock);
        reset <= '1';
        wait until rising_edge(clock);
        wait until rising_edge(clock);
        reset <= '0';
        wait until rising_edge(clock);

        delay_init <= to_unsigned(0, 32);
        walk_step  <= to_unsigned(1, 32);
        walk_max   <= to_unsigned(0, 32);
        auto       <= '1';
        enable     <= '1';
        arm        <= '1';
        mode_player <= '1';
        fifo_stock <= 16;
        wait until rising_edge(clock);
        wait until rising_edge(clock);
        assert wstate = LEGION_WALK_ST_WAIT_DET
            report "FAIL: AUTO not waiting detect" severity failure;
        assert lb_need = '1' report "FAIL: lb_need in AUTO" severity failure;
        assert play_en = '0' report "FAIL: play before detect" severity failure;

        det_active <= '1';
        saw_arm := false;
        for k in 0 to 80 loop
            wait until rising_edge(clock);
            if capture_arm = '1' then
                saw_arm := true;
            end if;
            exit when wstate = LEGION_WALK_ST_PLAY;
        end loop;
        assert saw_arm report "FAIL: AUTO never asserted capture_arm" severity failure;
        assert capture_done = '1' report "FAIL: AUTO capture_done" severity failure;
        assert wstate = LEGION_WALK_ST_PLAY
            report "FAIL: AUTO delay=0 did not reach PLAY" severity failure;
        assert play_en = '1' report "FAIL: AUTO play_en" severity failure;

        -- Первый сэмпл play — из FIFO (10, -10), не хост
        loop
            wait until rising_edge(clock);
            exit when play_valid = '1';
        end loop;
        first_i := to_integer(play_i);
        assert first_i = 10
            report "FAIL: AUTO play not from FIFO, I=" & integer'image(first_i)
            severity failure;

        -- После круга — STEP → WAIT_DET, delay стал 1
        for k in 0 to 80 loop
            wait until rising_edge(clock);
            exit when wstate = LEGION_WALK_ST_WAIT_DET;
        end loop;
        assert cur_delay = to_unsigned(1, 32)
            report "FAIL: AUTO walk-off step after first play" severity failure;
        assert play_en = '0' report "FAIL: play still on in WAIT_DET" severity failure;

        -- ---------- 5. DISARM гасит автомат (play_en = обход MODE_PLAYER) ----------
        arm <= '0';
        wait until rising_edge(clock);
        wait until rising_edge(clock);
        assert wstate = LEGION_WALK_ST_IDLE report "FAIL: DISARM not IDLE" severity failure;
        mode_player <= '0';
        wait until rising_edge(clock);
        assert play_en = '0' report "FAIL: play_en follows mode after DISARM" severity failure;

        report "legion_walkoff_tb: PASS" severity note;
        done <= true;
        wait;
    end process;
end architecture;
