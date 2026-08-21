-- ============================================================================
-- LEGION — энергетический детектор (rx_clock домен).
-- Окно 2^shift валидных сэмплов: acc = Σ(I²+Q²); в конце окна avg = acc>>shift
-- сравнивается с порогом. det_active — уровень «в окне была энергия»,
-- det_count — счётчик окон с детектом (для телеметрии хоста).
-- Референс архитектуры: bladeRF-shd (MIT, RIT) — та же плата, та же идея.
-- ============================================================================
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity legion_detector is
    port (
        clock       : in  std_logic;
        reset       : in  std_logic;
        -- Входной поток (тап с rx_sample_corrected_*)
        in_i        : in  signed(15 downto 0);
        in_q        : in  signed(15 downto 0);
        in_valid    : in  std_logic;
        -- Конфигурация (квазистатична, двойной триггер снаружи)
        threshold   : in  unsigned(31 downto 0);
        win_shift   : in  unsigned(3 downto 0);   -- 4..12 → окно 16..4096
        -- Выходы
        det_active  : out std_logic;
        det_count   : out unsigned(15 downto 0)
    );
end entity;

architecture rtl of legion_detector is
    signal acc       : unsigned(47 downto 0);
    signal count     : unsigned(12 downto 0);  -- до 4096
    signal active_r  : std_logic;
    signal det_cnt_r : unsigned(15 downto 0);
begin
    det_active <= active_r;
    det_count  <= det_cnt_r;

    process(clock, reset)
        variable energy   : unsigned(31 downto 0);
        variable i_sq     : signed(31 downto 0);
        variable q_sq     : signed(31 downto 0);
        variable avg      : unsigned(47 downto 0);
        variable win_last : unsigned(12 downto 0);
    begin
        if reset = '1' then
            acc        <= (others => '0');
            count      <= (others => '0');
            active_r   <= '0';
            det_cnt_r  <= (others => '0');
        elsif rising_edge(clock) then
            -- Окно не может превышать 4096 сэмпла; shift>12 переполнил бы
            -- 13-битный win_last (1<<15 обрезается в 0 → окно 4096 по мусору) —
            -- клампим (факт: численно проверено, TB покрывает shift=15)
            if win_shift > 12 then
                win_last := to_unsigned(4095, 13);
            else
                win_last := shift_left(to_unsigned(1, 13), to_integer(win_shift)) - 1;
            end if;

            if in_valid = '1' then
                -- signed×signed: квадрат неотрицателен (max 2^30 при -2^15)
                i_sq := in_i * in_i;
                q_sq := in_q * in_q;
                energy := unsigned(i_sq) + unsigned(q_sq);
                acc   <= acc + energy;
                count <= count + 1;

                if count = win_last then
                    avg := shift_right(acc + energy, to_integer(win_shift));
                    count <= (others => '0');
                    acc   <= (others => '0');
                    if avg(31 downto 0) >= threshold then
                        if active_r = '0' then
                            det_cnt_r <= det_cnt_r + 1;
                        end if;
                        active_r <= '1';
                    else
                        active_r <= '0';
                    end if;
                end if;
            end if;
        end if;
    end process;
end architecture;
