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
        -- Домен RX (пороги детектора)
        rx_clock      : in  std_logic;
        rx_reset      : in  std_logic;
        rx_det_thr    : out std_logic_vector(31 downto 0);
        rx_det_shift  : out unsigned(3 downto 0);
        -- Статусные входы из TX/RX доменов
        tx_playing    : in  std_logic;
        tx_cap_done   : in  std_logic;
        tx_wd_fired   : in  std_logic;
        tx_lb_level   : in  unsigned(7 downto 0);
        tx_det_active : in  std_logic;
        tx_det_count  : in  unsigned(15 downto 0)
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

    -- CDC статуса обратно в 80 МГц
    signal st_meta, st_nios     : std_logic_vector(31 downto 0);
    signal status_tx            : std_logic_vector(31 downto 0);

    -- CDC порогов детектора → rx_clock
    signal thr_meta, thr_rx     : std_logic_vector(31 downto 0);
    signal sh_meta, sh_rx       : std_logic_vector(3 downto 0);
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
                    when LEGION_REG_WD_LIMIT   => r_wd_limit   <= pio_wdata(15 downto 0);
                    when LEGION_REG_WD_KICK    => kick_toggle  <= not kick_toggle;
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

    -- ---------------- Статус: сборка в tx_clock, CDC → 80 МГц ----------------
    status_tx(0)           <= tx_playing;
    status_tx(1)           <= tx_cap_done;
    status_tx(2)           <= tx_det_active;
    status_tx(3)           <= tx_wd_fired;
    status_tx(7 downto 4)  <= (others => '0');
    status_tx(15 downto 8) <= std_logic_vector(tx_lb_level);
    status_tx(31 downto 16) <= std_logic_vector(tx_det_count);

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
        elsif rising_edge(rx_clock) then
            thr_meta <= r_det_thr;   thr_rx <= thr_meta;
            sh_meta  <= r_det_shift; sh_rx  <= sh_meta;
        end if;
    end process;

    rx_det_thr   <= thr_rx;
    rx_det_shift <= unsigned(sh_rx);

    pio_status <= st_nios;
end architecture;
