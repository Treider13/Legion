-- ============================================================================
-- LEGION — radix-2 DIT 256 + argmax + Top-N (local-max + distance).
-- Алгоритм как R2FFT (yoonisi, BSD-3). Не Intel FFT IP.
-- Пик 0 (0x15 / xlat): глобальный argmax — не менять контракт walker.
-- PEAK1..3: SciPy find_peaks — локальный max, затем distance (excl бинов).
-- Поток mag_* кормит legion_fft_channelize, FFT не переписываем.
-- 8 слотов 10 МГц (2400…2480) или 8 октантов, если fs/lo = 0.
-- Слово пика: [7:0] bin, [23:8] mag[31:16], [30:24] frame, [31] valid.
-- enable=0: коллектор стоит, valid=0.
-- ============================================================================
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
use work.legion_fft_twiddle.all;
use work.legion_pkg.all;

entity legion_fft_peak is
    port (
        clock      : in  std_logic;
        reset      : in  std_logic;
        enable     : in  std_logic;
        dc_notch   : in  std_logic;
        excl       : in  unsigned(7 downto 0);
        fs_hz      : in  unsigned(31 downto 0);
        lo_khz     : in  unsigned(31 downto 0);
        in_i       : in  signed(15 downto 0);
        in_q       : in  signed(15 downto 0);
        in_valid   : in  std_logic;
        peak_word  : out std_logic_vector(31 downto 0);
        peak1_word : out std_logic_vector(31 downto 0);
        peak2_word : out std_logic_vector(31 downto 0);
        peak3_word : out std_logic_vector(31 downto 0);
        mag_valid  : out std_logic;
        mag_last   : out std_logic;
        mag_bin    : out unsigned(7 downto 0);
        mag_pow    : out unsigned(15 downto 0);
        mag_frame  : out unsigned(6 downto 0);
        ch_energy  : out legion_ch_energy_t;
        ch_bins    : out std_logic_vector(63 downto 0);
        ch_active  : out std_logic_vector(7 downto 0)
    );
end entity;

