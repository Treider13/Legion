-- ============================================================================
-- LEGION — цифровой вырез пика на стоящем LO (rx_clock).
-- Как GNU Radio freq_xlating_fir_filter и bladeRF-wiphy NCO×IQ:
--   (I+jQ)·(cos−j·sin) → MA-16 → (I'+jQ')·(cos+j·sin).
-- FTW = signed_bin≪24  (= k·fs/256, та же формула что legion_nco:
--   f = FTW·fs/2^32). LUT — копия legion_nco / gen_sine_lut.py.
-- Фаза шагает только на in_valid (каденс ADC, не свободный 2-такт NCO).
-- enable=0: in→out (walker / FFT выкл, замысел не ломаем).
-- enable=1 и peak.valid=0: нули с тем же valid (SEARCH после hop).
-- lock=1: FTW на защёлкнутом bin (обычный держит выдержку; NIOS читает live-пик).
-- Детектор остаётся на сыром ADC — здесь только то, что уходит в TX FIFO.
-- ============================================================================
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity legion_lb_xlat is
    port (
        clock     : in  std_logic;
        reset     : in  std_logic;
        enable    : in  std_logic;
        lock      : in  std_logic;
        peak_word : in  std_logic_vector(31 downto 0);
        in_i      : in  signed(15 downto 0);
        in_q      : in  signed(15 downto 0);
        in_valid  : in  std_logic;
        out_i     : out signed(15 downto 0);
        out_q     : out signed(15 downto 0);
        out_valid : out std_logic
    );
end entity;

