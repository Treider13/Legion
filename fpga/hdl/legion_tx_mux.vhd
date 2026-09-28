-- ============================================================================
-- LEGION — мультиплексор TX-источника (tx_clock домен).
-- Источники: 0=поток хоста (fifo_reader), 1=плеер RAM, 2=NCO,
--            3=loopback по детектору, 4=loopback всегда, 5=aim (NCO).
-- ARM=0 / watchdog expired / источник не готов → ТИШИНА: нули с каденсом
-- valid каждый 2-й такт (lms6002d.vhd: valid=0 + enable=1 держит ПОСЛЕДНИЙ
-- сэмпл на DAC — поэтому тишина обязана гнать нули с valid, а не молчать).
-- Спад det_active в LB_GATED — не ступенька last→0, а ramp-down:
-- (lb×k)/32, k=31..1 за валид (~16 мкс на 2 MSPS); возврат энергии рампу
-- отменяет мгновенно, авария (live=0) рампы не делает — нули сразу.
-- ЦАП по умолчанию 0.9 Q15 (LEGION_LB_AMP_Q15): NCO, lb_gated и
-- lb_always масштабирует mux. PASS и PLAYER идут сквозь — хост уже
-- кладёт дефолт 0.9, повторный масштаб дал бы 0.81.
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
        play_en      : in  std_logic;  -- 1 = плеер крутит RAM (каденс его)
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
    -- Предыдущий play_valid: слот Q после последнего сэмпла (play_en уже 0).
    signal play_valid_d : std_logic;

    -- Модуль × Q15, затем знак: ASR отрицательных дал бы I ≠ −Q.
    function lb_amp_q15(x : signed(15 downto 0)) return signed is
        variable ext  : signed(16 downto 0);
        variable mag  : unsigned(16 downto 0);
        variable prod : unsigned(32 downto 0);
        variable y    : signed(15 downto 0);
    begin
        ext := resize(x, 17);
        if ext < 0 then
            mag := unsigned(-ext);
        else
            mag := unsigned(ext);
        end if;
        prod := mag * to_unsigned(LEGION_LB_AMP_Q15, 16);
        y := signed(prod(30 downto 15));
        if ext < 0 then
            return -y;
        end if;
        return y;
    end function;
begin
    live <= arm and wd_ok;

    process(clock, reset)
        variable gi : signed(15 downto 0);
        variable gq : signed(15 downto 0);
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
            det_d        <= '0';
            ramping      <= '0';
            ramp_k       <= (others => '0');
            play_valid_d <= '0';
        elsif rising_edge(clock) then
            lb_rd_en <= '0';
            lb_valid <= '0';
            play_valid_d <= play_valid;

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
                    -- Три разных «play_valid=0», их нельзя склеивать:
                    --   play_valid=1           — сэмпл плеера, каденс его;
                    --   play_en / play_valid_d — межсэмпловый слот Q
                    --     (lms6002d tx_sample: valid=0 + enable → Q из регистра;
                    --      valid=1 здесь сожрал бы Q и вставил лишний I=0);
                    --   иначе DELAY/пауза      — нули с каденсом mux, иначе
                    --     DAC держит последний сэмпл (увод → DC).
                    -- Фаза mux крутится всё время MODE_PLAYER, фаза плеера
                    -- сбрасывается при play_en=0. После DELAY они не совпадают.
                    if live = '1' and play_valid = '1' then
                        out_i <= play_i; out_q <= play_q; out_valid <= '1';
                    elsif live = '1' and (play_en = '1' or play_valid_d = '1') then
                        out_i <= (others => '0'); out_q <= (others => '0');
                        out_valid <= '0';
                    else
                        out_i <= (others => '0'); out_q <= (others => '0');
                        out_valid <= phase;
                    end if;
                when LEGION_MODE_NCO | LEGION_MODE_AIM =>
                    if live = '1' then
                        -- LUT NCO ≈ 1.0 (2047<<4). Масштаб на mux, не в
                        -- entity: legion_nco_tb держит контракт полной шкалы.
                        -- AIM — тот же тракт, FTW снаружи от legion_lb_aim.
                        out_i <= lb_amp_q15(nco_i);
                        out_q <= lb_amp_q15(nco_q);
                        out_valid <= nco_valid;
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
                        gi := lb_amp_q15(lb_i);
                        gq := lb_amp_q15(lb_q);
                        if lb_valid = '1' and (mode = LEGION_MODE_LB_ALWAYS or det_active = '1') then
                            out_i <= gi;
                            out_q <= gq;
                        elsif lb_valid = '1' and ramping = '1' then
                            -- Спад: сначала (lb × k)/32 как раньше, затем 0.9.
                            -- Рампа от уже масштабированного ломала I=−Q
                            -- (ASR отрицательных). |lb|≤32768 → ×31 < 2^20.
                            gi := resize(shift_right(resize(lb_i, 32) * to_integer(ramp_k), 5), 16);
                            gq := resize(shift_right(resize(lb_q, 32) * to_integer(ramp_k), 5), 16);
                            out_i <= lb_amp_q15(gi);
                            out_q <= lb_amp_q15(gq);
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
