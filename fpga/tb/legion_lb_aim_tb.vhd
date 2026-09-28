-- Тестбенч legion_lb_aim: FTW = signed(CH_TARGET)≪24 (номер бина).
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity legion_lb_aim_tb is
end entity;

architecture tb of legion_lb_aim_tb is
    signal ch_target : unsigned(7 downto 0) := (others => '0');
    signal ftw       : unsigned(31 downto 0);
    signal done      : boolean := false;
begin
    dut : entity work.legion_lb_aim
        port map (ch_target => ch_target, ftw => ftw);

    stim : process
        variable b : signed(7 downto 0);
    begin
        wait for 1 ns;
        -- bin 0 → FTW 0
        assert ftw = 0 report "FAIL: bin0 FTW" severity failure;

        ch_target <= to_unsigned(16, 8);
        wait for 1 ns;
        b := to_signed(16, 8);
        assert ftw = unsigned(shift_left(resize(b, 32), 24))
            report "FAIL: bin16 FTW" severity failure;

        ch_target <= to_unsigned(128, 8);
        wait for 1 ns;
        b := to_signed(-128, 8);
        assert ftw = unsigned(shift_left(resize(b, 32), 24))
            report "FAIL: bin128 signed FTW" severity failure;

        ch_target <= to_unsigned(240, 8);
        wait for 1 ns;
        b := to_signed(-16, 8);
        assert ftw = unsigned(shift_left(resize(b, 32), 24))
            report "FAIL: bin240 signed FTW" severity failure;

        report "legion_lb_aim_tb: PASS" severity note;
        done <= true;
        wait;
    end process;
end architecture;