architecture rtl of legion_lb_xlat is
    type lut_t is array (0 to 255) of unsigned(11 downto 0);
    constant QUARTER_SINE : lut_t := (
        12x"000", 12x"00D", 12x"019", 12x"026", 12x"032", 12x"03F", 12x"04B", 12x"058",
        12x"064", 12x"071", 12x"07E", 12x"08A", 12x"097", 12x"0A3", 12x"0B0", 12x"0BC",
        12x"0C9", 12x"0D5", 12x"0E2", 12x"0EE", 12x"0FB", 12x"107", 12x"113", 12x"120",
        12x"12C", 12x"139", 12x"145", 12x"152", 12x"15E", 12x"16A", 12x"177", 12x"183",
        12x"18F", 12x"19C", 12x"1A8", 12x"1B4", 12x"1C1", 12x"1CD", 12x"1D9", 12x"1E5",
        12x"1F1", 12x"1FE", 12x"20A", 12x"216", 12x"222", 12x"22E", 12x"23A", 12x"246",
        12x"252", 12x"25E", 12x"26A", 12x"276", 12x"282", 12x"28E", 12x"29A", 12x"2A6",
        12x"2B2", 12x"2BD", 12x"2C9", 12x"2D5", 12x"2E1", 12x"2EC", 12x"2F8", 12x"304",
        12x"30F", 12x"31B", 12x"327", 12x"332", 12x"33E", 12x"349", 12x"354", 12x"360",
        12x"36B", 12x"377", 12x"382", 12x"38D", 12x"398", 12x"3A4", 12x"3AF", 12x"3BA",
        12x"3C5", 12x"3D0", 12x"3DB", 12x"3E6", 12x"3F1", 12x"3FC", 12x"407", 12x"412",
        12x"41C", 12x"427", 12x"432", 12x"43D", 12x"447", 12x"452", 12x"45C", 12x"467",
        12x"471", 12x"47C", 12x"486", 12x"490", 12x"49B", 12x"4A5", 12x"4AF", 12x"4B9",
        12x"4C3", 12x"4CD", 12x"4D7", 12x"4E1", 12x"4EB", 12x"4F5", 12x"4FF", 12x"509",
        12x"513", 12x"51C", 12x"526", 12x"530", 12x"539", 12x"543", 12x"54C", 12x"555",
        12x"55F", 12x"568", 12x"571", 12x"57A", 12x"583", 12x"58D", 12x"596", 12x"59F",
        12x"5A7", 12x"5B0", 12x"5B9", 12x"5C2", 12x"5CB", 12x"5D3", 12x"5DC", 12x"5E4",
        12x"5ED", 12x"5F5", 12x"5FD", 12x"606", 12x"60E", 12x"616", 12x"61E", 12x"626",
        12x"62E", 12x"636", 12x"63E", 12x"646", 12x"64E", 12x"655", 12x"65D", 12x"665",
        12x"66C", 12x"674", 12x"67B", 12x"682", 12x"68A", 12x"691", 12x"698", 12x"69F",
        12x"6A6", 12x"6AD", 12x"6B4", 12x"6BB", 12x"6C1", 12x"6C8", 12x"6CF", 12x"6D5",
        12x"6DC", 12x"6E2", 12x"6E9", 12x"6EF", 12x"6F5", 12x"6FB", 12x"701", 12x"707",
        12x"70D", 12x"713", 12x"719", 12x"71F", 12x"724", 12x"72A", 12x"730", 12x"735",
        12x"73A", 12x"740", 12x"745", 12x"74A", 12x"74F", 12x"754", 12x"759", 12x"75E",
        12x"763", 12x"768", 12x"76D", 12x"771", 12x"776", 12x"77A", 12x"77F", 12x"783",
        12x"787", 12x"78C", 12x"790", 12x"794", 12x"798", 12x"79C", 12x"79F", 12x"7A3",
        12x"7A7", 12x"7AA", 12x"7AE", 12x"7B1", 12x"7B5", 12x"7B8", 12x"7BB", 12x"7BF",
        12x"7C2", 12x"7C5", 12x"7C8", 12x"7CA", 12x"7CD", 12x"7D0", 12x"7D3", 12x"7D5",
        12x"7D8", 12x"7DA", 12x"7DC", 12x"7DF", 12x"7E1", 12x"7E3", 12x"7E5", 12x"7E7",
        12x"7E9", 12x"7EB", 12x"7EC", 12x"7EE", 12x"7F0", 12x"7F1", 12x"7F3", 12x"7F4",
        12x"7F5", 12x"7F6", 12x"7F7", 12x"7F8", 12x"7F9", 12x"7FA", 12x"7FB", 12x"7FC",
        12x"7FD", 12x"7FD", 12x"7FE", 12x"7FE", 12x"7FE", 12x"7FF", 12x"7FF", 12x"7FF"
    );

    type ma_t is array (0 to 15) of signed(15 downto 0);
    signal phase_acc : unsigned(31 downto 0) := (others => '0');
    signal ma_i      : ma_t := (others => (others => '0'));
    signal ma_q      : ma_t := (others => (others => '0'));
    signal acc_i     : signed(20 downto 0) := (others => '0');
    signal acc_q     : signed(20 downto 0) := (others => '0');
    signal ma_bin    : signed(7 downto 0) := (others => '0');
    signal ma_have   : std_logic := '0';
    signal lock_bin  : signed(7 downto 0) := (others => '0');
    signal lock_have : std_logic := '0';
    signal out_i_r   : signed(15 downto 0) := (others => '0');
    signal out_q_r   : signed(15 downto 0) := (others => '0');
    signal out_v_r   : std_logic := '0';

    function sine_lookup(phase10 : unsigned(9 downto 0)) return signed is
        variable quad : unsigned(1 downto 0);
        variable idx  : unsigned(7 downto 0);
        variable val  : unsigned(11 downto 0);
        variable sgn  : std_logic;
    begin
        quad := phase10(9 downto 8);
        idx  := phase10(7 downto 0);
        if quad(0) = '1' then
            val := QUARTER_SINE(255 - to_integer(idx));
        else
            val := QUARTER_SINE(to_integer(idx));
        end if;
        sgn := quad(1);
        if sgn = '1' then
            return -signed(resize(val, 16));
        else
            return signed(resize(val, 16));
        end if;
    end function;

    -- 16×12 → >>11: полная шкала LUT 2047 ≈ 1.0 (не <<4 как тон NCO).
    function mix_sum(a, b, c, d : signed(15 downto 0); sub : boolean) return signed is
        variable p : signed(31 downto 0);
    begin
        if sub then
            p := (a * c) - (b * d);
        else
            p := (a * c) + (b * d);
        end if;
        return resize(shift_right(p, 11), 16);
    end function;
