-- Тестбенч legion_regs: запись регистров через PIO, CDC в tx_clock,
-- heartbeat-toggle → строб kick, статус обратно в NIOS-домен.
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
use work.legion_pkg.all;

entity legion_regs_tb is
end entity;

architecture tb of legion_regs_tb is
    signal nios_clk   : std_logic := '0';
    signal tx_clock   : std_logic := '0';
    signal nios_reset : std_logic := '1';
    signal tx_reset   : std_logic := '1';
    signal pio_addr   : std_logic_vector(6 downto 0) := (others => '0');
    signal pio_we     : std_logic := '0';
    signal pio_wdata  : std_logic_vector(31 downto 0) := (others => '0');
    signal pio_status : std_logic_vector(31 downto 0);
    signal tx_arm        : std_logic;
    signal tx_mode       : std_logic_vector(2 downto 0);
    signal tx_wd_en      : std_logic;
    signal tx_nco_ftw    : unsigned(31 downto 0);
    signal tx_lb_shift   : unsigned(3 downto 0);
    signal tx_wd_limit   : unsigned(15 downto 0);
    signal tx_player_len : unsigned(11 downto 0);
    signal tx_cap_arm    : std_logic;
    signal tx_wd_kick    : std_logic;
    signal tx_delay      : unsigned(31 downto 0);
    signal tx_walk_step  : unsigned(31 downto 0);
    signal tx_walk_max   : unsigned(31 downto 0);
    signal tx_walk_en    : std_logic;
    signal tx_walk_auto  : std_logic;
    signal tx_walk_hold  : std_logic;
    signal tx_lb_delay   : unsigned(11 downto 0);
    signal tx_lb_ftw     : unsigned(31 downto 0);
    signal tx_lb_delay1  : unsigned(11 downto 0);
    signal tx_lb_ftw1    : unsigned(31 downto 0);
    signal tx_lb_amp0    : unsigned(15 downto 0);
    signal tx_lb_amp1    : unsigned(15 downto 0);
    signal tx_walk_period : unsigned(31 downto 0);
    signal tx_walk_ftw_step : unsigned(31 downto 0);
    signal tx_proto_period : unsigned(31 downto 0);
    signal tx_proto_pulse  : unsigned(31 downto 0);
    signal tx_step_src     : std_logic;
    signal tx_ch_target    : unsigned(1 downto 0);
    signal tx_ch_bins      : std_logic_vector(31 downto 0);
    signal ch_e01          : std_logic_vector(31 downto 0) := x"00020001";
    signal ch_e23          : std_logic_vector(31 downto 0) := x"00040003";
    signal ch_bins         : std_logic_vector(31 downto 0) := x"C0A05010";
    signal ch_act          : std_logic_vector(3 downto 0) := "0101";
    signal walk_cur      : unsigned(31 downto 0) := to_unsigned(42, 32);
    signal rx_clock      : std_logic := '0';
    signal rx_reset      : std_logic := '1';
    signal det_cnt       : unsigned(15 downto 0) := x"00A5";
    signal peak_word     : std_logic_vector(31 downto 0) := x"81AB3410";
    signal rx_fft_en     : std_logic;
    signal rx_fft_notch  : std_logic;
    signal rx_fft_lock   : std_logic;
    signal done          : boolean := false;

    procedure write_reg(signal clk : in std_logic;
                        signal a   : out std_logic_vector(6 downto 0);
                        signal we  : out std_logic;
                        signal d   : out std_logic_vector(31 downto 0);
                        constant addr : in integer;
                        constant data : in natural) is
    begin
        a <= std_logic_vector(to_unsigned(addr, 7));
        d <= std_logic_vector(to_unsigned(data, 32));
        we <= '1';
        wait until rising_edge(clk);
        we <= '0';
        wait until rising_edge(clk);
    end procedure;
