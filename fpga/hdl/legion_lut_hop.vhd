-- ============================================================================
-- LEGION — таймер индекса HOP_LUT 0x5E (шаги 1–3).
-- Хост пишет HOP_LUT 0x5E (последовательность каналов) и GRID:
--   PRI_US 0x54 — период одного хопа, мкс
--   FLAGS  0x56 — bit4 AUTONOMOUS
--   RSV    0x57 — стартовая фаза (индекс)
--   META   0x51 — n / n_used (8 бит); n_eff = n_used если ≠0, иначе n
--   F0/STEP/SHIFT/FS/LO — FTW = (f0 + ch·step + shift − lo) / fs · 2^32
-- Каденс — сэмпл TX (каждый 2-й tx_clock), как look-through / walk-off.
-- hop_tick — '1' один tx_clock в такт idx++ (граница dwell). Не reload из RSV.
-- PROTO_PERIOD — запасной период в сэмплах, если PRI_US=0 или fs=0.
-- Без AUTONOMOUS или при n_eff=0 индекс не шагает; FTW держит 0.
--
-- Деление периода и RSV mod n_eff — legion_divider (64 такта, не "/").
-- Умножения pri·fs, f0·1000, lo·1000, ch·step — legion_mult (32 такта, не "*").
-- FTW — свой последовательный делитель (32 такта, mag·2^32/fs_ftw).
-- fs_ftw — копия fs, захваченная на старте FTW (не fs_q периода).
-- Домен: только tx_clock (= pll_sclk). Входов с других клоков нет:
-- legion_regs даёт уже 2FF-синхронизированные GRID/FS/LO/HOP_LUT.
-- CH_LUT 0x31 — только RX-канализатор, сюда не приходит.
-- ============================================================================
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
use work.legion_pkg.all;

entity legion_lut_hop is
    port (
        clk          : in  std_logic;
        reset        : in  std_logic;
        pri_us       : in  unsigned(31 downto 0);
        flags        : in  std_logic_vector(31 downto 0);
        meta         : in  std_logic_vector(31 downto 0);
        f0           : in  unsigned(31 downto 0);
        step_hz      : in  unsigned(31 downto 0);
        shift_hz     : in  signed(31 downto 0);
        rsv          : in  unsigned(7 downto 0);
        proto_period : in  unsigned(31 downto 0);
        fs_hz        : in  unsigned(31 downto 0);
        lo_khz       : in  unsigned(31 downto 0);
        lut_we       : in  std_logic;
        lut_addr     : in  unsigned(7 downto 0);
        lut_data     : in  unsigned(7 downto 0);
        hop_auto     : out std_logic;
        hop_ch       : out unsigned(7 downto 0);
        hop_ftw      : out unsigned(31 downto 0);
        hop_tick     : out std_logic
    );
end entity;

architecture rtl of legion_lut_hop is
    type lut_t is array (0 to 255) of unsigned(7 downto 0);
    type div_sel_t is (DIV_PERIOD, DIV_MOD);
    type mult_sel_t is (MULT_PERIOD, MULT_F0, MULT_LO, MULT_CH);

    signal lut        : lut_t;
    signal samp_ph    : std_logic;
    signal idx        : unsigned(7 downto 0);
    signal cnt        : unsigned(31 downto 0);
    signal period     : unsigned(31 downto 0);
    signal n_eff      : unsigned(7 downto 0);
    signal auto_r     : std_logic;
    signal ch_r       : unsigned(7 downto 0);
    signal ftw_r      : unsigned(31 downto 0);
    signal pri_q      : unsigned(31 downto 0);
    signal fs_q       : unsigned(31 downto 0);
    signal proto_q    : unsigned(31 downto 0);
    signal rsv_q      : unsigned(7 downto 0);
    signal n_q        : unsigned(7 downto 0);
    signal shift_q    : signed(31 downto 0);

    signal prod_r     : unsigned(63 downto 0);
    signal pend_period : std_logic;
    signal pend_mod    : std_logic;
    signal pend_mult_p : std_logic;
    signal pend_ftw_f0 : std_logic;
    signal pend_ftw_lo : std_logic;
    signal pend_ftw_ch : std_logic;
    signal div_lock    : std_logic;
    signal start_div   : std_logic;
    signal inflight    : div_sel_t;
    signal div_dividend : unsigned(63 downto 0);
    signal div_divisor  : unsigned(31 downto 0);
    signal div_q      : unsigned(31 downto 0);
    signal div_rem    : unsigned(31 downto 0);
    signal div_valid  : std_logic;
    signal div_busy   : std_logic;

    signal start_mult : std_logic;
    signal mult_lock  : std_logic;
    signal minflight  : mult_sel_t;
    signal mult_a     : unsigned(31 downto 0);
    signal mult_b     : unsigned(31 downto 0);
    signal mult_p     : unsigned(63 downto 0);
    signal mult_valid : std_logic;
    signal mult_busy  : std_logic;
    signal f0_hz_r    : unsigned(39 downto 0);
    signal lo_hz_r    : unsigned(39 downto 0);

    signal ftw_busy   : std_logic;
    signal ftw_bit    : integer range 0 to 31;
    signal ftw_rem    : unsigned(63 downto 0);
    signal ftw_q      : unsigned(31 downto 0);
    signal ftw_neg    : std_logic;
    signal need_ftw   : std_logic;
    signal f0_q       : unsigned(31 downto 0);
    signal step_q     : unsigned(31 downto 0);
    signal lo_q       : unsigned(31 downto 0);
    signal fs_ftw     : unsigned(31 downto 0);
    signal ch_div     : unsigned(7 downto 0);
    signal hop_tick_r : std_logic;
