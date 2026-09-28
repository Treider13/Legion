-- Тестбенч legion_lb_aim: FTW = signed_bin≪24 для каждой группы.
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity legion_lb_aim_tb is
end entity;

architecture tb of legion_lb_aim_tb is
    signal ch_target : unsigned(1 downto 0) := "00";
    signal ch_bins   : std_logic_vector(31 downto 0) := x"F0801000";
    signal ftw       : unsigned(31 downto 0);
    signal done      : boolean := false;
begin
    dut : entity work.legion_lb_aim
        port map (ch_target => ch_target, ch_bins => ch_bins, ftw => ftw);

    stim : process
        variable b : signed(7 downto 0);
    begin
        wait for 1 ns;
        -- group0 bin 0 → FTW 0
        assert ftw = 0 report "FAIL: bin0 FTW" severity failure;

        ch_target <= "01";
        wait for 1 ns;
        b := signed(ch_bins(15 downto 8)); -- 0x10 = 16
        assert ftw = unsigned(shift_left(resize(b, 32), 24))
            report "FAIL: group1 FTW" severity failure;

        ch_target <= "10";
        wait for 1 ns;
        b := signed(ch_bins(23 downto 16)); -- 0x80 = −128
        assert ftw = unsigned(shift_left(resize(b, 32), 24))
            report "FAIL: group2 signed FTW" severity failure;

        ch_target <= "11";
        wait for 1 ns;
        b := signed(ch_bins(31 downto 24)); -- 0xF0 = −16
        assert ftw = unsigned(shift_left(resize(b, 32), 24))
            report "FAIL: group3 signed FTW" severity failure;

        report "legion_lb_aim_tb: PASS" severity note;
        done <= true;
        wait;
    end process;
end architecture;
