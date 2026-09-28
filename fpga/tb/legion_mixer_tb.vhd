-- Тестбенч legion_mixer: FTW=0 обход; смесь с cos=max sin=0 ≈ масштаб;
-- смесь с LO=j (cos=0 sin=max) крутит I→−Q, Q→I.
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity legion_mixer_tb is
end entity;

architecture tb of legion_mixer_tb is
    signal clock     : std_logic := '0';
    signal reset     : std_logic := '1';
    signal mix_en    : std_logic := '0';
    signal sample_en : std_logic := '0';
    signal din       : std_logic_vector(31 downto 0) := (others => '0');
    signal lo_i      : signed(15 downto 0) := (others => '0');
    signal lo_q      : signed(15 downto 0) := (others => '0');
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
begin
    clock <= not clock after 5 ns when not done;

    dut : entity work.legion_mixer
        port map (
            clock => clock, reset => reset, mix_en => mix_en,
            sample_en => sample_en, din => din, lo_i => lo_i, lo_q => lo_q,
            dout => dout
        );

    stim : process
        variable yi, yq : integer;
    begin
        wait for 20 ns;
        reset <= '0';
        wait until rising_edge(clock);

        -- Обход: mix_en=0, dout=din на следующем sample_en (как смесь)
        mix_en <= '0';
        din <= pack_iq(1234, -5678);
        sample_en <= '1';
        wait until rising_edge(clock);
        sample_en <= '0';
        wait until rising_edge(clock);
        assert unpack_i(dout) = 1234 and unpack_q(dout) = -5678
            report "FAIL: bypass mix_en=0" severity failure;

        -- LO = (32752, 0) ≈ +1: I и Q сохраняют знак, масштаб ≈ 1
        mix_en <= '1';
        lo_i <= to_signed(32752, 16);
        lo_q <= to_signed(0, 16);
        din <= pack_iq(16000, -8000);
        sample_en <= '1';
        wait until rising_edge(clock);
        sample_en <= '0';
        wait until rising_edge(clock);
        yi := unpack_i(dout);
        yq := unpack_q(dout);
        assert abs(yi - 16000) < 80 and abs(yq + 8000) < 80
            report "FAIL: mix * (1+0j) yi=" & integer'image(yi) &
                   " yq=" & integer'image(yq) severity failure;

        -- LO = (0, 32752) ≈ +j: (I+jQ)*j = −Q + jI
        lo_i <= to_signed(0, 16);
        lo_q <= to_signed(32752, 16);
        din <= pack_iq(10000, 2000);
        sample_en <= '1';
        wait until rising_edge(clock);
        sample_en <= '0';
        wait until rising_edge(clock);
        yi := unpack_i(dout);
        yq := unpack_q(dout);
        assert abs(yi + 2000) < 80 and abs(yq - 10000) < 80
            report "FAIL: mix * j yi=" & integer'image(yi) &
                   " yq=" & integer'image(yq) severity failure;

        -- Снова обход после смеси
        mix_en <= '0';
        din <= pack_iq(-1, 2);
        sample_en <= '1';
        wait until rising_edge(clock);
        sample_en <= '0';
        wait until rising_edge(clock);
        assert unpack_i(dout) = -1 and unpack_q(dout) = 2
            report "FAIL: bypass after mix" severity failure;

        report "legion_mixer_tb: PASS" severity note;
        done <= true;
        wait;
    end process;
end architecture;