begin
    nios_clk <= not nios_clk after 6.25 ns when not done;  -- 80 МГц
    tx_clock <= not tx_clock after 5 ns when not done;     -- 100 МГц (модель)
    rx_clock <= not rx_clock after 7.1 ns when not done;   -- асинхронно к nios (x40)

    dut : entity work.legion_regs
        port map (
            nios_clk => nios_clk, nios_reset => nios_reset,
            pio_addr => pio_addr, pio_we => pio_we, pio_wdata => pio_wdata,
            pio_status => pio_status,
            tx_clock => tx_clock, tx_reset => tx_reset,
            tx_arm => tx_arm, tx_mode => tx_mode, tx_wd_en => tx_wd_en,
            tx_nco_ftw => tx_nco_ftw, tx_lb_shift => tx_lb_shift,
            tx_wd_limit => tx_wd_limit, tx_player_len => tx_player_len,
            tx_cap_arm => tx_cap_arm, tx_wd_kick => tx_wd_kick,
            tx_delay => tx_delay, tx_walk_step => tx_walk_step, tx_walk_max => tx_walk_max,
            tx_walk_en => tx_walk_en, tx_walk_auto => tx_walk_auto, tx_walk_hold => tx_walk_hold,
            tx_lb_delay => tx_lb_delay, tx_lb_ftw => tx_lb_ftw,
            tx_lb_delay1 => tx_lb_delay1, tx_lb_ftw1 => tx_lb_ftw1,
            tx_lb_amp0 => tx_lb_amp0, tx_lb_amp1 => tx_lb_amp1,
            tx_walk_period => tx_walk_period, tx_walk_ftw_step => tx_walk_ftw_step,
            tx_proto_period => tx_proto_period, tx_proto_pulse => tx_proto_pulse,
            tx_drfm_step_src => tx_step_src, tx_ch_target => tx_ch_target,
            tx_ch_bins => tx_ch_bins,
            rx_clock => rx_clock, rx_reset => rx_reset,
            rx_det_thr => open, rx_det_shift => open,
            rx_fft_en => rx_fft_en, rx_fft_dc_notch => rx_fft_notch,
            rx_fft_lock => rx_fft_lock,
            rx_peak_word => peak_word,
            rx_ch_energy01 => ch_e01, rx_ch_energy23 => ch_e23,
            rx_ch_bins => ch_bins, rx_ch_active => ch_act,
            tx_playing => '1', tx_cap_done => '1', tx_wd_fired => '0',
            tx_lb_level => x"2A", tx_det_active => '1', tx_det_count => det_cnt,
            tx_walk_state => "011", tx_walk_cur => walk_cur
        );

    stim : process
        variable kicked : boolean;
    begin
        kicked := false;
        wait for 30 ns;
        nios_reset <= '0';
        tx_reset <= '0';
        rx_reset <= '0';
        wait for 30 ns;

        -- CTRL: ARM(bit0)=1 + MODE(bits3:1)=PLAYER(001) + WD_EN(bit4)=1
        -- = 1 + 0b0010 + 0b10000 = 19
        write_reg(nios_clk, pio_addr, pio_we, pio_wdata, LEGION_REG_CTRL, 19);
        -- NCO FTW
        write_reg(nios_clk, pio_addr, pio_we, pio_wdata, LEGION_REG_NCO_FTW, 16#0ABCDEF0#);
        -- PLAYER_LEN = 1023
        write_reg(nios_clk, pio_addr, pio_we, pio_wdata, LEGION_REG_PLAYER_LEN, 1023);

        -- Ждём CDC (несколько тактов tx_clock)
        for k in 0 to 9 loop wait until rising_edge(tx_clock); end loop;
        assert tx_arm = '1' report "FAIL: ARM did not cross CDC" severity failure;
        assert tx_mode = "001" report "FAIL: MODE did not cross CDC" severity failure;
        assert tx_wd_en = '1' report "FAIL: WD_EN did not cross CDC" severity failure;
        assert tx_nco_ftw = x"0ABCDEF0" report "FAIL: FTW did not cross CDC" severity failure;
        assert tx_player_len = to_unsigned(1023, 12) report "FAIL: LEN did not cross CDC" severity failure;

        -- Heartbeat: запись в WD_KICK → toggle → строб kick в tx_clock домене
        write_reg(nios_clk, pio_addr, pio_we, pio_wdata, LEGION_REG_WD_KICK, 0);
        for k in 0 to 19 loop
            wait until rising_edge(tx_clock);
            if tx_wd_kick = '1' then kicked := true; end if;
        end loop;
        assert kicked report "FAIL: heartbeat strobe not generated" severity failure;

        -- WD_LIMIT=0 → кламп к 1 (иначе deadman молча выкл при WD_EN=1)
        write_reg(nios_clk, pio_addr, pio_we, pio_wdata, LEGION_REG_WD_LIMIT, 0);
        for k in 0 to 9 loop wait until rising_edge(tx_clock); end loop;
        assert tx_wd_limit = to_unsigned(1, 16)
            report "FAIL: WD_LIMIT=0 not clamped to 1" severity failure;

        -- Статус: CDC обратно в NIOS-домен
        for k in 0 to 9 loop wait until rising_edge(nios_clk); end loop;
        assert pio_status(0) = '1' report "FAIL: status.playing" severity failure;
        assert pio_status(1) = '1' report "FAIL: status.cap_done" severity failure;
        assert pio_status(2) = '1' report "FAIL: status.det_active" severity failure;
        assert pio_status(15 downto 8) = x"2A" report "FAIL: status.lb_level" severity failure;
        assert pio_status(31 downto 16) = x"00A5" report "FAIL: status.det_count" severity failure;

        -- Gray CDC: смена 00FF→0100 не даёт рваного 01FF/0000
        det_cnt <= x"00FF";
        for k in 0 to 15 loop wait until rising_edge(nios_clk); end loop;
        assert pio_status(31 downto 16) = x"00FF" report "FAIL: det_count 00FF after gray CDC" severity failure;
        det_cnt <= x"0100";
        for k in 0 to 15 loop wait until rising_edge(nios_clk); end loop;
        assert pio_status(31 downto 16) = x"0100" report "FAIL: det_count 0100 after gray CDC" severity failure;
        assert pio_status(31 downto 16) /= x"01FF" report "FAIL: torn det_count 01FF" severity failure;

        -- FFT_CTRL default 0; запись bit0+bit1 пересекает CDC в rx
        write_reg(nios_clk, pio_addr, pio_we, pio_wdata, LEGION_REG_FFT_CTRL, 3);
        for k in 0 to 9 loop wait until rising_edge(rx_clock); end loop;
        assert rx_fft_en = '1' and rx_fft_notch = '1' and rx_fft_lock = '0'
            report "FAIL: FFT_CTRL did not cross CDC" severity failure;
        write_reg(nios_clk, pio_addr, pio_we, pio_wdata, LEGION_REG_FFT_CTRL, 7);
        for k in 0 to 9 loop wait until rising_edge(rx_clock); end loop;
        assert rx_fft_en = '1' and rx_fft_notch = '1' and rx_fft_lock = '1'
            report "FAIL: FFT_CTRL lock did not cross CDC" severity failure;

        -- STATUS mux: addr=0x15, we=0 → слово пика, не det_count
        pio_addr <= std_logic_vector(to_unsigned(LEGION_REG_PEAK_BIN, 7));
        pio_we <= '0';
        for k in 0 to 9 loop wait until rising_edge(nios_clk); end loop;
        assert pio_status = peak_word
            report "FAIL: PEAK_BIN mux" severity failure;
        pio_addr <= (others => '0');
        for k in 0 to 5 loop wait until rising_edge(nios_clk); end loop;
        assert pio_status(2) = '1' report "FAIL: status restored after peak mux" severity failure;
        assert pio_status(7 downto 5) = "011" report "FAIL: walk state in STATUS" severity failure;
        assert pio_status(4) = '0' report "FAIL: bit4 must stay 0 for NIOS latch" severity failure;

        -- DELAY / WALK_* пересекают CDC
        write_reg(nios_clk, pio_addr, pio_we, pio_wdata, LEGION_REG_DELAY, 17);
        write_reg(nios_clk, pio_addr, pio_we, pio_wdata, LEGION_REG_WALK_STEP, 3);
        write_reg(nios_clk, pio_addr, pio_we, pio_wdata, LEGION_REG_WALK_MAX, 99);
        write_reg(nios_clk, pio_addr, pio_we, pio_wdata, LEGION_REG_WALK_CTL, 7);
        for k in 0 to 9 loop wait until rising_edge(tx_clock); end loop;
        assert tx_delay = to_unsigned(17, 32) report "FAIL: DELAY CDC" severity failure;
        assert tx_walk_step = to_unsigned(3, 32) report "FAIL: WALK_STEP CDC" severity failure;
        assert tx_walk_max = to_unsigned(99, 32) report "FAIL: WALK_MAX CDC" severity failure;
        assert tx_walk_en = '1' and tx_walk_auto = '1' and tx_walk_hold = '1'
            report "FAIL: WALK_CTL CDC" severity failure;

        -- STATUS mux 0x23 = текущая задержка
        pio_addr <= std_logic_vector(to_unsigned(LEGION_REG_WALK_CUR, 7));
        pio_we <= '0';
        for k in 0 to 9 loop wait until rising_edge(nios_clk); end loop;
        assert unsigned(pio_status) = to_unsigned(42, 32)
            report "FAIL: WALK_CUR mux" severity failure;

        -- Живой DRFM 0x24–0x2A. Сброс: A0≈1, A1=0.
        pio_addr <= (others => '0');
        for k in 0 to 9 loop wait until rising_edge(tx_clock); end loop;
        assert tx_lb_amp0 = x"7FFF" and tx_lb_amp1 = x"0000"
            report "FAIL: LB_AMP default A0=7FFF A1=0" severity failure;
        write_reg(nios_clk, pio_addr, pio_we, pio_wdata, LEGION_REG_LB_DELAY, 64);
        write_reg(nios_clk, pio_addr, pio_we, pio_wdata, LEGION_REG_LB_FTW, 16#00001000#);
        write_reg(nios_clk, pio_addr, pio_we, pio_wdata, LEGION_REG_LB_DELAY1, 128);
        write_reg(nios_clk, pio_addr, pio_we, pio_wdata, LEGION_REG_LB_FTW1, 16#00002000#);
        write_reg(nios_clk, pio_addr, pio_we, pio_wdata, LEGION_REG_LB_AMP, 16#40004000#);
        write_reg(nios_clk, pio_addr, pio_we, pio_wdata, LEGION_REG_WALK_PERIOD, 4096);
        write_reg(nios_clk, pio_addr, pio_we, pio_wdata, LEGION_REG_WALK_FTW_STEP, 3);
        for k in 0 to 9 loop wait until rising_edge(tx_clock); end loop;
        assert tx_lb_delay = to_unsigned(64, 12) report "FAIL: LB_DELAY CDC" severity failure;
        assert tx_lb_ftw = x"00001000" report "FAIL: LB_FTW CDC" severity failure;
        assert tx_lb_delay1 = to_unsigned(128, 12) report "FAIL: LB_DELAY1 CDC" severity failure;
        assert tx_lb_ftw1 = x"00002000" report "FAIL: LB_FTW1 CDC" severity failure;
        assert tx_lb_amp0 = x"4000" and tx_lb_amp1 = x"4000"
            report "FAIL: LB_AMP CDC" severity failure;
        assert tx_walk_period = to_unsigned(4096, 32) report "FAIL: WALK_PERIOD CDC" severity failure;
        assert tx_walk_ftw_step = to_unsigned(3, 32) report "FAIL: WALK_FTW_STEP CDC" severity failure;

        -- PROTO / CH_* : 0x24–0x2A не сдвинуты.
        write_reg(nios_clk, pio_addr, pio_we, pio_wdata, LEGION_REG_PROTO_PERIOD, 40000);
        write_reg(nios_clk, pio_addr, pio_we, pio_wdata, LEGION_REG_PROTO_PULSE, 58000);
        write_reg(nios_clk, pio_addr, pio_we, pio_wdata, LEGION_REG_DRFM_STEP_SRC, 1);
        write_reg(nios_clk, pio_addr, pio_we, pio_wdata, LEGION_REG_CH_TARGET, 2);
        for k in 0 to 9 loop wait until rising_edge(tx_clock); end loop;
        assert tx_proto_period = to_unsigned(40000, 32) report "FAIL: PROTO_PERIOD CDC" severity failure;
        assert tx_proto_pulse = to_unsigned(58000, 32) report "FAIL: PROTO_PULSE CDC" severity failure;
        assert tx_step_src = '1' report "FAIL: DRFM_STEP_SRC CDC" severity failure;
        assert tx_ch_target = to_unsigned(2, 2) report "FAIL: CH_TARGET CDC" severity failure;
        assert tx_ch_bins = ch_bins report "FAIL: CH_BINS rx→tx CDC" severity failure;

        pio_addr <= std_logic_vector(to_unsigned(LEGION_REG_CH_ACTIVE, 7));
        pio_we <= '0';
        for k in 0 to 9 loop wait until rising_edge(nios_clk); end loop;
        assert pio_status(3 downto 0) = ch_act report "FAIL: CH_ACTIVE mux" severity failure;
        pio_addr <= std_logic_vector(to_unsigned(LEGION_REG_CH_ENERGY01, 7));
        for k in 0 to 9 loop wait until rising_edge(nios_clk); end loop;
        assert pio_status = ch_e01 report "FAIL: CH_ENERGY01 mux" severity failure;
        pio_addr <= std_logic_vector(to_unsigned(LEGION_REG_CH_BINS, 7));
        for k in 0 to 9 loop wait until rising_edge(nios_clk); end loop;
        assert pio_status = ch_bins report "FAIL: CH_BINS mux" severity failure;

        report "legion_regs_tb: PASS" severity note;
        done <= true;
        wait;
    end process;
end architecture;
