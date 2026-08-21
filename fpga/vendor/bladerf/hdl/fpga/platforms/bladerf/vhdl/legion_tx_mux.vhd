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
        elsif rising_edge(clock) then
            lb_rd_en <= '0';
            lb_valid <= '0';

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
                when LEGION_MODE_LB_GATED =>
                    if live = '1' and det_active = '1' then
                        out_i <= lb_i; out_q <= lb_q; out_valid <= lb_valid;
                    else
                        out_i <= (others => '0'); out_q <= (others => '0');
                        out_valid <= phase;
                    end if;
                when LEGION_MODE_LB_ALWAYS =>
                    if live = '1' then
                        out_i <= lb_i; out_q <= lb_q; out_valid <= lb_valid;
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
