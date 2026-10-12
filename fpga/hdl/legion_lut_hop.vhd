-- ============================================================================
-- LEGION — таймер индекса HOP_LUT (кГц, 32×256).
-- FTW = (LUT_khz×1000 + shift_hz − lo_khz×1000) / fs · 2^32.
-- Умножение ×1000 — legion_mult, 64 бита, только до вычитания.
-- diff — 40 бит. Знак отделяется до цикла ftw_bit (31→0), цикл не шире 40.
-- shift_hz — регистр 0x55, знаковое, один раз. Старого сумматора ch·step нет.
-- LUT не инициализируется в reset: одна запись за такт, чтение в регистр.
-- Индекс: 9-битное сравнение с end_idx, переход в start_idx.
-- start>end или n_eff=0 → tx_mute. Молчание метки — счётчик тактов tx_clock
-- (34 МГц): ticks = mute_ns × 34 / 1000 = mute_ns × 34e6 / 1e9.
-- Домен: только tx_clock. Строб записи LUT уже снят в legion_regs.
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
        lut_data     : in  unsigned(31 downto 0);
        start_idx    : in  unsigned(7 downto 0);
        end_idx      : in  unsigned(7 downto 0);
        apply_we     : in  std_logic;
        mute_ns      : in  unsigned(31 downto 0);
        mute_arm     : in  std_logic;
        hop_auto     : out std_logic;
        hop_ch       : out unsigned(7 downto 0);
        hop_ftw      : out unsigned(31 downto 0);
        hop_tick     : out std_logic;
        tx_mute      : out std_logic
    );
end entity;

architecture rtl of legion_lut_hop is
    type lut_t is array (0 to 255) of unsigned(31 downto 0);
    type div_sel_t is (DIV_PERIOD, DIV_MOD, DIV_MUTE);
    type mult_sel_t is (MULT_PERIOD, MULT_LUT, MULT_LO, MULT_MUTE);

    signal lut         : lut_t;
    signal lut_q       : unsigned(31 downto 0);
    signal samp_ph     : std_logic;
    signal idx         : unsigned(7 downto 0);
    signal cnt         : unsigned(31 downto 0);
    signal period      : unsigned(31 downto 0);
    signal n_eff       : unsigned(7 downto 0);
    signal auto_r      : std_logic;
    signal ftw_r       : unsigned(31 downto 0);
    signal pri_q       : unsigned(31 downto 0);
    signal fs_q        : unsigned(31 downto 0);
    signal proto_q     : unsigned(31 downto 0);
    signal rsv_q       : unsigned(7 downto 0);
    signal n_q         : unsigned(7 downto 0);
    signal shift_q     : signed(31 downto 0);
    signal start_q     : unsigned(7 downto 0);
    signal end_q       : unsigned(7 downto 0);

    signal prod_r      : unsigned(63 downto 0);
    signal pend_period : std_logic;
    signal pend_mod    : std_logic;
    signal pend_mult_p : std_logic;
    signal pend_ftw_lut : std_logic;
    signal pend_ftw_lo : std_logic;
    signal pend_mute_mul : std_logic;
    signal pend_mute_div : std_logic;
    signal div_lock    : std_logic;
    signal start_div   : std_logic;
    signal inflight    : div_sel_t;
    signal div_dividend : unsigned(63 downto 0);
    signal div_divisor  : unsigned(31 downto 0);
    signal div_q       : unsigned(31 downto 0);
    signal div_rem     : unsigned(31 downto 0);
    signal div_valid   : std_logic;
    signal div_busy    : std_logic;

    signal start_mult  : std_logic;
    signal mult_lock   : std_logic;
    signal minflight   : mult_sel_t;
    signal mult_a      : unsigned(31 downto 0);
    signal mult_b      : unsigned(31 downto 0);
    signal mult_p      : unsigned(63 downto 0);
    signal mult_valid  : std_logic;
    signal mult_busy   : std_logic;
    signal lut_hz_r    : unsigned(39 downto 0);
    signal lo_hz_r     : unsigned(39 downto 0);

    signal ftw_busy    : std_logic;
    signal ftw_bit     : integer range 0 to 31;
    signal ftw_rem     : unsigned(63 downto 0);
    signal ftw_q       : unsigned(31 downto 0);
    signal ftw_neg     : std_logic;
    signal need_ftw    : std_logic;
    signal lo_q        : unsigned(31 downto 0);
    signal fs_ftw      : unsigned(31 downto 0);
    signal lut_held    : unsigned(31 downto 0);
    signal ch_r        : unsigned(31 downto 0);
    signal hop_tick_r  : std_logic;
    signal hop_tick_d  : std_logic;
    signal bounds_r    : std_logic;
    signal mute_ns_q   : unsigned(31 downto 0);
    signal mute_ticks  : unsigned(31 downto 0);
    signal mute_cnt    : unsigned(31 downto 0);
    signal mute_run    : std_logic;
    signal tx_mute_r   : std_logic;
