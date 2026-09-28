-- Тестбенч legion_fft_peak: тон в бине 16 и 240 против numpy/R2FFT DIT-256.
-- DC-notch: DC+bin16 → пик 16. enable=0 → valid=0.
-- Top-N: два тона → PEAK1 = второй local-max вне excl. mag_* last на bin 255.
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
use ieee.math_real.all;

entity legion_fft_peak_tb is
end entity;

architecture tb of legion_fft_peak_tb is
    signal clk      : std_logic := '0';
    signal rst      : std_logic := '1';
    signal en       : std_logic := '0';
    signal notch    : std_logic := '0';
    signal excl     : unsigned(7 downto 0) := to_unsigned(8, 8);
    signal in_i     : signed(15 downto 0) := (others => '0');
    signal in_q     : signed(15 downto 0) := (others => '0');
    signal in_v     : std_logic := '0';
    signal peak     : std_logic_vector(31 downto 0);
    signal peak1    : std_logic_vector(31 downto 0);
    signal peak2    : std_logic_vector(31 downto 0);
    signal peak3    : std_logic_vector(31 downto 0);
    signal mag_v    : std_logic := '0';
    signal mag_last : std_logic := '0';
    signal mag_bin  : unsigned(7 downto 0);
    signal mag_pow  : unsigned(15 downto 0);
    signal mag_fr   : unsigned(6 downto 0);
    signal done     : boolean := false;

    constant PI : real := 3.141592653589793;

    procedure feed_tone(signal c : in std_logic;
                        signal ii : out signed(15 downto 0);
                        signal qq : out signed(15 downto 0);
                        signal v  : out std_logic;
                        constant bin : in integer;
                        constant amp : in real;
                        constant dc  : in real) is
        variable th : real;
    begin
        for n in 0 to 255 loop
            th := 2.0 * PI * real(bin) * real(n) / 256.0;
            ii <= to_signed(integer(round(dc + amp * cos(th))), 16);
            qq <= to_signed(integer(round(amp * sin(th))), 16);
            v  <= '1';
            wait until rising_edge(c);
            v  <= '0';
            wait until rising_edge(c);
        end loop;
    end procedure;

    procedure feed_two(signal c : in std_logic;
                       signal ii : out signed(15 downto 0);
                       signal qq : out signed(15 downto 0);
                       signal v  : out std_logic;
                       constant bin_a : in integer;
                       constant amp_a : in real;
                       constant bin_b : in integer;
                       constant amp_b : in real) is
        variable th_a : real;
        variable th_b : real;
    begin
        for n in 0 to 255 loop
            th_a := 2.0 * PI * real(bin_a) * real(n) / 256.0;
            th_b := 2.0 * PI * real(bin_b) * real(n) / 256.0;
            ii <= to_signed(integer(round(amp_a * cos(th_a) + amp_b * cos(th_b))), 16);
            qq <= to_signed(integer(round(amp_a * sin(th_a) + amp_b * sin(th_b))), 16);
            v  <= '1';
            wait until rising_edge(c);
            v  <= '0';
            wait until rising_edge(c);
        end loop;
    end procedure;

    procedure wait_valid(signal c : in std_logic;
                         signal w : in std_logic_vector(31 downto 0);
                         variable pw : out std_logic_vector(31 downto 0)) is
        variable guard : integer := 0;
    begin
        while w(31) = '0' loop
            wait until rising_edge(c);
            guard := guard + 1;
            assert guard < 20000 report "FAIL: peak timeout" severity failure;
        end loop;
        pw := w;
    end procedure;