architecture rtl of legion_fft_peak is
    -- M10K simple dual-port: один адрес записи и один адрес чтения.
    -- True dual-port M10K кончается на 512×20 (Cyclone V Handbook,
    -- mixed-width table), поэтому 256×32 двумя записями за такт в блок
    -- не встаёт. Бабочка пишет A, затем B; читает A, затем B.
    type ram_t is array (0 to 255) of std_logic_vector(31 downto 0);
    signal ram : ram_t := (others => (others => '0'));
    attribute ramstyle : string;
    attribute ramstyle of ram : signal is "M10K, no_rw_check";

    type mag_ram_t is array (0 to 255) of unsigned(15 downto 0);
    signal mag_ram : mag_ram_t := (others => (others => '0'));
    attribute ramstyle of mag_ram : signal is "M10K, no_rw_check";

    signal rd_addr  : unsigned(7 downto 0) := (others => '0');
    signal wr_addr  : unsigned(7 downto 0) := (others => '0');
    signal we       : std_logic := '0';
    signal wr_data  : std_logic_vector(31 downto 0) := (others => '0');
    signal q_fft    : std_logic_vector(31 downto 0) := (others => '0');
    signal tw_addr  : unsigned(7 downto 0) := (others => '0');
    signal mag_waddr : unsigned(7 downto 0) := (others => '0');
    signal mag_raddr : unsigned(7 downto 0) := (others => '0');
    signal mag_q     : unsigned(15 downto 0) := (others => '0');
    signal mag_we    : std_logic := '0';
    signal mag_din   : unsigned(15 downto 0) := (others => '0');
    signal din_b_r   : std_logic_vector(31 downto 0) := (others => '0');

    type state_t is (ST_COLLECT,
                    ST_FFT_RD_A, ST_FFT_RD_B, ST_FFT_CAP, ST_FFT_MATH,
                    ST_FFT_WR_B, ST_FFT_GAP,
                    ST_PEAK_RD, ST_PEAK_WAIT, ST_PEAK_CMP, ST_LM_WRAP,
                    ST_TOP_RD, ST_TOP_WAIT, ST_TOP_CMP, ST_PUBLISH);
    signal state : state_t := ST_COLLECT;

    signal collect_n : unsigned(8 downto 0) := (others => '0');
    signal stage     : unsigned(2 downto 0) := (others => '0');
    signal pair      : unsigned(6 downto 0) := (others => '0');
    signal peak_i    : unsigned(8 downto 0) := (others => '0');
    signal best_bin  : unsigned(7 downto 0) := (others => '0');
    signal best_mag  : unsigned(31 downto 0) := (others => '0');
    signal frame_r   : unsigned(6 downto 0) := (others => '0');
    signal valid_r   : std_logic := '0';
    signal word_r    : std_logic_vector(31 downto 0) := (others => '0');
    signal word1_r   : std_logic_vector(31 downto 0) := (others => '0');
    signal word2_r   : std_logic_vector(31 downto 0) := (others => '0');
    signal word3_r   : std_logic_vector(31 downto 0) := (others => '0');
    signal a_i_r     : signed(15 downto 0) := (others => '0');
    signal a_q_r     : signed(15 downto 0) := (others => '0');
    signal wr_r      : signed(15 downto 0) := (others => '0');
    signal wi_r      : signed(15 downto 0) := (others => '0');
    signal ia_r      : unsigned(7 downto 0) := (others => '0');
    signal ib_r      : unsigned(7 downto 0) := (others => '0');

    signal mag_valid_r : std_logic := '0';
    signal mag_last_r  : std_logic := '0';
    signal mag_bin_r   : unsigned(7 downto 0) := (others => '0');
    signal mag_pow_r   : unsigned(15 downto 0) := (others => '0');
    signal mag_frame_r : unsigned(6 downto 0) := (others => '0');

    signal lm_flags  : std_logic_vector(0 to 255) := (others => '0');
    signal mag0_r    : unsigned(15 downto 0) := (others => '0');
    signal mag1_r    : unsigned(15 downto 0) := (others => '0');
    signal mag254_r  : unsigned(15 downto 0) := (others => '0');
    signal mag255_r  : unsigned(15 downto 0) := (others => '0');
    signal mag_prev  : unsigned(15 downto 0) := (others => '0');
    signal mag_prev2 : unsigned(15 downto 0) := (others => '0');

    signal top_k         : unsigned(1 downto 0) := (others => '0');
    signal top_i         : unsigned(8 downto 0) := (others => '0');
    signal top_best_bin  : unsigned(7 downto 0) := (others => '0');
    signal top_best_mag  : unsigned(15 downto 0) := (others => '0');
    signal top_best_ok   : std_logic := '0';
    signal sel_bin0, sel_bin1, sel_bin2, sel_bin3 : unsigned(7 downto 0) := (others => '0');
    signal sel_mag0, sel_mag1, sel_mag2, sel_mag3 : unsigned(15 downto 0) := (others => '0');
    signal sel_ok0, sel_ok1, sel_ok2, sel_ok3     : std_logic := '0';

    type mag8_t is array (0 to 7) of unsigned(31 downto 0);
    type bin8_t is array (0 to 7) of unsigned(7 downto 0);
    signal g_acc  : mag8_t := (others => (others => '0'));
    signal g_pk   : mag8_t := (others => (others => '0'));
    signal g_bin  : bin8_t := (others => (others => '0'));
    signal e_r    : legion_ch_energy_t := (others => (others => '0'));
    signal bins_r : std_logic_vector(63 downto 0) := (others => '0');
    signal act_r  : std_logic_vector(7 downto 0) := (others => '0');

    function bitrev8(x : unsigned(7 downto 0)) return unsigned is
        variable r : unsigned(7 downto 0);
    begin
        for i in 0 to 7 loop
            r(i) := x(7 - i);
        end loop;
        return r;
    end function;

    function pack_iq(ii, qq : signed(15 downto 0)) return std_logic_vector is
    begin
        return std_logic_vector(ii) & std_logic_vector(qq);
    end function;

    function pack_peak(v : std_logic; fr : unsigned(6 downto 0);
                       mag16 : unsigned(15 downto 0); bin : unsigned(7 downto 0))
        return std_logic_vector is
        variable w : std_logic_vector(31 downto 0);
    begin
        w(7 downto 0)   := std_logic_vector(bin);
        w(23 downto 8)  := std_logic_vector(mag16);
        w(30 downto 24) := std_logic_vector(fr);
        w(31)           := v;
        return w;
    end function;

    function circ_dist(a, b : integer) return integer is
        variable d : integer;
    begin
        d := a - b;
        if d < 0 then
            d := -d;
        end if;
        if d > 128 then
            d := 256 - d;
        end if;
        return d;
    end function;

    function excl_eff(e : unsigned(7 downto 0)) return integer is
    begin
        if e = 0 then
            return LEGION_CH_EXCL_DEFAULT;
        end if;
        return to_integer(e);
    end function;