begin
    n_eff <= unsigned(meta(15 downto 8)) when unsigned(meta(15 downto 8)) /= 0
             else unsigned(meta(7 downto 0));

    hop_auto <= auto_r;
    hop_ch   <= idx;
    hop_ftw  <= ftw_r;
    -- Один такт между импульсом индекса и look_through.
    hop_tick <= hop_tick_d;
    tx_mute  <= tx_mute_r;

    -- Память: нет сброса массива, одна запись и чтение в регистр за такт.
    ram_p : process(clk)
    begin
        if rising_edge(clk) then
            if lut_we = '1' then
                lut(to_integer(lut_addr)) <= lut_data;
            end if;
            lut_q <= lut(to_integer(idx));
        end if;
    end process;

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
        variable auto_v    : std_logic;
        variable nxt       : unsigned(8 downto 0);
        variable diff64    : signed(63 downto 0);
        variable mag       : unsigned(39 downto 0);
        variable tmp       : unsigned(63 downto 0);
        variable cmp       : unsigned(31 downto 0);
        variable qv        : unsigned(31 downto 0);
        variable reload    : boolean;
        variable period_upd : boolean;
        variable mute_now  : std_logic;
    begin
        if reset = '1' then
            samp_ph      <= '0';
            idx          <= (others => '0');
            cnt          <= (others => '0');
            period       <= (others => '0');
            auto_r       <= '0';
            ftw_r        <= (others => '0');
            pri_q        <= (others => '0');
            fs_q         <= (others => '0');
            proto_q      <= (others => '0');
            rsv_q        <= (others => '0');
            n_q          <= (others => '0');
            shift_q      <= (others => '0');
            start_q      <= (others => '0');
            end_q        <= (others => '0');
            prod_r       <= (others => '0');
            pend_period  <= '0';
            pend_mod     <= '0';
            pend_mult_p  <= '0';
            pend_ftw_lut <= '0';
            pend_ftw_lo  <= '0';
            pend_mute_mul <= '0';
            pend_mute_div <= '0';
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
            lut_hz_r     <= (others => '0');
            lo_hz_r      <= (others => '0');
            ftw_busy     <= '0';
            ftw_bit      <= 0;
            ftw_rem      <= (others => '0');
            ftw_q        <= (others => '0');
            ftw_neg      <= '0';
            need_ftw     <= '0';
            lo_q         <= (others => '0');
            fs_ftw       <= (others => '0');
            lut_held     <= (others => '0');
            ch_r         <= (others => '0');
            hop_tick_r   <= '0';
            hop_tick_d   <= '0';
            bounds_r     <= '0';
            mute_ns_q    <= (others => '0');
            mute_ticks   <= (others => '0');
            mute_cnt     <= (others => '0');
            mute_run     <= '0';
            tx_mute_r    <= '0';
        elsif rising_edge(clk) then
            samp_ph    <= not samp_ph;
            start_div  <= '0';
            start_mult <= '0';
            hop_tick_r <= '0';
            -- Старый импульс уходит потребителю на следующем такте.
            hop_tick_d <= hop_tick_r;
            -- Чтение LUT уже в lut_q. Использование — ещё через такт.
            ch_r       <= lut_q;

            if apply_we = '1' then
                start_q <= start_idx;
                end_q   <= end_idx;
            end if;
            if start_q > end_q then
                bounds_r <= '1';
            else
                bounds_r <= '0';
            end if;

            auto_v := flags(LEGION_GRID_FLAG_AUTONOMOUS);
            auto_r <= auto_v;

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

            if mute_ns /= mute_ns_q then
                mute_ns_q     <= mute_ns;
                pend_mute_mul <= '1';
            end if;

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
                  period /= 0 and bounds_r = '0' then
                if cnt + 1 >= period then
                    cnt <= (others => '0');
                    hop_tick_r <= '1';
                    nxt := resize(idx, 9) + 1;
                    if nxt > resize(end_q, 9) then
                        idx <= start_q;
                    else
                        idx <= nxt(7 downto 0);
                    end if;
                else
                    cnt <= cnt + 1;
                end if;
            end if;

            mute_now := mute_run;
            if mute_arm = '1' and mute_ticks /= 0 then
                mute_cnt <= mute_ticks;
                mute_run <= '1';
                mute_now := '1';
            elsif mute_run = '1' then
                if mute_cnt <= 1 then
                    mute_cnt <= (others => '0');
                    mute_run <= '0';
                    mute_now := '0';
                else
                    mute_cnt <= mute_cnt - 1;
                    mute_now := '1';
                end if;
            end if;

            if mute_run = '1' and mute_now = '0' then
                need_ftw <= '1';
            end if;

            if auto_v = '1' and (mute_now = '1' or bounds_r = '1' or n_eff = 0) then
                tx_mute_r <= '1';
            else
                tx_mute_r <= '0';
            end if;

            if div_valid = '1' then
                div_lock <= '0';
                if inflight = DIV_PERIOD then
                    period <= div_q;
                elsif inflight = DIV_MUTE then
                    mute_ticks <= div_q;
                else
                    idx <= div_rem(7 downto 0);
                end if;
            end if;

            if mult_valid = '1' then
                mult_lock <= '0';
                if minflight = MULT_PERIOD then
                    prod_r      <= mult_p;
                    pend_period <= '1';
                elsif minflight = MULT_MUTE then
                    prod_r        <= mult_p;
                    pend_mute_div <= '1';
                elsif auto_v = '1' and n_eff /= 0 then
                    if minflight = MULT_LUT then
                        lut_hz_r    <= resize(mult_p, 40);
                        pend_ftw_lo <= '1';
                    elsif minflight = MULT_LO then
                        lo_hz_r <= resize(mult_p, 40);
                        -- 64-битное сложение: LUT·1000 + знаковое 0x55 − LO·1000.
                        diff64 := signed(resize(lut_hz_r, 64))
                                  + resize(shift_q, 64)
                                  - signed(resize(mult_p, 64));
                        if diff64 < 0 then
                            ftw_neg <= '1';
                            mag     := unsigned(-diff64(39 downto 0));
                        else
                            ftw_neg <= '0';
                            mag     := unsigned(diff64(39 downto 0));
                        end if;
                        ftw_rem  <= resize(mag, 64);
                        ftw_q    <= (others => '0');
                        ftw_bit  <= 31;
                        ftw_busy <= '1';
                    end if;
                end if;
            end if;

            if (not period_upd) and div_lock = '0' and div_busy = '0' and
               start_div = '0' then
                if pend_period = '1' then
                    start_div    <= '1';
                    div_lock     <= '1';
                    pend_period  <= '0';
                    inflight     <= DIV_PERIOD;
                    div_dividend <= prod_r;
                    div_divisor  <= to_unsigned(1_000_000, 32);
                elsif pend_mute_div = '1' then
                    start_div     <= '1';
                    div_lock      <= '1';
                    pend_mute_div <= '0';
                    inflight      <= DIV_MUTE;
                    div_dividend  <= prod_r;
                    div_divisor   <= to_unsigned(1000, 32);
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
                elsif pend_ftw_lut = '1' then
                    start_mult   <= '1';
                    mult_lock    <= '1';
                    pend_ftw_lut <= '0';
                    minflight    <= MULT_LUT;
                    mult_a       <= lut_held;
                    mult_b       <= to_unsigned(1000, 32);
                elsif pend_ftw_lo = '1' then
                    start_mult  <= '1';
                    mult_lock   <= '1';
                    pend_ftw_lo <= '0';
                    minflight   <= MULT_LO;
                    mult_a      <= lo_q;
                    mult_b      <= to_unsigned(1000, 32);
                elsif pend_mute_mul = '1' then
                    start_mult    <= '1';
                    mult_lock     <= '1';
                    pend_mute_mul <= '0';
                    minflight     <= MULT_MUTE;
                    mult_a        <= mute_ns_q;
                    -- 34 такта на мкс при 34 МГц: ticks = ns × 34 / 1000.
                    mult_b        <= to_unsigned(34, 32);
                end if;
            end if;

            if ch_r /= lut_held or lo_khz /= lo_q or fs_hz /= fs_ftw or
               shift_hz /= shift_q then
                need_ftw <= '1';
            end if;

            if auto_v = '0' or n_eff = 0 or bounds_r = '1' or mute_now = '1' then
                ftw_r        <= (others => '0');
                need_ftw     <= '0';
                ftw_busy     <= '0';
                pend_ftw_lut <= '0';
                pend_ftw_lo  <= '0';
            elsif ftw_busy = '1' then
                tmp := ftw_rem(62 downto 0) & '0';
                cmp := tmp(63 downto 32);
                qv  := ftw_q;
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
                lo_q     <= lo_khz;
                shift_q  <= shift_hz;
                lut_held <= ch_r;
                fs_ftw   <= fs_hz;
                pend_ftw_lut <= '1';
            end if;
        end if;
    end process;
end architecture;
