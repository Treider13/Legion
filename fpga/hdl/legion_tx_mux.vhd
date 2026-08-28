-- ============================================================================
-- LEGION — мультиплексор TX-источника (tx_clock домен).
-- Источники: 0=поток хоста (fifo_reader), 1=плеер RAM, 2=NCO,
--            3=loopback по детектору, 4=loopback всегда.
-- ARM=0 / watchdog expired / источник не готов → ТИШИНА: нули с каденсом
-- valid каждый 2-й такт (lms6002d.vhd: valid=0 + enable=1 держит ПОСЛЕДНИЙ
-- сэмпл на DAC — поэтому тишина обязана гнать нули с valid, а не молчать).
-- Loopback CDC: rd_data в нашем dcfifo комбинационна (действительна до
-- инкремента указателя) — захват на следующем такте после rd_en корректен.
-- ============================================================================
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
use work.legion_pkg.all;

entity legion_tx_mux is
    port (
        clock        : in  std_logic;
        reset        : in  std_logic;
        -- Управление (уже синхронизировано к tx_clock)
        arm          : in  std_logic;
        mode         : in  std_logic_vector(2 downto 0);
        wd_ok        : in  std_logic;  -- '1' = watchdog жив / выключен
        det_active   : in  std_logic;  -- синхронизирован к tx_clock
        lb_shift     : in  unsigned(3 downto 0);
        -- Источник 0: поток хоста (fifo_reader)
        host_i       : in  signed(15 downto 0);
        host_q       : in  signed(15 downto 0);
        host_valid   : in  std_logic;
        -- Источник 1: плеер
        play_i       : in  signed(15 downto 0);
        play_q       : in  signed(15 downto 0);
        play_valid   : in  std_logic;
        -- Источник 2: NCO
        nco_i        : in  signed(15 downto 0);
        nco_q        : in  signed(15 downto 0);
        nco_valid    : in  std_logic;
        -- Источник 3/4: loopback FIFO (читаем здесь)
        lb_data      : in  std_logic_vector(31 downto 0);
        lb_empty     : in  std_logic;
        lb_rd_en     : out std_logic;
        -- Выход в iq_correction (контракт LMS: valid каждый 2-й такт)
        out_i        : out signed(15 downto 0);
        out_q        : out signed(15 downto 0);
        out_valid    : out std_logic
    );
end entity;

architecture rtl of legion_tx_mux is
    signal phase    : std_logic;
    signal lb_valid : std_logic;
    signal lb_i     : signed(15 downto 0);
    signal lb_q     : signed(15 downto 0);
    signal live     : std_logic;  -- arm и wd_ok
    -- Ramp-down на спаде det_active в LB_GATED: 31 ступень ×1/32 за валид
    -- (~16 мкс на 2 MSPS) вместо ступеньки last→0 в эфир. Только спад
    -- энергии: live=0 (ARM=0 / watchdog expired) — авария, нули мгновенно.
    signal det_d    : std_logic;
    signal ramping  : std_logic;
    signal ramp_k   : unsigned(4 downto 0);
begin
    live <= arm and wd_ok;

    process(clock, reset)
    begin
        if reset = '1' then
            phase     <= '0';
            lb_valid  <= '0';
            lb_rd_en  <= '0';
            lb_i      <= (others => '0');
            lb_q      <= (others => '0');
            out_i     <= (others => '0');
            out_q     <= (others => '0');
            out_valid <= '0';
            det_d     <= '0';
            ramping   <= '0';
            ramp_k    <= (others => '0');
        elsif rising_edge(clock) then
            lb_rd_en <= '0';
            lb_valid <= '0';

            -- Фронт/спад det_active (уже синхронизирован к tx_clock снаружи).
            -- Спад → старт рампы; возврат энергии отменяет её мгновенно.
            det_d <= det_active;
            if mode = LEGION_MODE_LB_GATED and live = '1' then
                if det_active = '1' then
                    ramping <= '0';
                elsif det_d = '1' and det_active = '0' then
                    ramping <= '1';
                    ramp_k  <= to_unsigned(31, 5);
                end if;
            else
                ramping <= '0';
            end if;

            if mode /= LEGION_MODE_PASS then
                -- Каденс «каждый 2-й такт» для тишины и loopback-чтения
                phase <= not phase;
                if phase = '1' and live = '1'
                   and (mode = LEGION_MODE_LB_GATED or mode = LEGION_MODE_LB_ALWAYS)
                   and lb_empty = '0' then
                    lb_rd_en <= '1';
                end if;
                if lb_rd_en = '1' then
                    -- lb_data ещё показывает читаемый сэмпл (указатель FIFO
                    -- инкрементируется на этом же фронте после нас)
                    lb_i <= shift_left(resize(signed(lb_data(31 downto 16)), 16), to_integer(lb_shift));
                    lb_q <= shift_left(resize(signed(lb_data(15 downto 0)), 16), to_integer(lb_shift));
                    lb_valid <= '1';
                end if;
            else
                phase <= '0';
            end if;

            case mode is
                when LEGION_MODE_PASS =>
                    out_i     <= host_i;
                    out_q     <= host_q;
                    out_valid <= host_valid;
                when LEGION_MODE_PLAYER =>
                    if live = '1' then
                        out_i <= play_i; out_q <= play_q; out_valid <= play_valid;
                    else
                        out_i <= (others => '0'); out_q <= (others => '0');
                        out_valid <= phase;
                    end if;
                when LEGION_MODE_NCO =>
                    if live = '1' then
                        out_i <= nco_i; out_q <= nco_q; out_valid <= nco_valid;
                    else
                        out_i <= (others => '0'); out_q <= (others => '0');
                        out_valid <= phase;
                    end if;
                when LEGION_MODE_LB_GATED | LEGION_MODE_LB_ALWAYS =>
                    -- Каденс valid ВСЕГДА (когда live): FIFO пуст → нули,
                    -- иначе valid=0 надолго → DAC держит ПОСЛЕДНИЙ сэмпл
                    -- (lms6002d.vhd). Гейт (GATED) режет ДАННЫЕ, не каденс.
                    if live = '1' then
                        out_valid <= phase;
                        if lb_valid = '1' and (mode = LEGION_MODE_LB_ALWAYS or det_active = '1') then
                            out_i <= lb_i;
                            out_q <= lb_q;
                        elsif lb_valid = '1' and ramping = '1' then
                            -- Спад энергии: (lb × k)/32, k=31..1.
                            -- |lb|≤32768 → ×31 < 2^20, 32 бит хватает;
                            -- shift_right на signed — арифметический.
                            out_i <= resize(shift_right(resize(lb_i, 32) * to_integer(ramp_k), 5), 16);
                            out_q <= resize(shift_right(resize(lb_q, 32) * to_integer(ramp_k), 5), 16);
                            if ramp_k = 0 then
                                ramping <= '0';
                            else
                                ramp_k <= ramp_k - 1;
                            end if;
                        else
                            out_i <= (others => '0');
                            out_q <= (others => '0');
                        end if;
                    else
                        out_i <= (others => '0'); out_q <= (others => '0');
                        out_valid <= phase;
                    end if;
                when others =>
                    out_i <= (others => '0'); out_q <= (others => '0');
                    out_valid <= phase;
            end case;
        end if;
    end process;
end architecture;
