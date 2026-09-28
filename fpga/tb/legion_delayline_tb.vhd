-- Тестбенч legion_delayline: обход delay=0, задержка N сэмплов, не трогает
-- вход, когда sample_en=0.
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
use work.legion_pkg.all;

entity legion_delayline_tb is
end entity;

architecture tb of legion_delayline_tb is
    signal clock     : std_logic := '0';
    signal reset     : std_logic := '1';
    signal delay     : unsigned(11 downto 0) := (others => '0');
    signal din       : std_logic_vector(31 downto 0) := (others => '0');
    signal sample_en : std_logic := '0';
    signal dout      : std_logic_vector(31 downto 0);
    signal captured  : std_logic_vector(31 downto 0) := (others => '0');
    signal done      : boolean := false;

    function sample(n : natural) return std_logic_vector is
    begin
        return std_logic_vector(to_unsigned(n, 16)) & std_logic_vector(to_unsigned(n + 7, 16));
    end function;
begin
    clock <= not clock after 5 ns when not done;

    dut : entity work.legion_delayline
        port map (
            clock => clock, reset => reset,
            delay => delay, din => din, sample_en => sample_en, dout => dout
        );

    -- Как mux: захват dout на том же фронте, что sample_en.
    process(clock)
    begin
        if rising_edge(clock) then
            if sample_en = '1' then
                captured <= dout;
            end if;
        end if;
    end process;

    stim : process
    begin
        wait until rising_edge(clock);
        wait until rising_edge(clock);
        reset <= '0';
        wait until rising_edge(clock);

        -- delay=0: dout = din даже без sample_en
        din <= sample(3);
        wait until rising_edge(clock);
        assert dout = sample(3) report "FAIL: bypass without sample_en" severity failure;

        sample_en <= '1';
        din <= sample(9);
        wait until rising_edge(clock);
        assert dout = sample(9) report "FAIL: bypass with sample_en" severity failure;
        sample_en <= '0';

        -- delay=1: регистр din. Первый захват — ноль, дальше предыдущий сэмпл.
        delay <= to_unsigned(1, 12);
        wait until rising_edge(clock);
        din <= sample(20);
        sample_en <= '1';
        wait until rising_edge(clock);
        sample_en <= '0';
        wait until rising_edge(clock);
        assert unsigned(captured) = 0 report "FAIL: delay=1 first not silent" severity failure;
        din <= sample(21);
        sample_en <= '1';
        wait until rising_edge(clock);
        sample_en <= '0';
        wait until rising_edge(clock);
        assert captured = sample(20) report "FAIL: delay=1 not previous sample" severity failure;

        reset <= '1';
        wait until rising_edge(clock);
        reset <= '0';
        wait until rising_edge(clock);

        -- delay=4: первые 4 выдачи — нули, затем din[k-4]
        delay <= to_unsigned(4, 12);
        wait until rising_edge(clock);
        for i in 10 to 20 loop
            din <= sample(i);
            sample_en <= '1';
            wait until rising_edge(clock);
            sample_en <= '0';
            wait until rising_edge(clock);
            if i < 14 then
                assert unsigned(captured) = 0
                    report "FAIL: delay pipeline not silent" severity failure;
            else
                assert captured = sample(i - 4)
                    report "FAIL: delay 4 mismatch" severity failure;
            end if;
        end loop;

        -- Без sample_en указатель не шагает
        din <= sample(99);
        wait until rising_edge(clock);
        wait until rising_edge(clock);
        assert captured = sample(16)
            report "FAIL: frozen without sample_en" severity failure;

        report "legion_delayline_tb: PASS" severity note;
        done <= true;
        wait;
    end process;
end architecture;
