-- ============================================================================
-- LEGION — автомат лабораторного walk-off (tx_clock домен).
-- Последовательность: capture_arm → capture_done → delay → play_en.
-- После одного круга RAM задержка увеличивается на WALK_STEP (RGPO).
-- AUTO: старт/рецикл по det_active, захват с RX FIFO, не с хоста.
-- EN=0: прозрачный обход — как до модуля (play_en = MODE_PLAYER,
--   capture_arm = хост, сэмплы захвата = хост).
-- Единица DELAY/STEP/MAX — период сэмпла (каденс valid: каждый 2-й такт).
-- ============================================================================
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
use work.legion_pkg.all;

entity legion_walkoff is
    port (
        clock         : in  std_logic;
        reset         : in  std_logic;
        -- Конфигурация (уже в tx_clock)
        enable        : in  std_logic;
        auto          : in  std_logic;
        hold_max      : in  std_logic;
        delay_init    : in  unsigned(31 downto 0);
        walk_step     : in  unsigned(31 downto 0);
        walk_max      : in  unsigned(31 downto 0);
        len_m1        : in  unsigned(11 downto 0);
        lb_shift      : in  unsigned(3 downto 0);
        arm           : in  std_logic;
        mode_player   : in  std_logic;
        det_active    : in  std_logic;
        -- Хост (захват из fifo_reader)
        host_cap_arm  : in  std_logic;
        host_i        : in  signed(15 downto 0);
        host_q        : in  signed(15 downto 0);
        host_valid    : in  std_logic;
        -- RX FIFO в tx_clock (тот же dcfifo, что у lb_*)
        lb_data       : in  std_logic_vector(31 downto 0);
        lb_empty      : in  std_logic;
        lb_rd_en      : out std_logic;
        -- В плеер
        cap_i         : out signed(15 downto 0);
        cap_q         : out signed(15 downto 0);
        cap_valid     : out std_logic;
        capture_arm   : out std_logic;
        play_en       : out std_logic;
        -- Из плеера
        capture_done  : in  std_logic;
        play_valid    : in  std_logic;
        -- Статус
        delaying      : out std_logic;
        lb_need       : out std_logic;
        cur_delay     : out unsigned(31 downto 0);
        state         : out std_logic_vector(2 downto 0)
    );
end entity;

architecture rtl of legion_walkoff is
    signal st          : std_logic_vector(2 downto 0);
    signal delay_cnt   : unsigned(31 downto 0);
    signal delay_now   : unsigned(31 downto 0);
    signal play_cnt    : unsigned(11 downto 0);
    signal phase       : std_logic;
    signal cap_arm_r   : std_logic;
    signal play_en_r   : std_logic;
    signal lb_rd_r     : std_logic;
    signal cap_i_r     : signed(15 downto 0);
    signal cap_q_r     : signed(15 downto 0);
    signal cap_v_r     : std_logic;
    signal run         : std_logic;

    function next_delay(cur, step, init, mx : unsigned(31 downto 0);
                        hold : std_logic) return unsigned is
        variable sum : unsigned(31 downto 0);
        variable ov  : boolean;
    begin
        if step = 0 then
            return cur;
        end if;
        sum := cur + step;
        ov  := sum < cur;
        if ov or (mx /= 0 and sum > mx) then
            if hold = '1' then
                if mx /= 0 then
                    return mx;
                end if;
                return x"FFFFFFFF";
            end if;
            return init;
        end if;
        return sum;
    end function;
