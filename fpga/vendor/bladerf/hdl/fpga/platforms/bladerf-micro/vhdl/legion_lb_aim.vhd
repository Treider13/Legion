-- ============================================================================
-- LEGION — FTW aim-NCO по CH_TARGET (tx_clock).
-- CH_TARGET — номер FFT-бина 0..255. FTW = signed_bin≪24
-- (та же формула, что legion_lb_xlat / legion_nco: f = k·fs/256).
-- Сам синус — существующий legion_nco; этот блок только маппер.
-- ============================================================================
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity legion_lb_aim is
    port (
        ch_target : in  unsigned(7 downto 0);
        ftw       : out unsigned(31 downto 0)
    );
end entity;

architecture rtl of legion_lb_aim is
begin
    process(ch_target)
        variable bin : signed(7 downto 0);
    begin
        bin := signed(ch_target);
        ftw <= unsigned(shift_left(resize(bin, 32), 24));
    end process;
end architecture;
