-- Тестбенч legion_lb_xlat: bypass; нули без valid; тон bin16 жив;
-- тон bin16 при пике bin80 глушится (MA-16 ноль на fs/4).
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
use ieee.math_real.all;

entity legion_lb_xlat_tb is
end entity;

architecture tb of legion_lb_xlat_tb is
    signal clk  : std_logic := '0';
    signal rst  : std_logic := '1';
    signal en   : std_logic := '0';
    signal peak : std_logic_vector(31 downto 0) := (others => '0');
    signal in_i : signed(15 downto 0) := (others => '0');
    signal in_q : signed(15 downto 0) := (others => '0');
    signal in_v : std_logic := '0';
    signal o_i  : signed(15 downto 0);
    signal o_q  : signed(15 downto 0);
    signal o_v  : std_logic;
    signal done : boolean := false;

    constant PI : real := 3.141592653589793;

    function mk_peak(bin : integer) return std_logic_vector is
        variable w : std_logic_vector(31 downto 0) := (others => '0');
    begin
        w(31) := '1';
        w(7 downto 0) := std_logic_vector(to_unsigned(bin, 8));
        return w;
    end function;

    procedure feed_tone(signal c : in std_logic;
                        signal ii : out signed(15 downto 0);
                        signal qq : out signed(15 downto 0);
                        signal v  : out std_logic;
                        constant bin : in integer;
                        constant n : in integer;
                        variable e_in : inout integer;
                        variable e_out : inout integer;
                        variable n_out : inout integer;
                        constant skip : in integer) is
        variable th : real;
        variable si : integer;
        variable sq : integer;
        variable so_i : integer;
        variable so_q : integer;
    begin
        for k in 0 to n - 1 loop
            th := 2.0 * PI * real(bin) * real(k) / 256.0;
            si := integer(round(4000.0 * cos(th)));
            sq := integer(round(4000.0 * sin(th)));
            ii <= to_signed(si, 16);
            qq <= to_signed(sq, 16);
            v  <= '1';
            wait until rising_edge(c);
            wait for 1 ns;
            if o_v = '1' then
                so_i := to_integer(o_i);
                so_q := to_integer(o_q);
                if k >= skip then
                    e_in := e_in + si * si + sq * sq;
                    e_out := e_out + so_i * so_i + so_q * so_q;
                    n_out := n_out + 1;
                end if;
            end if;
            v  <= '0';
            wait until rising_edge(c);
        end loop;
    end procedure;
begin
    clk <= not clk after 10 ns when not done;

    dut : entity work.legion_lb_xlat
        port map (
            clock => clk, reset => rst, enable => en, peak_word => peak,
            in_i => in_i, in_q => in_q, in_valid => in_v,
            out_i => o_i, out_q => o_q, out_valid => o_v
        );

    stim : process
        variable e_in  : integer;
        variable e_out : integer;
        variable n_out : integer;
    begin
        wait for 40 ns;
        rst <= '0';
        wait until rising_edge(clk);

        -- enable=0: выход = вход (1 такт)
        en <= '0';
        peak <= (others => '0');
        in_i <= to_signed(1234, 16);
        in_q <= to_signed(-4321, 16);
        in_v <= '1';
        wait until rising_edge(clk);
        wait for 1 ns;
        assert o_v = '1' and to_integer(o_i) = 1234 and to_integer(o_q) = -4321
            report "FAIL: bypass" severity failure;
        in_v <= '0';
        wait until rising_edge(clk);

        -- enable=1, valid=0: нули, каденс жив
        en <= '1';
        peak <= (others => '0');
        in_i <= to_signed(20000, 16);
        in_q <= to_signed(20000, 16);
        in_v <= '1';
        wait until rising_edge(clk);
        wait for 1 ns;
        assert o_v = '1' and to_integer(o_i) = 0 and to_integer(o_q) = 0
            report "FAIL: zeros without peak valid" severity failure;
        in_v <= '0';
        wait until rising_edge(clk);

        -- тон bin16 + пик bin16: энергия остаётся
        peak <= mk_peak(16);
        e_in := 0; e_out := 0; n_out := 0;
        feed_tone(clk, in_i, in_q, in_v, 16, 80, e_in, e_out, n_out, 20);
        assert n_out > 40
            report "FAIL: same-bin no samples" severity failure;
        assert e_out > e_in / 4
            report "FAIL: same-bin energy lost e_in=" & integer'image(e_in) &
                   " e_out=" & integer'image(e_out) severity failure;

        -- тон bin16 + пик bin80: MA-16 ноль на fs/4
        peak <= mk_peak(80);
        e_in := 0; e_out := 0; n_out := 0;
        feed_tone(clk, in_i, in_q, in_v, 16, 80, e_in, e_out, n_out, 20);
        assert n_out > 40
            report "FAIL: off-bin no samples" severity failure;
        assert e_out * 20 < e_in
            report "FAIL: off-bin not attenuated e_in=" & integer'image(e_in) &
                   " e_out=" & integer'image(e_out) severity failure;

        -- signed bin 200 (−56): свой тон жив
        peak <= mk_peak(200);
        e_in := 0; e_out := 0; n_out := 0;
        feed_tone(clk, in_i, in_q, in_v, 200, 80, e_in, e_out, n_out, 20);
        assert e_out > e_in / 4
            report "FAIL: neg-bin energy lost e_in=" & integer'image(e_in) &
                   " e_out=" & integer'image(e_out) severity failure;

        report "legion_lb_xlat_tb: PASS" severity note;
        done <= true;
        wait;
    end process;
end architecture;
