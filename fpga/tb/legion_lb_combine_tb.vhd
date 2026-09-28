-- Тестбенч legion_lb_combine: один отвод, 0.5+0.5, знак I=−Q, насыщение.
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity legion_lb_combine_tb is
end entity;

architecture tb of legion_lb_combine_tb is
    signal clock     : std_logic := '0';
    signal reset     : std_logic := '1';
    signal sample_en : std_logic := '0';
    signal amp0      : unsigned(15 downto 0) := to_unsigned(32767, 16);
    signal amp1      : unsigned(15 downto 0) := (others => '0');
    signal din0      : std_logic_vector(31 downto 0) := (others => '0');
    signal din1      : std_logic_vector(31 downto 0) := (others => '0');
    signal dout      : std_logic_vector(31 downto 0);
    signal done      : boolean := false;

    function pack_iq(i, q : integer) return std_logic_vector is
    begin
        return std_logic_vector(to_signed(i, 16)) & std_logic_vector(to_signed(q, 16));
    end function;

    function unpack_i(w : std_logic_vector) return integer is
    begin
        return to_integer(signed(w(31 downto 16)));
    end function;

    function unpack_q(w : std_logic_vector) return integer is
    begin
        return to_integer(signed(w(15 downto 0)));
    end function;

    procedure pulse(signal clk : in std_logic; signal en : out std_logic) is
    begin
        en <= '1';
        wait until rising_edge(clk);
        en <= '0';
        wait until rising_edge(clk);
    end procedure;
begin
    clock <= not clock after 5 ns when not done;

    dut : entity work.legion_lb_combine
        port map (
            clock => clock, reset => reset, sample_en => sample_en,
            amp0 => amp0, amp1 => amp1, din0 => din0, din1 => din1, dout => dout
        );

    stim : process
        variable yi, yq : integer;
    begin
        wait for 20 ns;
        reset <= '0';
        wait until rising_edge(clock);

        -- A1=0, A0≈1: dout ≈ din0, знак Q
        din0 <= pack_iq(16000, -8000);
        din1 <= pack_iq(12000, 3000);
        pulse(clock, sample_en);
        yi := unpack_i(dout);
        yq := unpack_q(dout);
        assert abs(yi - 16000) < 4 and abs(yq + 8000) < 4
            report "FAIL: single tap A1=0 yi=" & integer'image(yi) &
                   " yq=" & integer'image(yq) severity failure;

        -- 0.5+0.5 одинаковых → исходная амплитуда
        amp0 <= to_unsigned(16384, 16);
        amp1 <= to_unsigned(16384, 16);
        din0 <= pack_iq(16000, -8000);
        din1 <= pack_iq(16000, -8000);
        pulse(clock, sample_en);
        yi := unpack_i(dout);
        yq := unpack_q(dout);
        assert abs(yi - 16000) < 4 and abs(yq + 8000) < 4
            report "FAIL: 0.5+0.5 yi=" & integer'image(yi) &
                   " yq=" & integer'image(yq) severity failure;

        -- два разных отвода
        din0 <= pack_iq(8000, 2000);
        din1 <= pack_iq(4000, -6000);
        pulse(clock, sample_en);
        yi := unpack_i(dout);
        yq := unpack_q(dout);
        assert abs(yi - 6000) < 4 and abs(yq + 2000) < 4
            report "FAIL: sum 0.5+0.5 mixed yi=" & integer'image(yi) &
                   " yq=" & integer'image(yq) severity failure;

        -- насыщение
        amp0 <= to_unsigned(32767, 16);
        amp1 <= to_unsigned(32767, 16);
        din0 <= pack_iq(20000, -20000);
        din1 <= pack_iq(20000, -20000);
        pulse(clock, sample_en);
        yi := unpack_i(dout);
        yq := unpack_q(dout);
        assert yi = 32767 and yq = -32768
            report "FAIL: sat yi=" & integer'image(yi) &
                   " yq=" & integer'image(yq) severity failure;

        -- без sample_en выход застывает
        din0 <= pack_iq(1, 2);
        din1 <= pack_iq(3, 4);
        wait until rising_edge(clock);
        wait until rising_edge(clock);
        assert unpack_i(dout) = 32767
            report "FAIL: frozen without sample_en" severity failure;

        report "legion_lb_combine_tb: PASS" severity note;
        done <= true;
        wait;
    end process;
end architecture;