begin
    -- n_eff: n_used (meta[15:8]) если задан, иначе n (meta[7:0]).
    n_eff <= unsigned(meta(15 downto 8)) when unsigned(meta(15 downto 8)) /= 0
             else unsigned(meta(7 downto 0));

    hop_auto <= auto_r;
    hop_ch   <= ch_r;
    hop_ftw  <= ftw_r;
    hop_tick <= hop_tick_r;

    U_div : entity work.legion_divider
        generic map (
            DIVIDEND_W => 64,
            DIVISOR_W  => 32,
            QUOTIENT_W => 32
        )
        port map (
            clk      => clk,
            reset    => reset,
            start    => start_div,
            dividend => div_dividend,
            divisor  => div_divisor,
            quotient => div_q,
            remain   => div_rem,
            valid    => div_valid,
            busy     => div_busy
        );

    -- 32 такта: pri·fs, f0·1000, lo·1000, ch·step. Не оператор "*".
    U_mult : entity work.legion_mult
        generic map (
            A_W => 32,
            B_W => 32,
            P_W => 64
        )
        port map (
            clk     => clk,
            reset   => reset,
            start   => start_mult,
            a       => mult_a,
            b       => mult_b,
            product => mult_p,
            valid   => mult_valid,
            busy    => mult_busy
        );

    process(clk, reset)
        variable auto_v   : std_logic;
        variable nxt      : unsigned(8 downto 0);
        variable f_rf     : unsigned(39 downto 0);
        variable diff     : signed(41 downto 0);
        variable mag      : unsigned(39 downto 0);
        variable tmp      : unsigned(63 downto 0);
        variable cmp      : unsigned(31 downto 0);
        variable qv       : unsigned(31 downto 0);
        variable reload     : boolean;
        variable period_upd : boolean;
    begin
        if reset = '1' then
            for i in 0 to 255 loop
                lut(i) <= to_unsigned(i, 8);
            end loop;
            samp_ph      <= '0';
            idx          <= (others => '0');
            cnt          <= (others => '0');
            period       <= (others => '0');
            auto_r       <= '0';
            ch_r         <= (others => '0');
            ftw_r        <= (others => '0');
            pri_q        <= (others => '0');
            fs_q         <= (others => '0');
            proto_q      <= (others => '0');
            rsv_q        <= (others => '0');
            n_q          <= (others => '0');
            shift_q      <= (others => '0');
            prod_r       <= (others => '0');
            pend_period  <= '0';
            pend_mod     <= '0';
            pend_mult_p  <= '0';
            pend_ftw_f0  <= '0';
            pend_ftw_lo  <= '0';
            pend_ftw_ch  <= '0';
            div_lock     <= '0';
            start_div    <= '0';
            inflight     <= DIV_PERIOD;
            div_dividend <= (others => '0');
            div_divisor  <= (others => '0');
            start_mult   <= '0';
            mult_lock    <= '0';
            minflight    <= MULT_PERIOD;
            mult_a       <= (others => '0');
            mult_b       <= (others => '0');
            f0_hz_r      <= (others => '0');
            lo_hz_r      <= (others => '0');
            ftw_busy     <= '0';
            ftw_bit      <= 0;
            ftw_rem      <= (others => '0');
            ftw_q        <= (others => '0');
            ftw_neg      <= '0';
            need_ftw     <= '0';
            f0_q         <= (others => '0');
            step_q       <= (others => '0');
            lo_q         <= (others => '0');
            fs_ftw       <= (others => '0');
            ch_div       <= (others => '0');
            hop_tick_r   <= '0';
        elsif rising_edge(clk) then
            samp_ph    <= not samp_ph;
            start_div  <= '0';
            start_mult <= '0';
            hop_tick_r <= '0';

            if lut_we = '1' then
                lut(to_integer(lut_addr)) <= lut_data;
            end if;

            auto_v := flags(LEGION_GRID_FLAG_AUTONOMOUS);
            auto_r <= auto_v;

            -- Период: умножение многотактно, затем divide / 1e6.
            period_upd := pri_us /= pri_q or fs_hz /= fs_q or
                          proto_period /= proto_q;
            if period_upd then
                pri_q   <= pri_us;
                fs_q    <= fs_hz;
                proto_q <= proto_period;
                if pri_us /= 0 and fs_hz /= 0 then
                    pend_mult_p <= '1';
                else
                    period      <= proto_period;
                    pend_mult_p <= '0';
                    pend_period <= '0';
                end if;
            end if;

            -- Фаза: rsv mod n_eff через тот же делитель (остаток).
            reload := (auto_v = '1' and auto_r = '0') or
                      rsv /= rsv_q or n_eff /= n_q;
            if reload then
                rsv_q <= rsv;
                n_q   <= n_eff;
                cnt   <= (others => '0');
                if n_eff = 0 then
                    idx      <= (others => '0');
                    pend_mod <= '0';
                else
                    pend_mod <= '1';
                end if;
            elsif samp_ph = '1' and auto_v = '1' and n_eff /= 0 and
                  period /= 0 then
                if cnt + 1 >= period then
                    cnt <= (others => '0');
                    hop_tick_r <= '1';
                    nxt := resize(idx, 9) + 1;
                    if nxt >= resize(n_eff, 9) then
                        idx <= (others => '0');
                    else
                        idx <= nxt(7 downto 0);
                    end if;
                else
                    cnt <= cnt + 1;
                end if;
            end if;

            if div_valid = '1' then
                div_lock <= '0';
                if inflight = DIV_PERIOD then
                    period <= div_q;
                else
                    idx <= div_rem(7 downto 0);
                end if;
            end if;

            if mult_valid = '1' then
                mult_lock <= '0';
                if minflight = MULT_PERIOD then
                    prod_r      <= mult_p;
                    pend_period <= '1';
                elsif auto_v = '1' and n_eff /= 0 then
                    if minflight = MULT_F0 then
                        f0_hz_r     <= resize(mult_p, 40);
                        pend_ftw_lo <= '1';
                    elsif minflight = MULT_LO then
                        lo_hz_r     <= resize(mult_p, 40);
                        pend_ftw_ch <= '1';
                    else
                        -- ch·step готово: собрать FTW и делить на fs_ftw.
                        -- f_rf: 40 бит, wrap при |f0+ch·step| ≥ 2^40.
                        -- При реальных ISM (f0 ≤ 6 ГГц, ch·step ≤ 255 МГц) не достигается.
                        f_rf := f0_hz_r + resize(mult_p, 40);
                        diff := signed(resize(f_rf, 42))
                                + resize(shift_q, 42)
                                - signed(resize(lo_hz_r, 42));
                        if diff < 0 then
                            ftw_neg <= '1';
                            mag     := unsigned(-diff(39 downto 0));
                        else
                            ftw_neg <= '0';
                            mag     := unsigned(diff(39 downto 0));
                        end if;
                        ftw_rem  <= resize(mag, 64);
                        ftw_q    <= (others => '0');
                        ftw_bit  <= 31;
                        ftw_busy <= '1';
                    end if;
                end if;
            end if;

            -- Не стартовать в тот же такт, что обновление входов.
            if (not period_upd) and div_lock = '0' and div_busy = '0' and
               start_div = '0' then
                if pend_period = '1' then
                    start_div    <= '1';
                    div_lock     <= '1';
                    pend_period  <= '0';
                    inflight     <= DIV_PERIOD;
                    div_dividend <= prod_r;
                    -- 1_000_000: мкс → сэмплы (period = pri_us · fs / 1e6).
                    div_divisor  <= to_unsigned(1_000_000, 32);
                elsif pend_mod = '1' and n_eff /= 0 then
                    start_div    <= '1';
                    div_lock     <= '1';
                    pend_mod     <= '0';
                    inflight     <= DIV_MOD;
                    div_dividend <= resize(rsv, 64);
                    div_divisor  <= resize(n_eff, 32);
                end if;
            end if;

            if (not period_upd) and mult_lock = '0' and mult_busy = '0' and
               start_mult = '0' then
                if pend_mult_p = '1' then
                    start_mult  <= '1';
                    mult_lock   <= '1';
                    pend_mult_p <= '0';
                    minflight   <= MULT_PERIOD;
                    mult_a      <= pri_us;
                    mult_b      <= fs_hz;
                elsif pend_ftw_f0 = '1' then
                    start_mult  <= '1';
                    mult_lock   <= '1';
                    pend_ftw_f0 <= '0';
                    minflight   <= MULT_F0;
                    mult_a      <= f0_q;
                    -- 1000: кГц → Гц (F0 ниже GATE хранится в кГц).
                    mult_b      <= to_unsigned(1000, 32);
                elsif pend_ftw_lo = '1' then
                    start_mult  <= '1';
                    mult_lock   <= '1';
                    pend_ftw_lo <= '0';
                    minflight   <= MULT_LO;
                    mult_a      <= lo_q;
                    -- 1000: CH_LO кГц → Гц.
                    mult_b      <= to_unsigned(1000, 32);
                elsif pend_ftw_ch = '1' then
                    start_mult  <= '1';
                    mult_lock   <= '1';
                    pend_ftw_ch <= '0';
                    minflight   <= MULT_CH;
                    mult_a      <= resize(ch_div, 32);
                    mult_b      <= step_q;
                end if;
            end if;

            ch_r <= lut(to_integer(idx));

            if ch_r /= ch_div or f0 /= f0_q or step_hz /= step_q or
               lo_khz /= lo_q or fs_hz /= fs_ftw or shift_hz /= shift_q then
                need_ftw <= '1';
            end if;

            -- n_eff=0 или нет AUTO → FTW=0 (не lut(0)).
            if auto_v = '0' or n_eff = 0 then
                ftw_r       <= (others => '0');
                need_ftw    <= '0';
                ftw_busy    <= '0';
                pend_ftw_f0 <= '0';
                pend_ftw_lo <= '0';
                pend_ftw_ch <= '0';
            elsif ftw_busy = '1' then
                tmp := ftw_rem(62 downto 0) & '0';
                cmp := tmp(63 downto 32);
                qv  := ftw_q;
                -- fs_ftw: копия fs на старте FTW, не fs_q периода.
                if fs_ftw /= 0 and cmp >= fs_ftw then
                    ftw_rem <= tmp - (fs_ftw & x"00000000");
                    qv(ftw_bit) := '1';
                else
                    ftw_rem <= tmp;
                    qv(ftw_bit) := '0';
                end if;
                ftw_q <= qv;
                if ftw_bit = 0 then
                    ftw_busy <= '0';
                    if ftw_neg = '1' then
                        ftw_r <= unsigned(-signed(qv));
                    else
                        ftw_r <= qv;
                    end if;
                else
                    ftw_bit <= ftw_bit - 1;
                end if;
            elsif need_ftw = '1' and fs_hz /= 0 then
                need_ftw <= '0';
                f0_q     <= f0;
                step_q   <= step_hz;
                lo_q     <= lo_khz;
                shift_q  <= shift_hz;
                ch_div   <= ch_r;
                fs_ftw   <= fs_hz;
                if f0 < to_unsigned(LEGION_GRID_F0_KHZ_GATE, 32) then
                    pend_ftw_f0 <= '1';
                else
                    f0_hz_r     <= resize(f0, 40);
                    pend_ftw_lo <= '1';
                end if;
            end if;
        end if;
    end process;
end architecture;
