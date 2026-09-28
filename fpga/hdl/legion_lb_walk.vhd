-- ============================================================================
-- LEGION — шаг отвода живой delayline (tx_clock).
-- mesarcik/DRFM: rdaddress -= delay. RFSoC 2026: круговой URAM, чтение через N.
-- Не плеер: нет capture, нет тишины DELAY 0x1F. Тишина — не дальность.
-- EN=0: tap = LB_DELAY, как сейчас. STEP=0: отвод застывает.
-- Фронт det_active: tap += STEP, потолок min(WALK_MAX, 4095); 0 = 4095.
-- HOLD: на потолке остаться. Иначе сброс к LB_DELAY.
-- Единица — сэмпл отвода, не период ожидания плеера.
-- ============================================================================
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
use work.legion_pkg.all;

entity legion_lb_walk is
    port (
        clock       : in  std_logic;
        reset       : in  std_logic;
        enable      : in  std_logic;
        arm         : in  std_logic;
        hold_max    : in  std_logic;
        delay_init  : in  unsigned(11 downto 0);
        walk_step   : in  unsigned(31 downto 0);
        walk_max    : in  unsigned(31 downto 0);
        det_active  : in  std_logic;
        tap         : out unsigned(11 downto 0);
        cur_delay   : out unsigned(31 downto 0)
    );
end entity;

architecture rtl of legion_lb_walk is
    signal tap_r   : unsigned(11 downto 0);
    signal det_d   : std_logic;
    signal init_d  : unsigned(11 downto 0);
    signal run     : std_logic;

    function tap_cap(mx : unsigned(31 downto 0)) return unsigned is
        variable cap : unsigned(11 downto 0);
    begin
        cap := to_unsigned(LEGION_RAM_DEPTH - 1, 12);
        if mx /= 0 and mx < resize(cap, 32) then
            return mx(11 downto 0);
        end if;
        return cap;
    end function;

    function next_tap(cur : unsigned(11 downto 0);
                      step : unsigned(31 downto 0);
                      init : unsigned(11 downto 0);
                      mx : unsigned(31 downto 0);
                      hold : std_logic) return unsigned is
        variable cap : unsigned(11 downto 0);
        variable acc : unsigned(31 downto 0);
    begin
        if step = 0 then
            return cur;
        end if;
        cap := tap_cap(mx);
        acc := resize(cur, 32) + step;
        if acc > resize(cap, 32) then
            if hold = '1' then
                return cap;
            end if;
            return init;
        end if;
        return acc(11 downto 0);
    end function;
begin
    run       <= enable and arm;
    tap       <= delay_init when run = '0' else tap_r;
    cur_delay <= resize(delay_init, 32) when run = '0' else resize(tap_r, 32);

    control : process(clock, reset)
    begin
        if reset = '1' then
            tap_r  <= (others => '0');
            det_d  <= '0';
            init_d <= (others => '0');
        elsif rising_edge(clock) then
            det_d  <= det_active;
            init_d <= delay_init;
            if run = '0' then
                tap_r <= delay_init;
            elsif delay_init /= init_d then
                -- Хост сменил LB_DELAY — отвод с нового старта, не со старого шага.
                tap_r <= delay_init;
            elsif det_active = '1' and det_d = '0' then
                tap_r <= next_tap(tap_r, walk_step, delay_init, walk_max, hold_max);
            end if;
        end if;
    end process;
end architecture;
