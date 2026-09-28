-- ============================================================================
-- LEGION — регистровый блок (домен 80 МГц NIOS) + CDC в tx_clock/rx_clock.
-- Канал от хоста: NIOS 8x32-пакеты target 0x80 (зарезервирован Nuand под
-- пользовательские расширения) → NIOS пишет два PIO: addr+we и wdata.
-- CDC конфигурации — квазистатичная, двойной триггер (как rx_mux_sel в
-- bladerf-hosted.vhd). Статус собирается обратно тем же способом.
-- ============================================================================
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
use work.legion_pkg.all;

entity legion_regs is
    port (
        -- Домен NIOS (80 МГц)
        nios_clk      : in  std_logic;
        nios_reset    : in  std_logic;
        pio_addr      : in  std_logic_vector(6 downto 0);
        pio_we        : in  std_logic;
        pio_wdata     : in  std_logic_vector(31 downto 0);
        pio_status    : out std_logic_vector(31 downto 0);

        -- Домен TX
        tx_clock      : in  std_logic;
        tx_reset      : in  std_logic;
        tx_arm        : out std_logic;
        tx_mode       : out std_logic_vector(2 downto 0);
        tx_wd_en      : out std_logic;
        tx_nco_ftw    : out unsigned(31 downto 0);
        tx_lb_shift   : out unsigned(3 downto 0);
        tx_wd_limit   : out unsigned(15 downto 0);
        tx_player_len : out unsigned(11 downto 0);
        tx_cap_arm    : out std_logic;
        tx_wd_kick    : out std_logic;  -- строб heartbeat в tx_clock
        tx_delay      : out unsigned(31 downto 0);
        tx_walk_step  : out unsigned(31 downto 0);
        tx_walk_max   : out unsigned(31 downto 0);
        tx_walk_en    : out std_logic;
        tx_walk_auto  : out std_logic;
        tx_walk_hold  : out std_logic;
        tx_lb_delay   : out unsigned(11 downto 0);
        tx_lb_ftw     : out unsigned(31 downto 0);
        tx_lb_delay1  : out unsigned(11 downto 0);
        tx_lb_ftw1    : out unsigned(31 downto 0);
        tx_lb_amp0    : out unsigned(15 downto 0);
        tx_lb_amp1    : out unsigned(15 downto 0);
        tx_walk_period : out unsigned(31 downto 0);
        tx_walk_ftw_step : out unsigned(31 downto 0);
        tx_proto_period : out unsigned(31 downto 0);
        tx_proto_pulse  : out unsigned(31 downto 0);
        tx_drfm_step_src : out std_logic;
        tx_ch_target    : out unsigned(7 downto 0);
        -- Домен RX (пороги детектора)
        rx_clock      : in  std_logic;
        rx_reset      : in  std_logic;
        rx_det_thr    : out std_logic_vector(31 downto 0);
        rx_det_shift  : out unsigned(3 downto 0);
        rx_fft_en     : out std_logic;
        rx_fft_dc_notch : out std_logic;
        rx_fft_lock   : out std_logic;
        rx_ch_fs_hz   : out unsigned(31 downto 0);
        rx_ch_lo_khz  : out unsigned(31 downto 0);
        rx_peak_word  : in  std_logic_vector(31 downto 0);
        rx_ch_energy  : in  legion_ch_energy_t;
        rx_ch_bins    : in  std_logic_vector(63 downto 0);
        rx_ch_active  : in  std_logic_vector(7 downto 0);
        -- Статусные входы из TX/RX доменов
        tx_playing    : in  std_logic;
        tx_cap_done   : in  std_logic;
        tx_wd_fired   : in  std_logic;
        tx_lb_level   : in  unsigned(7 downto 0);
        tx_det_active : in  std_logic;
        tx_det_count  : in  unsigned(15 downto 0);
        tx_walk_state : in  std_logic_vector(2 downto 0);
        tx_walk_cur   : in  unsigned(31 downto 0)
    );
end entity;

