-- ============================================================================
-- LEGION — watchdog (deadman) для автономного TX.
-- heartbeat_i — строб от хоста (через NIOS, синхронизирован снаружи).
-- Если за limit×2^16 тактов нет heartbeat → expired='1' (до сброса/нового ARM).
-- Единица limit: 65536 тактов tx_clock (при fs=2 МГц, tx_clock=4 МГц ≈ 16.4 мс).
-- ============================================================================
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity legion_watchdog is
    port (
        clock       : in  std_logic;
        reset       : in  std_logic;
        enable      : in  std_logic;   -- WD_EN из CTRL
        heartbeat   : in  std_logic;   -- строб (уже синхронизирован)
        limit       : in  unsigned(15 downto 0);
        expired     : out std_logic
    );
end entity;

architecture rtl of legion_watchdog is
    signal tick_cnt : unsigned(16 downto 0);
    signal life_cnt : unsigned(15 downto 0);
    signal exp_r    : std_logic;
begin
    expired <= exp_r;

    process(clock, reset)
    begin
        if reset = '1' then
            tick_cnt <= (others => '0');
            life_cnt <= (others => '0');
            exp_r    <= '0';
        elsif rising_edge(clock) then
            if enable = '0' then
                exp_r    <= '0';
                tick_cnt <= (others => '0');
                life_cnt <= (others => '0');
            elsif heartbeat = '1' then
                tick_cnt <= (others => '0');
                life_cnt <= (others => '0');
                exp_r    <= '0';
            elsif exp_r = '0' then
                tick_cnt <= tick_cnt + 1;
                if tick_cnt = 65535 then
                    tick_cnt <= (others => '0');
                    if life_cnt = limit - 1 then
                        exp_r <= '1';
                    else
                        life_cnt <= life_cnt + 1;
                    end if;
                end if;
            end if;
        end if;
    end process;
end architecture;