begin
    clk <= not clk after 10 ns when not done;

    dut : entity work.legion_fft_peak
        port map (
            clock => clk, reset => rst, enable => en, dc_notch => notch,
            excl => excl,
            in_i => in_i, in_q => in_q, in_valid => in_v,
            peak_word => peak, peak1_word => peak1,
            peak2_word => peak2, peak3_word => peak3,
            mag_valid => mag_v, mag_last => mag_last,
            mag_bin => mag_bin, mag_pow => mag_pow, mag_frame => mag_fr
        );

    stim : process
        variable pw   : std_logic_vector(31 downto 0);
        variable bin  : integer;
        variable fr1  : integer;
        variable fr2  : integer;
        variable saw_last : boolean;
        variable last_bin : integer;
    begin
        wait for 40 ns;
        rst <= '0';
        wait until rising_edge(clk);

        -- enable=0: valid остаётся 0
        en <= '0';
        for k in 0 to 20 loop
            wait until rising_edge(clk);
        end loop;
        assert peak(31) = '0' report "FAIL: valid while disabled" severity failure;

        -- тон bin 16
        en <= '1';
        notch <= '0';
        feed_tone(clk, in_i, in_q, in_v, 16, 20000.0, 0.0);
        wait_valid(clk, peak, pw);
        bin := to_integer(unsigned(pw(7 downto 0)));
        assert bin = 16
            report "FAIL: bin16 got " & integer'image(bin) severity failure;
        fr1 := to_integer(unsigned(pw(30 downto 24)));
        assert pw(31) = '1' report "FAIL: valid after bin16" severity failure;

        -- второй кадр: bin 240 (= −16). valid от кадра 16 ещё стоит —
        -- ждём смену frame, не первый valid.
        feed_tone(clk, in_i, in_q, in_v, 240, 20000.0, 0.0);
        for k in 0 to 20000 loop
            wait until rising_edge(clk);
            if peak(31) = '1' and to_integer(unsigned(peak(30 downto 24))) /= fr1 then
                exit;
            end if;
            assert k < 20000 report "FAIL: bin240 timeout" severity failure;
        end loop;
        bin := to_integer(unsigned(peak(7 downto 0)));
        fr2 := to_integer(unsigned(peak(30 downto 24)));
        assert bin = 240
            report "FAIL: bin240 got " & integer'image(bin) severity failure;
        assert fr2 /= fr1 report "FAIL: frame did not advance" severity failure;

        -- DC + bin16, notch: пик 16 (не 0)
        en <= '0';
        wait until rising_edge(clk);
        wait until rising_edge(clk);
        en <= '1';
        notch <= '1';
        feed_tone(clk, in_i, in_q, in_v, 16, 8000.0, 12000.0);
        wait_valid(clk, peak, pw);
        bin := to_integer(unsigned(pw(7 downto 0)));
        assert bin = 16
            report "FAIL: dc_notch peak got " & integer'image(bin) severity failure;

        -- disable снимает valid
        en <= '0';
        for k in 0 to 4 loop wait until rising_edge(clk); end loop;
        assert peak(31) = '0' report "FAIL: valid stuck after disable" severity failure;
        assert peak1(31) = '0' report "FAIL: peak1 stuck after disable" severity failure;

        -- два тона: argmax = 16, PEAK1 = 80 (excl=8, dist=64)
        en <= '1';
        notch <= '0';
        excl <= to_unsigned(8, 8);
        feed_two(clk, in_i, in_q, in_v, 16, 20000.0, 80, 12000.0);
        wait_valid(clk, peak, pw);
        bin := to_integer(unsigned(pw(7 downto 0)));
        assert bin = 16
            report "FAIL: two-tone peak0 got " & integer'image(bin) severity failure;
        assert peak1(31) = '1' report "FAIL: peak1 not valid" severity failure;
        assert to_integer(unsigned(peak1(7 downto 0))) = 80
            report "FAIL: peak1 bin got " &
                   integer'image(to_integer(unsigned(peak1(7 downto 0))))
            severity failure;
        assert unsigned(peak1(30 downto 24)) = unsigned(pw(30 downto 24))
            report "FAIL: peak1 frame != peak0" severity failure;

        -- mag_* last на bin 255 во время сбора спектра
        en <= '0';
        wait until rising_edge(clk);
        wait until rising_edge(clk);
        en <= '1';
        saw_last := false;
        last_bin := -1;
        feed_tone(clk, in_i, in_q, in_v, 16, 20000.0, 0.0);
        for k in 0 to 20000 loop
            wait until rising_edge(clk);
            if mag_v = '1' and mag_last = '1' then
                saw_last := true;
                last_bin := to_integer(mag_bin);
            end if;
            if peak(31) = '1' then
                exit;
            end if;
        end loop;
        assert saw_last report "FAIL: mag_last never pulsed" severity failure;
        assert last_bin = 255
            report "FAIL: mag_last bin got " & integer'image(last_bin)
            severity failure;

        report "legion_fft_peak_tb: PASS" severity note;
        done <= true;
        wait;
    end process;
end architecture;
