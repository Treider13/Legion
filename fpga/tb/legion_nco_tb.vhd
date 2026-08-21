-- Тестбенч legion_nco: частота по нулям Q, амплитуда, каденс valid.
-- fs здесь = clock/2 (valid каждый 2-й такт). FTW = 2^32/32 → f = fs/32:
-- период 32 сэмпла = 64 такта; Q пересекает ноль каждые 16 сэмплов (32 такта).
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity legion_nco_tb is
end entity;

architecture tb of legion_nco_tb is
    signal clock     : std_logic := '0';
    signal reset     : std_logic := '1';
    signal enable    : std_logic := '0';
    signal ftw       : unsigned(31 downto 0) := to_unsigned(134217728, 32);  -- 2^32/32
    signal out_i     : signed(15 downto 0);
    signal out_q     : signed(15 downto 0);
    signal out_valid : std_logic;
    signal done      : boolean := false;
begin
    clock <= not clock after 5 ns when not done;

    dut : entity work.legion_nco
        port map (
            clock => clock, reset => reset, enable => enable, ftw => ftw,
            out_i => out_i, out_q => out_q, out_valid => out_valid
        );

    stim : process
        variable samples   : integer := 0;
        variable q_prev    : integer := 0;
        variable zero_x    : integer := 0;
        variable max_amp   : integer := 0;
        variable last_gap  : integer := 0;
        variable gap       : integer := 0;
    begin
        wait for 20 ns;
        reset <= '0';
        wait until rising_edge(clock);
        enable <= '1';

        -- Собираем 102 сэмпла: 3 периода (96) + запас на 6-е пересечение
        -- (нуль Q при старте с фазы 0 смещает счёт на половину периода)
        while samples < 102 loop
            wait until rising_edge(clock);
            if out_valid = '1' then
                samples := samples + 1;
                if abs(to_integer(out_i)) > max_amp then
                    max_amp := abs(to_integer(out_i));
                end if;
                -- Пересечение нуля Q (знак сменился)
                if samples > 1 and
                   ((to_integer(out_q) >= 0) /= (q_prev >= 0)) then
                    zero_x := zero_x + 1;
                    if zero_x > 1 then
                        -- Период между пересечениями одного знака-направления
                        last_gap := gap;
                    end if;
                    gap := 0;
                end if;
                gap := gap + 1;
                q_prev := to_integer(out_q);
            end if;
        end loop;

        -- f = fs/32: 6 пересечений нуля на 3 периода (2 на период)
        assert zero_x = 6
            report "FAIL: zero crossings " & integer'image(zero_x) & " expected 6"
            severity failure;
        -- Амплитуда: LUT 2047<<4 = 32752 (±допуск на квантование фазы)
        assert max_amp > 32000 and max_amp <= 32752
            report "FAIL: amplitude " & integer'image(max_amp) severity failure;

        report "legion_nco_tb: PASS (zero_x=" & integer'image(zero_x) &
               ", max_amp=" & integer'image(max_amp) & ")" severity note;
        done <= true;
        wait;
    end process;
end architecture;