begin
    run <= enable and arm and mode_player;

    -- Обход: те же провода, что до модуля. Автомат не вмешивается.
    capture_arm <= host_cap_arm when (run = '0' or auto = '0') else cap_arm_r;
    play_en     <= mode_player  when run = '0' else play_en_r;
    cap_i       <= host_i       when (run = '0' or auto = '0') else cap_i_r;
    cap_q       <= host_q       when (run = '0' or auto = '0') else cap_q_r;
    cap_valid   <= host_valid   when (run = '0' or auto = '0') else cap_v_r;
    lb_rd_en    <= lb_rd_r      when (run = '1' and auto = '1') else '0';
    lb_need     <= run and auto;
    delaying    <= '1' when (run = '1' and st = LEGION_WALK_ST_DELAY) else '0';
    cur_delay   <= delay_now;
    state       <= st when run = '1' else LEGION_WALK_ST_IDLE;

    control : process(clock, reset)
    begin
        if reset = '1' then
            st        <= LEGION_WALK_ST_IDLE;
            delay_cnt <= (others => '0');
            delay_now <= (others => '0');
            play_cnt  <= (others => '0');
            phase     <= '0';
            cap_arm_r <= '0';
            play_en_r <= '0';
            lb_rd_r   <= '0';
            cap_i_r   <= (others => '0');
            cap_q_r   <= (others => '0');
            cap_v_r   <= '0';
        elsif rising_edge(clock) then
            lb_rd_r <= '0';
            cap_v_r <= '0';

            if run = '0' then
                st        <= LEGION_WALK_ST_IDLE;
                delay_cnt <= (others => '0');
                delay_now <= delay_init;
                play_cnt  <= (others => '0');
                phase     <= '0';
                cap_arm_r <= '0';
                play_en_r <= '0';
            else
                case st is
                    when LEGION_WALK_ST_IDLE =>
                        cap_arm_r <= '0';
                        play_en_r <= '0';
                        delay_now <= delay_init;
                        play_cnt  <= (others => '0');
                        phase     <= '0';
                        if auto = '1' then
                            st <= LEGION_WALK_ST_WAIT_DET;
                        elsif capture_done = '1' then
                            delay_cnt <= delay_init;
                            st        <= LEGION_WALK_ST_DELAY;
                        end if;

                    when LEGION_WALK_ST_WAIT_DET =>
                        cap_arm_r <= '0';
                        play_en_r <= '0';
                        phase     <= '0';
                        if det_active = '1' then
                            st <= LEGION_WALK_ST_CAPTURE;
                        end if;

                    when LEGION_WALK_ST_CAPTURE =>
                        cap_arm_r <= '1';
                        play_en_r <= '0';
                        -- Захват с FIFO: тот же каденс, что у mux (rd, затем valid).
                        phase <= not phase;
                        if phase = '1' and lb_empty = '0' then
                            lb_rd_r <= '1';
                        end if;
                        if lb_rd_r = '1' then
                            cap_i_r <= shift_left(signed(lb_data(31 downto 16)),
                                                  to_integer(lb_shift));
                            cap_q_r <= shift_left(signed(lb_data(15 downto 0)),
                                                  to_integer(lb_shift));
                            cap_v_r <= '1';
                        end if;
                        if capture_done = '1' then
                            cap_arm_r <= '0';
                            phase     <= '0';
                            delay_cnt <= delay_now;
                            st        <= LEGION_WALK_ST_DELAY;
                        end if;

                    when LEGION_WALK_ST_DELAY =>
                        cap_arm_r <= '0';
                        play_en_r <= '0';
                        if delay_cnt = 0 then
                            play_cnt  <= (others => '0');
                            phase     <= '0';
                            play_en_r <= '1';
                            st        <= LEGION_WALK_ST_PLAY;
                        else
                            phase <= not phase;
                            if phase = '1' then
                                delay_cnt <= delay_cnt - 1;
                            end if;
                        end if;

                    when LEGION_WALK_ST_PLAY =>
                        cap_arm_r <= '0';
                        play_en_r <= '1';
                        if play_valid = '1' then
                            if play_cnt = len_m1 then
                                play_en_r <= '0';
                                st        <= LEGION_WALK_ST_STEP;
                            else
                                play_cnt <= play_cnt + 1;
                            end if;
                        end if;

                    when LEGION_WALK_ST_STEP =>
                        cap_arm_r <= '0';
                        play_en_r <= '0';
                        delay_now <= next_delay(delay_now, walk_step, delay_init,
                                                walk_max, hold_max);
                        play_cnt  <= (others => '0');
                        phase     <= '0';
                        if auto = '1' then
                            st <= LEGION_WALK_ST_WAIT_DET;
                        else
                            delay_cnt <= next_delay(delay_now, walk_step, delay_init,
                                                    walk_max, hold_max);
                            st        <= LEGION_WALK_ST_DELAY;
                        end if;

                    when others =>
                        st        <= LEGION_WALK_ST_IDLE;
                        cap_arm_r <= '0';
                        play_en_r <= '0';
                end case;
            end if;
        end if;
    end process;
end architecture;