begin
    peak_word  <= word_r;
    peak1_word <= word1_r;
    peak2_word <= word2_r;
    peak3_word <= word3_r;
    mag_valid  <= mag_valid_r;
    mag_last   <= mag_last_r;
    mag_bin    <= mag_bin_r;
    mag_pow    <= mag_pow_r;
    mag_frame  <= mag_frame_r;
    ch_energy  <= e_r;
    ch_bins    <= bins_r;
    ch_active  <= act_r;

    -- Intel recommended HDL: один процесс, запись и зарегистрированное чтение,
    -- без сброса. Адрес и данные записи выставлены на предыдущем такте.
    ram_p : process(clock)
    begin
        if rising_edge(clock) then
            if we = '1' then
                ram(to_integer(wr_addr)) <= wr_data;
            end if;
            q_fft <= ram(to_integer(rd_addr));
        end if;
    end process;

    mag_p : process(clock)
    begin
        if rising_edge(clock) then
            if mag_we = '1' then
                mag_ram(to_integer(mag_waddr)) <= mag_din;
            end if;
            mag_q <= mag_ram(to_integer(mag_raddr));
        end if;
    end process;

    -- Синхронное чтение константы, процесс только от clock, без сброса:
    -- шаблон ROM из Quartus Prime Handbook (Inferring ROM Functions).
    -- Атрибут romstyle на переменную роняет GHDL 4.1 (CONSTRAINT_ERROR),
    -- поэтому таблица берётся прямо из пакета. 256×16 Quartus и так
    -- кладёт в блок, а не в логику.
    tw_p : process(clock)
    begin
        if rising_edge(clock) then
            wr_r <= LEGION_TWIDDLE_RE(to_integer(tw_addr));
            wi_r <= LEGION_TWIDDLE_IM(to_integer(tw_addr));
        end if;
    end process;

    ctl : process(clock, reset)
        variable half    : unsigned(7 downto 0);
        variable j       : unsigned(7 downto 0);
        variable grp     : unsigned(7 downto 0);
        variable ia      : unsigned(7 downto 0);
        variable ib      : unsigned(7 downto 0);
        variable tw_idx  : unsigned(7 downto 0);
        variable pr, pi  : signed(31 downto 0);
        variable tr, ti  : signed(15 downto 0);
        variable sa, da  : signed(16 downto 0);
        variable sb, db  : signed(16 downto 0);
        variable mag     : unsigned(31 downto 0);
        variable mag16   : unsigned(15 downto 0);
        variable skip_dc : boolean;
        variable ii, qq  : signed(15 downto 0);
        variable blocked : boolean;
        variable ex      : integer;
        variable bi      : integer;
        variable fr      : unsigned(6 downto 0);
        variable gi      : integer;
        variable sum     : unsigned(32 downto 0);
    begin
        if reset = '1' then
            state     <= ST_COLLECT;
            collect_n <= (others => '0');
            stage     <= (others => '0');
            pair      <= (others => '0');
            peak_i    <= (others => '0');
            best_bin  <= (others => '0');
            best_mag  <= (others => '0');
            frame_r   <= (others => '0');
            valid_r   <= '0';
            word_r    <= (others => '0');
            word1_r   <= (others => '0');
            word2_r   <= (others => '0');
            word3_r   <= (others => '0');
            e_r       <= (others => (others => '0'));
            bins_r    <= (others => '0');
            act_r     <= (others => '0');
            g_acc     <= (others => (others => '0'));
            g_pk      <= (others => (others => '0'));
            g_bin     <= (others => (others => '0'));
            we        <= '0';
            wr_addr   <= (others => '0');
            rd_addr   <= (others => '0');
            wr_data   <= (others => '0');
            mag_valid_r <= '0';
            mag_last_r  <= '0';
            mag_bin_r   <= (others => '0');
            mag_pow_r   <= (others => '0');
            mag_frame_r <= (others => '0');
            mag_we      <= '0';
            lm_flags    <= (others => '0');
            top_k       <= (others => '0');
            top_i       <= (others => '0');
            sel_ok0     <= '0';
            sel_ok1     <= '0';
            sel_ok2     <= '0';
            sel_ok3     <= '0';
        elsif rising_edge(clock) then
            we          <= '0';
            mag_we      <= '0';
            mag_valid_r <= '0';
            mag_last_r  <= '0';

            if enable = '0' then
                state     <= ST_COLLECT;
                collect_n <= (others => '0');
                valid_r   <= '0';
                word_r    <= (others => '0');
                word1_r   <= (others => '0');
                word2_r   <= (others => '0');
                word3_r   <= (others => '0');
                e_r       <= (others => (others => '0'));
                bins_r    <= (others => '0');
                act_r     <= (others => '0');
            else
                case state is
                    when ST_COLLECT =>
                        if in_valid = '1' then
                            wr_addr   <= bitrev8(collect_n(7 downto 0));
                            wr_data   <= pack_iq(in_i, in_q);
                            we        <= '1';
                            collect_n <= collect_n + 1;
                            if collect_n = 255 then
                                collect_n <= (others => '0');
                                stage     <= (others => '0');
                                pair      <= (others => '0');
                                state     <= ST_FFT_RD_A;
                            end if;
                        end if;

                    -- Адрес чтения виден RAM на следующем фронте, q_fft —
                    -- ещё через фронт. Поэтому между выдачей адреса и
                    -- использованием q_fft стоит один такт.
                    when ST_FFT_RD_A =>
                        half := shift_left(to_unsigned(1, 8), to_integer(stage));
                        j    := resize(pair, 8) and (half - 1);
                        grp  := shift_right(resize(pair, 8), to_integer(stage));
                        ia   := shift_left(grp, to_integer(stage) + 1) + j;
                        ib   := ia + half;
                        tw_idx := shift_left(j, 8 - to_integer(stage) - 1);
                        rd_addr <= ia;
                        tw_addr <= tw_idx;
                        ia_r    <= ia;
                        ib_r    <= ib;
                        state   <= ST_FFT_RD_B;

                    when ST_FFT_RD_B =>
                        rd_addr <= ib_r;
                        state   <= ST_FFT_CAP;

                    when ST_FFT_CAP =>
                        a_i_r <= signed(q_fft(31 downto 16));
                        a_q_r <= signed(q_fft(15 downto 0));
                        state <= ST_FFT_MATH;

                    when ST_FFT_MATH =>
                        pr := wr_r * signed(q_fft(31 downto 16))
                            - wi_r * signed(q_fft(15 downto 0));
                        pi := wr_r * signed(q_fft(15 downto 0))
                            + wi_r * signed(q_fft(31 downto 16));
                        tr := resize(shift_right(pr, 15), 16);
                        ti := resize(shift_right(pi, 15), 16);
                        sa := resize(a_i_r, 17) + resize(tr, 17);
                        da := resize(a_i_r, 17) - resize(tr, 17);
                        sb := resize(a_q_r, 17) + resize(ti, 17);
                        db := resize(a_q_r, 17) - resize(ti, 17);
                        wr_addr <= ia_r;
                        wr_data <= pack_iq(resize(shift_right(sa, 1), 16),
                                           resize(shift_right(sb, 1), 16));
                        din_b_r <= pack_iq(resize(shift_right(da, 1), 16),
                                           resize(shift_right(db, 1), 16));
                        we    <= '1';
                        state <= ST_FFT_WR_B;

                    when ST_FFT_WR_B =>
                        wr_addr <= ib_r;
                        wr_data <= din_b_r;
                        we      <= '1';
                        state   <= ST_FFT_GAP;

                    when ST_FFT_GAP =>
                        if pair = 127 then
                            pair <= (others => '0');
                            if stage = 7 then
                                peak_i    <= (others => '0');
                                best_bin  <= (others => '0');
                                best_mag  <= (others => '0');
                                lm_flags  <= (others => '0');
                                mag_prev  <= (others => '0');
                                mag_prev2 <= (others => '0');
                                sel_ok0   <= '0';
                                sel_ok1   <= '0';
                                sel_ok2   <= '0';
                                sel_ok3   <= '0';
                                g_acc     <= (others => (others => '0'));
                                g_pk      <= (others => (others => '0'));
                                g_bin     <= (others => (others => '0'));
                                state     <= ST_PEAK_RD;
                            else
                                stage <= stage + 1;
                                state <= ST_FFT_RD_A;
                            end if;
                        else
                            pair  <= pair + 1;
                            state <= ST_FFT_RD_A;
                        end if;

                    when ST_PEAK_RD =>
                        rd_addr <= peak_i(7 downto 0);
                        state   <= ST_PEAK_WAIT;

                    when ST_PEAK_WAIT =>
                        state <= ST_PEAK_CMP;

                    when ST_PEAK_CMP =>
                        ii := signed(q_fft(31 downto 16));
                        qq := signed(q_fft(15 downto 0));
                        mag := unsigned(ii * ii) + unsigned(qq * qq);
                        mag16 := mag(31 downto 16);
                        mag_waddr   <= peak_i(7 downto 0);
                        mag_din     <= mag16;
                        mag_we      <= '1';
                        mag_valid_r <= '1';
                        mag_bin_r   <= peak_i(7 downto 0);
                        mag_pow_r   <= mag16;
                        mag_frame_r <= frame_r + 1;
                        mag_last_r  <= '0';
                        if peak_i = 0 then
                            mag0_r <= mag16;
                        elsif peak_i = 1 then
                            mag1_r <= mag16;
                        elsif peak_i = 254 then
                            mag254_r <= mag16;
                        elsif peak_i = 255 then
                            mag255_r <= mag16;
                            mag_last_r <= '1';
                        end if;
                        if peak_i >= 2 then
                            if mag_prev > mag_prev2 and mag_prev > mag16 then
                                lm_flags(to_integer(peak_i) - 1) <= '1';
                            end if;
                        end if;
                        mag_prev2 <= mag_prev;
                        mag_prev  <= mag16;
                        skip_dc := (dc_notch = '1') and (peak_i = 0);
                        if (not skip_dc) and mag > best_mag then
                            best_mag <= mag;
                            best_bin <= peak_i(7 downto 0);
                        end if;
                        gi := legion_ch_slot(to_integer(peak_i(7 downto 0)), fs_hz, lo_khz);
                        if (not skip_dc) and gi >= 0 and gi <= 7 then
                            sum := resize(g_acc(gi), 33) + resize(mag, 33);
                            if sum(32) = '1' then
                                g_acc(gi) <= (others => '1');
                            else
                                g_acc(gi) <= sum(31 downto 0);
                            end if;
                            if mag > g_pk(gi) then
                                g_pk(gi)  <= mag;
                                g_bin(gi) <= peak_i(7 downto 0);
                            end if;
                        end if;
                        if peak_i = 255 then
                            state <= ST_LM_WRAP;
                        else
                            peak_i <= peak_i + 1;
                            state  <= ST_PEAK_RD;
                        end if;

                    when ST_LM_WRAP =>
                        if mag0_r > mag255_r and mag0_r > mag1_r and dc_notch = '0' then
                            lm_flags(0) <= '1';
                        end if;
                        if mag255_r > mag254_r and mag255_r > mag0_r then
                            lm_flags(255) <= '1';
                        end if;
                        top_k        <= (others => '0');
                        top_i        <= (others => '0');
                        top_best_mag <= (others => '0');
                        top_best_bin <= (others => '0');
                        top_best_ok  <= '0';
                        state        <= ST_TOP_RD;

                    when ST_TOP_RD =>
                        mag_raddr <= top_i(7 downto 0);
                        state    <= ST_TOP_WAIT;

                    when ST_TOP_WAIT =>
                        state <= ST_TOP_CMP;

                    when ST_TOP_CMP =>
                        ex := excl_eff(excl);
                        bi := to_integer(top_i(7 downto 0));
                        blocked := (dc_notch = '1' and top_i = 0) or
                                   (lm_flags(bi) = '0');
                        if not blocked then
                            if circ_dist(bi, to_integer(best_bin)) < ex then
                                blocked := true;
                            end if;
                            if sel_ok0 = '1' and circ_dist(bi, to_integer(sel_bin0)) < ex then
                                blocked := true;
                            end if;
                            if sel_ok1 = '1' and circ_dist(bi, to_integer(sel_bin1)) < ex then
                                blocked := true;
                            end if;
                            if sel_ok2 = '1' and circ_dist(bi, to_integer(sel_bin2)) < ex then
                                blocked := true;
                            end if;
                            if sel_ok3 = '1' and circ_dist(bi, to_integer(sel_bin3)) < ex then
                                blocked := true;
                            end if;
                        end if;
                        if (not blocked) and (top_best_ok = '0' or mag_q > top_best_mag) then
                            top_best_mag <= mag_q;
                            top_best_bin <= top_i(7 downto 0);
                            top_best_ok  <= '1';
                        end if;
                        if top_i = 255 then
                            if top_k = 0 then
                                sel_bin0 <= top_best_bin;
                                sel_mag0 <= top_best_mag;
                                sel_ok0  <= top_best_ok;
                            elsif top_k = 1 then
                                sel_bin1 <= top_best_bin;
                                sel_mag1 <= top_best_mag;
                                sel_ok1  <= top_best_ok;
                            else
                                sel_bin2 <= top_best_bin;
                                sel_mag2 <= top_best_mag;
                                sel_ok2  <= top_best_ok;
                            end if;
                            -- 3 прохода: PEAK1..3. peak0 = argmax, не дублируем.
                            if top_k = 2 then
                                state <= ST_PUBLISH;
                            else
                                top_k        <= top_k + 1;
                                top_i        <= (others => '0');
                                top_best_mag <= (others => '0');
                                top_best_bin <= (others => '0');
                                top_best_ok  <= '0';
                                state        <= ST_TOP_RD;
                            end if;
                        else
                            top_i <= top_i + 1;
                            state <= ST_TOP_RD;
                        end if;

                    when ST_PUBLISH =>
                        valid_r <= '1';
                        frame_r <= frame_r + 1;
                        fr := frame_r + 1;
                        word_r  <= pack_peak('1', fr, best_mag(31 downto 16), best_bin);
                        if sel_ok0 = '1' then
                            word1_r <= pack_peak('1', fr, sel_mag0, sel_bin0);
                        else
                            word1_r <= (others => '0');
                        end if;
                        if sel_ok1 = '1' then
                            word2_r <= pack_peak('1', fr, sel_mag1, sel_bin1);
                        else
                            word2_r <= (others => '0');
                        end if;
                        if sel_ok2 = '1' then
                            word3_r <= pack_peak('1', fr, sel_mag2, sel_bin2);
                        else
                            word3_r <= (others => '0');
                        end if;
                        e_r(0) <= std_logic_vector(g_acc(0));
                        e_r(1) <= std_logic_vector(g_acc(1));
                        e_r(2) <= std_logic_vector(g_acc(2));
                        e_r(3) <= std_logic_vector(g_acc(3));
                        e_r(4) <= std_logic_vector(g_acc(4));
                        e_r(5) <= std_logic_vector(g_acc(5));
                        e_r(6) <= std_logic_vector(g_acc(6));
                        e_r(7) <= std_logic_vector(g_acc(7));
                        bins_r(7 downto 0)   <= std_logic_vector(g_bin(0));
                        bins_r(15 downto 8)  <= std_logic_vector(g_bin(1));
                        bins_r(23 downto 16) <= std_logic_vector(g_bin(2));
                        bins_r(31 downto 24) <= std_logic_vector(g_bin(3));
                        bins_r(39 downto 32) <= std_logic_vector(g_bin(4));
                        bins_r(47 downto 40) <= std_logic_vector(g_bin(5));
                        bins_r(55 downto 48) <= std_logic_vector(g_bin(6));
                        bins_r(63 downto 56) <= std_logic_vector(g_bin(7));
                        for si in 0 to 7 loop
                            if g_acc(si) /= 0 then
                                act_r(si) <= '1';
                            else
                                act_r(si) <= '0';
                            end if;
                        end loop;
                        collect_n <= (others => '0');
                        state     <= ST_COLLECT;
                end case;
            end if;
        end if;
    end process;
end architecture;
