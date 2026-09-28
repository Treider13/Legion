-- ============================================================================
-- LEGION — шаг живых отводов delayline (tx_clock).
-- mesarcik/DRFM: rdaddress -= delay. ApplSci multi-scatterer: N отводов.
-- xA4: два отвода, глубина 4096. Не PRI-lock и не RFSoC 4×256 км.
-- EN=0: tap = init, FTW = init.
-- PERIOD=0: шаг по фронту det_active (как раньше).
-- PERIOD>0: шаг каждые PERIOD сэмплов, пока det_active=1 (лабораторные часы,
-- не строб дальности). STEP=0: застыть. HOLD: на потолке остаться.
-- FTW0 += WALK_FTW_STEP на том же шаге; FTW1 не ходит (вторая клетка).
-- ============================================================================
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
use work.legion_pkg.all;

entity legion_lb_walk is
    port (
        clock        : in  std_logic;
        reset        : in  std_logic;
        enable       : in  std_logic;
        arm          : in  std_logic;
        hold_max     : in  std_logic;
        delay_init   : in  unsigned(11 downto 0);
        delay1_init  : in  unsigned(11 downto 0);
        walk_step    : in  unsigned(31 downto 0);
        walk_max     : in  unsigned(31 downto 0);
        walk_period  : in  unsigned(31 downto 0);
        ftw0_init    : in  unsigned(31 downto 0);
        ftw1_init    : in  unsigned(31 downto 0);
        ftw_step     : in  unsigned(31 downto 0);
        det_active   : in  std_logic;
        sample_en    : in  std_logic;
        tap          : out unsigned(11 downto 0);
        tap1         : out unsigned(11 downto 0);
        ftw0         : out unsigned(31 downto 0);
        ftw1         : out unsigned(31 downto 0);
        cur_delay    : out unsigned(31 downto 0)
    );
end entity;

architecture rtl of legion_lb_walk is
    signal tap0_r   : unsigned(11 downto 0);
    signal tap1_r   : unsigned(11 downto 0);
    signal ftw0_r   : unsigned(31 downto 0);
    signal ftw1_r   : unsigned(31 downto 0);
    signal det_d    : std_logic;
    signal init0_d  : unsigned(11 downto 0);
    signal init1_d  : unsigned(11 downto 0);
    signal ftw0i_d  : unsigned(31 downto 0);
    signal ftw1i_d  : unsigned(31 downto 0);
    signal period_c : unsigned(31 downto 0);
    signal run      : std_logic;

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
    tap       <= delay_init when run = '0' else tap0_r;
    tap1      <= delay1_init when run = '0' else tap1_r;
    ftw0      <= ftw0_init when run = '0' else ftw0_r;
    ftw1      <= ftw1_init when run = '0' else ftw1_r;
    cur_delay <= resize(delay_init, 32) when run = '0' else resize(tap0_r, 32);

    control : process(clock, reset)
        variable do_step : boolean;
    begin
        if reset = '1' then
            tap0_r   <= (others => '0');
            tap1_r   <= (others => '0');
            ftw0_r   <= (others => '0');
            ftw1_r   <= (others => '0');
            det_d    <= '0';
            init0_d  <= (others => '0');
            init1_d  <= (others => '0');
            ftw0i_d  <= (others => '0');
            ftw1i_d  <= (others => '0');
            period_c <= (others => '0');
        elsif rising_edge(clock) then
            det_d   <= det_active;
            init0_d <= delay_init;
            init1_d <= delay1_init;
            ftw0i_d <= ftw0_init;
            ftw1i_d <= ftw1_init;
            do_step := false;

            if run = '0' then
                tap0_r   <= delay_init;
                tap1_r   <= delay1_init;
                ftw0_r   <= ftw0_init;
                ftw1_r   <= ftw1_init;
                period_c <= (others => '0');
            else
                if delay_init /= init0_d then
                    tap0_r <= delay_init;
                end if;
                if delay1_init /= init1_d then
                    tap1_r <= delay1_init;
                end if;
                if ftw0_init /= ftw0i_d then
                    ftw0_r <= ftw0_init;
                end if;
                if ftw1_init /= ftw1i_d then
                    ftw1_r <= ftw1_init;
                end if;

                if walk_period = 0 then
                    if det_d = '0' and det_active = '1' then
                        do_step := true;
                    end if;
                elsif det_active = '0' then
                    -- Пауза sample_en — не сэмпл, счётчик держать.
                    period_c <= (others => '0');
                elsif sample_en = '1' then
                    if period_c + 1 >= walk_period then
                        period_c <= (others => '0');
                        do_step := true;
                    else
                        period_c <= period_c + 1;
                    end if;
                end if;

                if do_step then
                    tap0_r <= next_tap(tap0_r, walk_step, delay_init, walk_max, hold_max);
                    tap1_r <= next_tap(tap1_r, walk_step, delay1_init, walk_max, hold_max);
                    ftw0_r <= ftw0_r + ftw_step;
                end if;
            end if;
        end if;
    end process;
end architecture;
