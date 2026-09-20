-- ============================================================================
-- LEGION — radix-2 DIT 256 + argmax на том же RX-тапе, что legion_detector.
-- Алгоритм как R2FFT (yoonisi, BSD-3): один бабочка, (N/2)·log2(N) шагов,
-- вход bit-reversed, Q15 twiddle, >>1 на стадии (антипереполнение).
-- Не Intel FFT IP: на xA4 нет лицензии / OpenCore Plus истекает через час.
-- Пик: f = LO + signed_bin·(fs/256). bin≥128 → bin−256.
-- Слово пика: [7:0] bin, [23:8] mag[31:16], [30:24] frame, [31] valid.
-- enable=0: коллектор стоит, valid=0 — walker без FFT_CTRL не меняется.
-- ============================================================================
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
use work.legion_fft_twiddle.all;

entity legion_fft_peak is
    port (
        clock     : in  std_logic;
        reset     : in  std_logic;
        enable    : in  std_logic;
        dc_notch  : in  std_logic;
        in_i      : in  signed(15 downto 0);
        in_q      : in  signed(15 downto 0);
        in_valid  : in  std_logic;
        peak_word : out std_logic_vector(31 downto 0)
    );
end entity;

architecture rtl of legion_fft_peak is
    type ram_t is array (0 to 255) of std_logic_vector(31 downto 0);
    signal ram : ram_t := (others => (others => '0'));

    signal addr_a : unsigned(7 downto 0) := (others => '0');
    signal addr_b : unsigned(7 downto 0) := (others => '0');
    signal we_a   : std_logic := '0';
    signal we_b   : std_logic := '0';
    signal din_a  : std_logic_vector(31 downto 0) := (others => '0');
    signal din_b  : std_logic_vector(31 downto 0) := (others => '0');
    signal q_a    : std_logic_vector(31 downto 0) := (others => '0');
    signal q_b    : std_logic_vector(31 downto 0) := (others => '0');

    type state_t is (ST_COLLECT, ST_FFT_RD, ST_FFT_WR, ST_PEAK_RD, ST_PEAK_CMP, ST_PUBLISH);
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
    signal a_i_r     : signed(15 downto 0) := (others => '0');
    signal a_q_r     : signed(15 downto 0) := (others => '0');
    signal b_i_r     : signed(15 downto 0) := (others => '0');
    signal b_q_r     : signed(15 downto 0) := (others => '0');
    signal wr_r      : signed(15 downto 0) := (others => '0');
    signal wi_r      : signed(15 downto 0) := (others => '0');
    signal ia_r      : unsigned(7 downto 0) := (others => '0');
    signal ib_r      : unsigned(7 downto 0) := (others => '0');

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
begin
    peak_word <= word_r;

    -- True dual-port, чтение и запись в разных тактах бабочки (не same-addr).
    ram_p : process(clock)
    begin
        if rising_edge(clock) then
            q_a <= ram(to_integer(addr_a));
            q_b <= ram(to_integer(addr_b));
            if we_a = '1' then
                ram(to_integer(addr_a)) <= din_a;
            end if;
            if we_b = '1' then
                ram(to_integer(addr_b)) <= din_b;
            end if;
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
        variable skip_dc : boolean;
        variable ii, qq  : signed(15 downto 0);
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
            we_a      <= '0';
            we_b      <= '0';
            addr_a    <= (others => '0');
            addr_b    <= (others => '0');
            din_a     <= (others => '0');
            din_b     <= (others => '0');
        elsif rising_edge(clock) then
            we_a <= '0';
            we_b <= '0';

            if enable = '0' then
                state     <= ST_COLLECT;
                collect_n <= (others => '0');
                valid_r   <= '0';
                word_r    <= (others => '0');
            else
                case state is
                    when ST_COLLECT =>
                        if in_valid = '1' then
                            addr_a    <= bitrev8(collect_n(7 downto 0));
                            din_a     <= pack_iq(in_i, in_q);
                            we_a      <= '1';
                            collect_n <= collect_n + 1;
                            if collect_n = 255 then
                                collect_n <= (others => '0');
                                stage     <= (others => '0');
                                pair      <= (others => '0');
                                state     <= ST_FFT_RD;
                            end if;
                        end if;

                    when ST_FFT_RD =>
                        -- ia = (pair>>stage)<<(stage+1) + (pair&(half-1)); без mul на 256
                        half := shift_left(to_unsigned(1, 8), to_integer(stage));
                        j    := resize(pair, 8) and (half - 1);
                        grp  := shift_right(resize(pair, 8), to_integer(stage));
                        ia   := shift_left(grp, to_integer(stage) + 1) + j;
                        ib   := ia + half;
                        tw_idx := shift_left(j, 8 - to_integer(stage) - 1);
                        addr_a <= ia;
                        addr_b <= ib;
                        ia_r   <= ia;
                        ib_r   <= ib;
                        wr_r   <= LEGION_TWIDDLE_RE(to_integer(tw_idx));
                        wi_r   <= LEGION_TWIDDLE_IM(to_integer(tw_idx));
                        state  <= ST_FFT_WR;

                    when ST_FFT_WR =>
                        a_i_r <= signed(q_a(31 downto 16));
                        a_q_r <= signed(q_a(15 downto 0));
                        b_i_r <= signed(q_b(31 downto 16));
                        b_q_r <= signed(q_b(15 downto 0));
                        -- W*B в Q15, затем A±T и >>1 (R2FFT scale-per-stage)
                        pr := wr_r * signed(q_b(31 downto 16)) - wi_r * signed(q_b(15 downto 0));
                        pi := wr_r * signed(q_b(15 downto 0)) + wi_r * signed(q_b(31 downto 16));
                        tr := resize(shift_right(pr, 15), 16);
                        ti := resize(shift_right(pi, 15), 16);
                        sa := resize(signed(q_a(31 downto 16)), 17) + resize(tr, 17);
                        da := resize(signed(q_a(31 downto 16)), 17) - resize(tr, 17);
                        sb := resize(signed(q_a(15 downto 0)), 17) + resize(ti, 17);
                        db := resize(signed(q_a(15 downto 0)), 17) - resize(ti, 17);
                        addr_a <= ia_r;
                        addr_b <= ib_r;
                        din_a  <= pack_iq(resize(shift_right(sa, 1), 16),
                                          resize(shift_right(sb, 1), 16));
                        din_b  <= pack_iq(resize(shift_right(da, 1), 16),
                                          resize(shift_right(db, 1), 16));
                        we_a   <= '1';
                        we_b   <= '1';
                        if pair = 127 then
                            pair <= (others => '0');
                            if stage = 7 then
                                peak_i   <= (others => '0');
                                best_bin <= (others => '0');
                                best_mag <= (others => '0');
                                state    <= ST_PEAK_RD;
                            else
                                stage <= stage + 1;
                                state <= ST_FFT_RD;
                            end if;
                        else
                            pair  <= pair + 1;
                            state <= ST_FFT_RD;
                        end if;

                    when ST_PEAK_RD =>
                        addr_a <= peak_i(7 downto 0);
                        state  <= ST_PEAK_CMP;

                    when ST_PEAK_CMP =>
                        ii := signed(q_a(31 downto 16));
                        qq := signed(q_a(15 downto 0));
                        mag := unsigned(ii * ii) + unsigned(qq * qq);
                        skip_dc := (dc_notch = '1') and (peak_i = 0);
                        if (not skip_dc) and mag > best_mag then
                            best_mag <= mag;
                            best_bin <= peak_i(7 downto 0);
                        end if;
                        if peak_i = 255 then
                            state <= ST_PUBLISH;
                        else
                            peak_i <= peak_i + 1;
                            state  <= ST_PEAK_RD;
                        end if;

                    when ST_PUBLISH =>
                        valid_r <= '1';
                        frame_r <= frame_r + 1;
                        word_r(7 downto 0)   <= std_logic_vector(best_bin);
                        word_r(23 downto 8)  <= std_logic_vector(best_mag(31 downto 16));
                        word_r(30 downto 24) <= std_logic_vector(frame_r + 1);
                        word_r(31)           <= '1';
                        collect_n            <= (others => '0');
                        state                <= ST_COLLECT;
                end case;
            end if;
        end if;
    end process;
end architecture;
