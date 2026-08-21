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
            rx_clock => nios_clk, rx_reset => nios_reset,
            rx_det_thr => open, rx_det_shift => open,
            tx_playing => '1', tx_cap_done => '1', tx_wd_fired => '0',
            tx_lb_level => x"2A", tx_det_active => '1', tx_det_count => x"00A5"
        );

    stim : process
        variable kicked : boolean;
    begin
        kicked := false;
        wait for 30 ns;
        nios_reset <= '0';
        tx_reset <= '0';
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

        -- Статус: CDC обратно в NIOS-домен
        for k in 0 to 9 loop wait until rising_edge(nios_clk); end loop;
        assert pio_status(0) = '1' report "FAIL: status.playing" severity failure;
        assert pio_status(1) = '1' report "FAIL: status.cap_done" severity failure;
        assert pio_status(2) = '1' report "FAIL: status.det_active" severity failure;
        assert pio_status(15 downto 8) = x"2A" report "FAIL: status.lb_level" severity failure;
        assert pio_status(31 downto 16) = x"00A5" report "FAIL: status.det_count" severity failure;

        report "legion_regs_tb: PASS" severity note;
        done <= true;
        wait;
    end process;
end architecture;