architecture rtl of legion_regs is
    -- Регистры в домене NIOS
    signal r_ctrl       : std_logic_vector(31 downto 0);
    signal r_nco_ftw    : std_logic_vector(31 downto 0);
    signal r_det_thr    : std_logic_vector(31 downto 0);
    signal r_det_shift  : std_logic_vector(3 downto 0);
    signal r_player_len : std_logic_vector(11 downto 0);
    signal r_cap_arm    : std_logic;
    signal r_lb_shift   : std_logic_vector(3 downto 0);
    signal r_wd_limit   : std_logic_vector(15 downto 0);
    signal r_fft_ctrl   : std_logic_vector(2 downto 0);
    signal r_delay      : std_logic_vector(31 downto 0);
    signal r_walk_step  : std_logic_vector(31 downto 0);
    signal r_walk_max   : std_logic_vector(31 downto 0);
    signal r_walk_ctl   : std_logic_vector(2 downto 0);
    signal r_lb_delay   : std_logic_vector(11 downto 0);
    signal r_lb_ftw     : std_logic_vector(31 downto 0);
    signal r_lb_delay1  : std_logic_vector(11 downto 0);
    signal r_lb_ftw1    : std_logic_vector(31 downto 0);
    signal r_lb_amp     : std_logic_vector(31 downto 0);
    signal r_walk_period : std_logic_vector(31 downto 0);
    signal r_walk_ftw_step : std_logic_vector(31 downto 0);
    signal r_proto_period : std_logic_vector(31 downto 0);
    signal r_proto_pulse  : std_logic_vector(31 downto 0);
    signal r_step_src     : std_logic;
    signal r_ch_target    : std_logic_vector(7 downto 0);
    signal r_ch_fs        : std_logic_vector(31 downto 0);
    signal r_ch_lo        : std_logic_vector(31 downto 0);

    -- CDC в tx_clock (квазистатичные — двойной триггер, паттерн Nuand)
    signal ctrl_meta, ctrl_tx   : std_logic_vector(31 downto 0);
    signal ftw_meta, ftw_tx     : std_logic_vector(31 downto 0);
    signal len_meta, len_tx     : std_logic_vector(11 downto 0);
    signal lbs_meta, lbs_tx     : std_logic_vector(3 downto 0);
    signal wdl_meta, wdl_tx     : std_logic_vector(15 downto 0);
    -- heartbeat: toggle в домене NIOS → фронт в домене tx_clock
    signal kick_toggle          : std_logic;
    signal kick_meta, kick_tx   : std_logic;
    signal kick_tx_d            : std_logic;
    signal cap_meta, cap_tx     : std_logic;
    signal dly_meta, dly_tx     : std_logic_vector(31 downto 0);
    signal wst_meta, wst_tx     : std_logic_vector(31 downto 0);
    signal wmx_meta, wmx_tx     : std_logic_vector(31 downto 0);
    signal wct_meta, wct_tx     : std_logic_vector(2 downto 0);
    signal lbd_meta, lbd_tx     : std_logic_vector(11 downto 0);
    signal lbf_meta, lbf_tx     : std_logic_vector(31 downto 0);
    signal lbd1_meta, lbd1_tx   : std_logic_vector(11 downto 0);
    signal lbf1_meta, lbf1_tx   : std_logic_vector(31 downto 0);
    signal lba_meta, lba_tx     : std_logic_vector(31 downto 0);
    signal wper_meta, wper_tx   : std_logic_vector(31 downto 0);
    signal wfs_meta, wfs_tx     : std_logic_vector(31 downto 0);
    signal pper_meta, pper_tx   : std_logic_vector(31 downto 0);
    signal ppul_meta, ppul_tx   : std_logic_vector(31 downto 0);
    signal src_meta, src_tx     : std_logic;
    signal cht_meta, cht_tx     : std_logic_vector(7 downto 0);

    -- CDC статуса обратно в 80 МГц
    signal st_meta, st_nios     : std_logic_vector(31 downto 0);
    signal status_tx            : std_logic_vector(31 downto 0);

    -- CDC порогов детектора → rx_clock
    signal thr_meta, thr_rx     : std_logic_vector(31 downto 0);
    signal sh_meta, sh_rx       : std_logic_vector(3 downto 0);
    signal fft_meta, fft_rx     : std_logic_vector(2 downto 0);
    signal pk_meta, pk_nios     : std_logic_vector(31 downto 0);
    signal wcur_meta, wcur_nios : std_logic_vector(31 downto 0);
    signal e_meta, e_nios       : legion_ch_energy_t;
    signal bins_meta, bins_nios : std_logic_vector(63 downto 0);
    signal act_meta, act_nios   : std_logic_vector(7 downto 0);
    signal fs_meta, fs_rx       : std_logic_vector(31 downto 0);
    signal lo_meta, lo_rx       : std_logic_vector(31 downto 0);

    -- det_count: gray CDC rx → nios (x40 rx_clock ≠ nios_clk; micro совпадают)
    signal det_gray_rx   : std_logic_vector(15 downto 0);
    signal det_gray_meta : std_logic_vector(15 downto 0);
    signal det_gray_nios : std_logic_vector(15 downto 0);

    function bin2gray(b : std_logic_vector) return std_logic_vector is
    begin
        return b xor ('0' & b(b'high downto b'low + 1));
    end function;

    function gray2bin(g : std_logic_vector) return std_logic_vector is
        variable b : std_logic_vector(g'range);
    begin
        b(g'high) := g(g'high);
        for i in g'high - 1 downto g'low loop
            b(i) := b(i + 1) xor g(i);
        end loop;
        return b;
    end function;
begin

    -- ---------------- Запись регистров (80 МГц) ----------------
    regs : process(nios_clk, nios_reset)
    begin
        if nios_reset = '1' then
            r_ctrl       <= (others => '0');
            r_nco_ftw    <= (others => '0');
            r_det_thr    <= (others => '0');
            r_det_shift  <= x"8";           -- окно 256 по умолчанию
            r_player_len <= x"FFF";         -- 4096 по умолчанию
            r_cap_arm    <= '0';
            r_lb_shift   <= (others => '0');
            r_wd_limit   <= x"003D";        -- 61 × 16.4 мс ≈ 1 с
            r_fft_ctrl   <= "000";          -- FFT выкл: walker как раньше
            r_delay      <= (others => '0');
            r_walk_step  <= (others => '0');
            r_walk_max   <= (others => '0');
            r_walk_ctl   <= "000";
            r_lb_delay   <= (others => '0');
            r_lb_ftw     <= (others => '0');
            r_lb_delay1  <= (others => '0');
            r_lb_ftw1    <= (others => '0');
            r_lb_amp     <= x"00007FFF"; -- A0≈1.0, A1=0: один отвод, mux даст 0.9
            r_walk_period <= (others => '0');
            r_walk_ftw_step <= (others => '0');
            r_proto_period <= (others => '0');
            r_proto_pulse  <= (others => '0');
            r_step_src     <= '0';
            r_ch_target    <= (others => '0');
            r_ch_fs        <= (others => '0');
            r_ch_lo        <= (others => '0');
            kick_toggle  <= '0';
        elsif rising_edge(nios_clk) then
            if pio_we = '1' then
                case to_integer(unsigned(pio_addr)) is
                    when LEGION_REG_CTRL       => r_ctrl       <= pio_wdata;
                    when LEGION_REG_NCO_FTW    => r_nco_ftw    <= pio_wdata;
                    when LEGION_REG_DET_THR    => r_det_thr    <= pio_wdata;
                    when LEGION_REG_DET_SHIFT  => r_det_shift  <= pio_wdata(3 downto 0);
                    when LEGION_REG_PLAYER_LEN => r_player_len <= pio_wdata(11 downto 0);
                    when LEGION_REG_PLAYER_CTL => r_cap_arm    <= pio_wdata(0);
                    when LEGION_REG_LB_SHIFT   => r_lb_shift   <= pio_wdata(3 downto 0);
                    -- limit=0 при WD_EN=1 молча отключал бы deadman
                    -- (65535×65536 тактов ≈ «никогда») — кламп к ≥1
                    when LEGION_REG_WD_LIMIT   =>
                        if pio_wdata(15 downto 0) = x"0000" then
                            r_wd_limit <= x"0001";
                        else
                            r_wd_limit <= pio_wdata(15 downto 0);
                        end if;
                    when LEGION_REG_WD_KICK    => kick_toggle  <= not kick_toggle;
                    when LEGION_REG_FFT_CTRL   => r_fft_ctrl   <= pio_wdata(2 downto 0);
                    when LEGION_REG_DELAY      => r_delay      <= pio_wdata;
                    when LEGION_REG_WALK_STEP  => r_walk_step  <= pio_wdata;
                    when LEGION_REG_WALK_MAX   => r_walk_max   <= pio_wdata;
                    when LEGION_REG_WALK_CTL   => r_walk_ctl   <= pio_wdata(2 downto 0);
                    when LEGION_REG_LB_DELAY   => r_lb_delay   <= pio_wdata(11 downto 0);
                    when LEGION_REG_LB_FTW     => r_lb_ftw     <= pio_wdata;
                    when LEGION_REG_LB_DELAY1  => r_lb_delay1  <= pio_wdata(11 downto 0);
                    when LEGION_REG_LB_FTW1    => r_lb_ftw1    <= pio_wdata;
                    when LEGION_REG_LB_AMP     => r_lb_amp     <= pio_wdata;
                    when LEGION_REG_WALK_PERIOD => r_walk_period <= pio_wdata;
                    when LEGION_REG_WALK_FTW_STEP => r_walk_ftw_step <= pio_wdata;
                    when LEGION_REG_PROTO_PERIOD => r_proto_period <= pio_wdata;
                    when LEGION_REG_PROTO_PULSE => r_proto_pulse <= pio_wdata;
                    when LEGION_REG_DRFM_STEP_SRC => r_step_src <= pio_wdata(0);
                    when LEGION_REG_CH_TARGET => r_ch_target <= pio_wdata(7 downto 0);
                    when LEGION_REG_CH_FS_HZ  => r_ch_fs     <= pio_wdata;
                    when LEGION_REG_CH_LO_KHZ => r_ch_lo     <= pio_wdata;
                    when others => null;
                end case;
            end if;
        end if;
    end process;

    -- ---------------- CDC конфигурации → tx_clock ----------------
    cdc_tx : process(tx_clock, tx_reset)
    begin
        if tx_reset = '1' then
            ctrl_meta <= (others => '0'); ctrl_tx <= (others => '0');
            ftw_meta  <= (others => '0'); ftw_tx  <= (others => '0');
            len_meta  <= (others => '0'); len_tx  <= (others => '0');
            lbs_meta  <= (others => '0'); lbs_tx  <= (others => '0');
            wdl_meta  <= (others => '0'); wdl_tx  <= (others => '0');
            kick_meta <= '0'; kick_tx <= '0'; kick_tx_d <= '0';
            cap_meta  <= '0'; cap_tx  <= '0';
            dly_meta  <= (others => '0'); dly_tx <= (others => '0');
            wst_meta  <= (others => '0'); wst_tx <= (others => '0');
            wmx_meta  <= (others => '0'); wmx_tx <= (others => '0');
            wct_meta  <= (others => '0'); wct_tx <= (others => '0');
            lbd_meta  <= (others => '0'); lbd_tx <= (others => '0');
            lbf_meta  <= (others => '0'); lbf_tx <= (others => '0');
            lbd1_meta <= (others => '0'); lbd1_tx <= (others => '0');
            lbf1_meta <= (others => '0'); lbf1_tx <= (others => '0');
            lba_meta  <= (others => '0'); lba_tx <= (others => '0');
            wper_meta <= (others => '0'); wper_tx <= (others => '0');
            wfs_meta  <= (others => '0'); wfs_tx <= (others => '0');
            pper_meta <= (others => '0'); pper_tx <= (others => '0');
            ppul_meta <= (others => '0'); ppul_tx <= (others => '0');
            src_meta  <= '0'; src_tx <= '0';
            cht_meta  <= (others => '0'); cht_tx <= (others => '0');
        elsif rising_edge(tx_clock) then
            ctrl_meta <= r_ctrl;       ctrl_tx <= ctrl_meta;
            ftw_meta  <= r_nco_ftw;    ftw_tx  <= ftw_meta;
            len_meta  <= r_player_len; len_tx  <= len_meta;
            lbs_meta  <= r_lb_shift;   lbs_tx  <= lbs_meta;
            wdl_meta  <= r_wd_limit;   wdl_tx  <= wdl_meta;
            -- heartbeat: toggle → синхронизация → детект фронта
            kick_meta <= kick_toggle;
            kick_tx   <= kick_meta;
            kick_tx_d <= kick_tx;
            -- capture_arm: квазистатик, но плеер ловит фронт — двойной триггер
            cap_meta  <= r_cap_arm;
            cap_tx    <= cap_meta;
            dly_meta  <= r_delay;      dly_tx  <= dly_meta;
            wst_meta  <= r_walk_step;  wst_tx  <= wst_meta;
            wmx_meta  <= r_walk_max;   wmx_tx  <= wmx_meta;
            wct_meta  <= r_walk_ctl;   wct_tx  <= wct_meta;
            lbd_meta  <= r_lb_delay;   lbd_tx  <= lbd_meta;
            lbf_meta  <= r_lb_ftw;     lbf_tx  <= lbf_meta;
            lbd1_meta <= r_lb_delay1;  lbd1_tx <= lbd1_meta;
            lbf1_meta <= r_lb_ftw1;    lbf1_tx <= lbf1_meta;
            lba_meta  <= r_lb_amp;     lba_tx  <= lba_meta;
            wper_meta <= r_walk_period; wper_tx <= wper_meta;
            wfs_meta  <= r_walk_ftw_step; wfs_tx <= wfs_meta;
            pper_meta <= r_proto_period; pper_tx <= pper_meta;
            ppul_meta <= r_proto_pulse;  ppul_tx <= ppul_meta;
            src_meta  <= r_step_src;     src_tx  <= src_meta;
            cht_meta  <= r_ch_target;    cht_tx  <= cht_meta;
        end if;
    end process;

    tx_arm        <= ctrl_tx(0);
    tx_mode       <= ctrl_tx(3 downto 1);
    tx_wd_en      <= ctrl_tx(4);
    tx_nco_ftw    <= unsigned(ftw_tx);
    tx_lb_shift   <= unsigned(lbs_tx);
    tx_wd_limit   <= unsigned(wdl_tx);
    tx_player_len <= unsigned(len_tx);
    tx_cap_arm    <= cap_tx;
    tx_wd_kick    <= kick_tx and not kick_tx_d;
    tx_delay      <= unsigned(dly_tx);
    tx_walk_step  <= unsigned(wst_tx);
    tx_walk_max   <= unsigned(wmx_tx);
    tx_walk_en    <= wct_tx(0);
    tx_walk_auto  <= wct_tx(1);
    tx_walk_hold  <= wct_tx(2);
    tx_lb_delay   <= unsigned(lbd_tx);
    tx_lb_ftw     <= unsigned(lbf_tx);
    tx_lb_delay1  <= unsigned(lbd1_tx);
    tx_lb_ftw1    <= unsigned(lbf1_tx);
    tx_lb_amp0    <= unsigned(lba_tx(15 downto 0));
    tx_lb_amp1    <= unsigned(lba_tx(31 downto 16));
    tx_walk_period <= unsigned(wper_tx);
    tx_walk_ftw_step <= unsigned(wfs_tx);
    tx_proto_period <= unsigned(pper_tx);
    tx_proto_pulse  <= unsigned(ppul_tx);
    tx_drfm_step_src <= src_tx;
    tx_ch_target    <= unsigned(cht_tx);

    -- ---------------- Статус: сборка в tx_clock, CDC → 80 МГц ----------------
    -- det_count — gray CDC из rx-домена в nios (не 2FF целого слова).
    -- Остальные статус-биты квазистатичны / однобитные.
    status_tx(0)           <= tx_playing;
    status_tx(1)           <= tx_cap_done;
    status_tx(2)           <= tx_det_active;
    status_tx(3)           <= tx_wd_fired;
    status_tx(4)           <= '0';  -- NIOS подмешивает wd_latch
    status_tx(7 downto 5)  <= tx_walk_state;
    status_tx(15 downto 8) <= std_logic_vector(tx_lb_level);
    status_tx(31 downto 16) <= (others => '0');

    cdc_status : process(nios_clk, nios_reset)
    begin
        if nios_reset = '1' then
            st_meta <= (others => '0');
            st_nios <= (others => '0');
        elsif rising_edge(nios_clk) then
            st_meta <= status_tx;
            st_nios <= st_meta;
        end if;
    end process;

    -- ---------------- CDC порогов → rx_clock ----------------
    cdc_rx : process(rx_clock, rx_reset)
    begin
        if rx_reset = '1' then
            thr_meta <= (others => '0'); thr_rx <= (others => '0');
            sh_meta  <= (others => '0'); sh_rx  <= (others => '0');
            fft_meta <= (others => '0'); fft_rx <= (others => '0');
            fs_meta  <= (others => '0'); fs_rx  <= (others => '0');
            lo_meta  <= (others => '0'); lo_rx  <= (others => '0');
        elsif rising_edge(rx_clock) then
            thr_meta <= r_det_thr;   thr_rx <= thr_meta;
            sh_meta  <= r_det_shift; sh_rx  <= sh_meta;
            fft_meta <= r_fft_ctrl;  fft_rx <= fft_meta;
            fs_meta  <= r_ch_fs;     fs_rx  <= fs_meta;
            lo_meta  <= r_ch_lo;     lo_rx  <= lo_meta;
        end if;
    end process;

    rx_det_thr      <= thr_rx;
    rx_det_shift    <= unsigned(sh_rx);
    rx_fft_en       <= fft_rx(0);
    rx_fft_dc_notch <= fft_rx(1);
    rx_fft_lock     <= fft_rx(2);
    rx_ch_fs_hz     <= unsigned(fs_rx);
    rx_ch_lo_khz    <= unsigned(lo_rx);

    -- det_count: зарегистрировать gray в rx, 2FF в nios, раскодировать
    cdc_det_src : process(rx_clock, rx_reset)
    begin
        if rx_reset = '1' then
            det_gray_rx <= (others => '0');
        elsif rising_edge(rx_clock) then
            det_gray_rx <= bin2gray(std_logic_vector(tx_det_count));
        end if;
    end process;

    cdc_det_dst : process(nios_clk, nios_reset)
    begin
        if nios_reset = '1' then
            det_gray_meta <= (others => '0');
            det_gray_nios <= (others => '0');
        elsif rising_edge(nios_clk) then
            det_gray_meta <= det_gray_rx;
            det_gray_nios <= det_gray_meta;
        end if;
    end process;

    -- Пик FFT: 2FF rx→nios. Слово квазистатично между кадрами (~80 µs).
    cdc_peak : process(nios_clk, nios_reset)
    begin
        if nios_reset = '1' then
            pk_meta   <= (others => '0');
            pk_nios   <= (others => '0');
            e_meta    <= (others => (others => '0'));
            e_nios    <= (others => (others => '0'));
            bins_meta <= (others => '0');
            bins_nios <= (others => '0');
            act_meta  <= (others => '0');
            act_nios  <= (others => '0');
        elsif rising_edge(nios_clk) then
            pk_meta   <= rx_peak_word;
            pk_nios   <= pk_meta;
            e_meta    <= rx_ch_energy;
            e_nios    <= e_meta;
            bins_meta <= rx_ch_bins;
            bins_nios <= bins_meta;
            act_meta  <= rx_ch_active;
            act_nios  <= act_meta;
        end if;
    end process;

    -- Текущая задержка walk-off: квазистатична между циклами play.
    cdc_walk_cur : process(nios_clk, nios_reset)
    begin
        if nios_reset = '1' then
            wcur_meta <= (others => '0');
            wcur_nios <= (others => '0');
        elsif rising_edge(nios_clk) then
            wcur_meta <= std_logic_vector(tx_walk_cur);
            wcur_nios <= wcur_meta;
        end if;
    end process;

    -- Чтение 0x15: IOWR(AWS,0x15) we=0 → STATUS = peak.
    -- Чтение 0x23: текущая задержка walk-off.
    -- Карта: ACTIVE_0 / ENERGY_0..7 / BINS_03 / BINS_47.
    -- we=1 или другой addr — прежний STATUS (бит 4 = 0 в HDL).
    status_mux : process(pio_we, pio_addr, pk_nios, wcur_nios, act_nios,
                         e_nios, bins_nios, det_gray_nios, st_nios)
        variable a : integer;
    begin
        a := to_integer(unsigned(pio_addr));
        if pio_we = '0' and a = LEGION_REG_PEAK_BIN then
            pio_status <= pk_nios;
        elsif pio_we = '0' and a = LEGION_REG_WALK_CUR then
            pio_status <= wcur_nios;
        elsif pio_we = '0' and a = LEGION_REG_CH_ACTIVE_0 then
            pio_status <= x"000000" & act_nios;
        elsif pio_we = '0' and a >= LEGION_REG_CH_ENERGY_0 and
              a <= LEGION_REG_CH_ENERGY_7 then
            pio_status <= e_nios(a - LEGION_REG_CH_ENERGY_0);
        elsif pio_we = '0' and a = LEGION_REG_CH_BINS_03 then
            pio_status <= bins_nios(31 downto 0);
        elsif pio_we = '0' and a = LEGION_REG_CH_BINS_47 then
            pio_status <= bins_nios(63 downto 32);
        else
            pio_status <= gray2bin(det_gray_nios) & st_nios(15 downto 0);
        end if;
    end process;
end architecture;
