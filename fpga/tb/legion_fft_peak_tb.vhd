-- Тестбенч legion_fft_peak: тон в бине 16 и 240 против numpy/R2FFT DIT-256.
-- DC-notch: DC+bin16 → пик 16. enable=0 → valid=0.
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
use ieee.math_real.all;
use work.legion_pkg.all;

entity legion_fft_peak_tb is
end entity;

architecture tb of legion_fft_peak_tb is
    signal clk      : std_logic := '0';
    signal rst      : std_logic := '1';
    signal en       : std_logic := '0';
    signal notch    : std_logic := '0';
    signal in_i     : signed(15 downto 0) := (others => '0');
    signal in_q     : signed(15 downto 0) := (others => '0');
    signal in_v     : std_logic := '0';
    signal peak     : std_logic_vector(31 downto 0);
    signal energy   : legion_ch_energy_t;
    signal bins     : std_logic_vector(63 downto 0);
    signal act      : std_logic_vector(7 downto 0);
    signal fs_hz    : unsigned(31 downto 0) := (others => '0');
    signal lo_khz   : unsigned(31 downto 0) := (others => '0');
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
            fs_hz => fs_hz, lo_khz => lo_khz,
            in_i => in_i, in_q => in_q, in_valid => in_v, peak_word => peak,
            ch_energy => energy, ch_bins => bins, ch_active => act
        );

    stim : process
        variable pw   : std_logic_vector(31 downto 0);
        variable bin  : integer;
        variable fr1  : integer;
        variable fr2  : integer;
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
        assert unsigned(bins(7 downto 0)) = 16
            report "FAIL: slot0 peak bin" severity failure;
        assert act(0) = '1'
            report "FAIL: slot0 active on bin16" severity failure;
        assert unsigned(energy(0)) /= 0
            report "FAIL: slot0 energy" severity failure;

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
        assert unsigned(bins(63 downto 56)) = 240
            report "FAIL: slot7 peak bin" severity failure;
        assert act(7) = '1'
            report "FAIL: slot7 active on bin240" severity failure;
        assert unsigned(energy(7)) /= 0
            report "FAIL: slot7 energy" severity failure;

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

        -- 10 МГц @ 40 MSPS, LO=2440: bin16 → 2442.5 МГц → слот 4 (2440–2450)
        en <= '0';
        wait until rising_edge(clk);
        wait until rising_edge(clk);
        fs_hz <= to_unsigned(40000000, 32);
        lo_khz <= to_unsigned(2440000, 32);
        en <= '1';
        notch <= '0';
        feed_tone(clk, in_i, in_q, in_v, 16, 20000.0, 0.0);
        wait_valid(clk, peak, pw);
        assert unsigned(energy(4)) /= 0
            report "FAIL: 10 MHz slot4 energy" severity failure;
        assert act(4) = '1'
            report "FAIL: 10 MHz slot4 active" severity failure;
        assert unsigned(bins(39 downto 32)) = 16
            report "FAIL: 10 MHz slot4 bin" severity failure;

        -- disable снимает valid
        en <= '0';
        for k in 0 to 4 loop wait until rising_edge(clk); end loop;
        assert peak(31) = '0' report "FAIL: valid stuck after disable" severity failure;

        report "legion_fft_peak_tb: PASS" severity note;
        done <= true;
        wait;
    end process;
end architecture;