begin
    out_i     <= out_i_r;
    out_q     <= out_q_r;
    out_valid <= out_v_r;

    process(clock, reset)
        variable bin  : signed(7 downto 0);
        variable ftw  : unsigned(31 downto 0);
        variable c_i  : signed(15 downto 0);
        variable s_q  : signed(15 downto 0);
        variable d_i  : signed(15 downto 0);
        variable d_q  : signed(15 downto 0);
        variable b_i  : signed(15 downto 0);
        variable b_q  : signed(15 downto 0);
        variable a_i  : signed(20 downto 0);
        variable a_q  : signed(20 downto 0);
        variable flush : boolean;
    begin
        if reset = '1' then
            phase_acc <= (others => '0');
            ma_i      <= (others => (others => '0'));
            ma_q      <= (others => (others => '0'));
            acc_i     <= (others => '0');
            acc_q     <= (others => '0');
            ma_bin    <= (others => '0');
            ma_have   <= '0';
            lock_bin  <= (others => '0');
            lock_have <= '0';
            out_i_r   <= (others => '0');
            out_q_r   <= (others => '0');
            out_v_r   <= '0';
        elsif rising_edge(clock) then
            out_v_r <= '0';
            if enable = '0' then
                out_i_r   <= in_i;
                out_q_r   <= in_q;
                out_v_r   <= in_valid;
                ma_have   <= '0';
                lock_have <= '0';
                acc_i     <= (others => '0');
                acc_q     <= (others => '0');
                ma_i      <= (others => (others => '0'));
                ma_q      <= (others => (others => '0'));
            elsif peak_word(31) = '0' and not (lock = '1' and lock_have = '1') then
                out_i_r <= (others => '0');
                out_q_r <= (others => '0');
                out_v_r <= in_valid;
                ma_have <= '0';
                acc_i   <= (others => '0');
                acc_q   <= (others => '0');
                ma_i    <= (others => (others => '0'));
                ma_q    <= (others => (others => '0'));
            elsif in_valid = '1' then
                if lock = '1' and lock_have = '1' then
                    bin := lock_bin;
                else
                    bin := signed(peak_word(7 downto 0));
                    if lock = '1' then
                        lock_bin  <= bin;
                        lock_have <= '1';
                    else
                        lock_have <= '0';
                    end if;
                end if;
                ftw := unsigned(shift_left(resize(bin, 32), 24));
                flush := (ma_have = '0') or (bin /= ma_bin);
                c_i := sine_lookup(phase_acc(31 downto 22) + 256);
                s_q := sine_lookup(phase_acc(31 downto 22));
                -- down: (I+jQ)(cos−j sin)
                d_i := mix_sum(in_i, in_q, c_i, s_q, false);
                d_q := mix_sum(in_q, in_i, c_i, s_q, true);
                if flush then
                    a_i := resize(d_i, 21);
                    a_q := resize(d_q, 21);
                    ma_i    <= (others => (others => '0'));
                    ma_q    <= (others => (others => '0'));
                    ma_i(0) <= d_i;
                    ma_q(0) <= d_q;
                    ma_bin  <= bin;
                    ma_have <= '1';
                else
                    a_i := acc_i + resize(d_i, 21) - resize(ma_i(15), 21);
                    a_q := acc_q + resize(d_q, 21) - resize(ma_q(15), 21);
                    for k in 15 downto 1 loop
                        ma_i(k) <= ma_i(k - 1);
                        ma_q(k) <= ma_q(k - 1);
                    end loop;
                    ma_i(0) <= d_i;
                    ma_q(0) <= d_q;
                end if;
                acc_i <= a_i;
                acc_q <= a_q;
                b_i := resize(shift_right(a_i, 4), 16);
                b_q := resize(shift_right(a_q, 4), 16);
                -- up: (I'+jQ')(cos+j sin)
                out_i_r <= mix_sum(b_i, b_q, c_i, s_q, true);
                out_q_r <= mix_sum(b_i, b_q, s_q, c_i, false);
                out_v_r <= '1';
                phase_acc <= phase_acc + ftw;
            end if;
        end if;
    end process;
end architecture;
