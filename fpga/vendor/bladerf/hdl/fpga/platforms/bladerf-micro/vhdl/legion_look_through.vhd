-- ============================================================================
-- LEGION — look-through на стоящем LO (не SEARCH mute, не 6 мс SETTLE).
-- TX-домен: раз в PERIOD на WIDTH сэмплов нули на ЦАП, каденс valid жив.
-- RX-домен: энергия окна TX-он vs TX-офф. TX-офф тише → echo_hold (своё
-- эхо, гейт закрыть). Энергия осталась → чужой сигнал, гейт жив.
-- CDC: blank/enable — 2FF (Cummings SNUG2008: однобит). ratio — квазистатик
-- 2FF, как DET_SHIFT в legion_regs; сравнение только при en_rx=1.
-- ============================================================================
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity legion_look_through is
    port (
        tx_clock    : in  std_logic;
        tx_reset    : in  std_logic;
        rx_clock    : in  std_logic;
        rx_reset    : in  std_logic;
        enable      : in  std_logic;
        period      : in  unsigned(31 downto 0);
        width       : in  unsigned(31 downto 0);
        ratio_shift : in  unsigned(3 downto 0);
        det_thr     : in  unsigned(31 downto 0);
        win_shift   : in  unsigned(3 downto 0);
        rx_i        : in  signed(15 downto 0);
        rx_q        : in  signed(15 downto 0);
        rx_valid    : in  std_logic;
        blank       : out std_logic;
        echo_hold   : out std_logic;
        status      : out std_logic_vector(31 downto 0)
    );
end entity;

architecture rtl of legion_look_through is
    signal phase     : std_logic;
    signal count     : unsigned(31 downto 0);
    signal blank_r   : std_logic;
    signal en_ok     : std_logic;

    signal blank_meta, blank_rx : std_logic;
    signal en_meta, en_rx       : std_logic;
    signal ratio_meta, ratio_rx : unsigned(3 downto 0);
    signal echo_rx   : std_logic;
    signal echo_meta, echo_tx : std_logic;

    signal acc       : unsigned(47 downto 0);
    signal wcount    : unsigned(12 downto 0);
    signal last_on   : unsigned(31 downto 0);
    signal last_off  : unsigned(31 downto 0);
    signal have_on   : std_logic;
    signal blank_d   : std_logic;
begin
    en_ok <= enable when period /= 0 and width /= 0 else '0';
    blank <= blank_r;
    echo_hold <= echo_tx;
    status(0) <= echo_tx;
    status(1) <= blank_r;
    status(31 downto 2) <= (others => '0');

    -- Каденс как mux: каждый 2-й tx_clock = один сэмпл ЦАП.
    -- blank ровно WIDTH сэмплов: count 0..period-1 он, period..period+width-1 офф.
    tx_fsm : process(tx_clock, tx_reset)
    begin
        if tx_reset = '1' then
            phase   <= '0';
            count   <= (others => '0');
            blank_r <= '0';
        elsif rising_edge(tx_clock) then
            phase <= not phase;
            if en_ok = '0' then
                count   <= (others => '0');
                blank_r <= '0';
            elsif phase = '1' then
                if count < period then
                    blank_r <= '0';
                    count   <= count + 1;
                else
                    blank_r <= '1';
                    if count + 1 >= period + width then
                        count <= (others => '0');
                    else
                        count <= count + 1;
                    end if;
                end if;
            end if;
        end if;
    end process;

    cdc_blank : process(rx_clock, rx_reset)
    begin
        if rx_reset = '1' then
            blank_meta <= '0';
            blank_rx   <= '0';
            en_meta    <= '0';
            en_rx      <= '0';
            ratio_meta <= (others => '0');
            ratio_rx   <= (others => '0');
        elsif rising_edge(rx_clock) then
            blank_meta <= blank_r;
            blank_rx   <= blank_meta;
            en_meta    <= en_ok;
            en_rx      <= en_meta;
            ratio_meta <= ratio_shift;
            ratio_rx   <= ratio_meta;
        end if;
    end process;

    cdc_echo : process(tx_clock, tx_reset)
    begin
        if tx_reset = '1' then
            echo_meta <= '0';
            echo_tx   <= '0';
        elsif rising_edge(tx_clock) then
            echo_meta <= echo_rx;
            echo_tx   <= echo_meta;
        end if;
    end process;

    rx_energy : process(rx_clock, rx_reset)
        variable energy   : unsigned(31 downto 0);
        variable i_sq     : signed(31 downto 0);
        variable q_sq     : signed(31 downto 0);
        variable avg      : unsigned(47 downto 0);
        variable win_last : unsigned(12 downto 0);
        variable sh       : integer;
        variable ratio    : natural;
        variable edge     : boolean;
    begin
        if rx_reset = '1' then
            acc      <= (others => '0');
            wcount   <= (others => '0');
            last_on  <= (others => '0');
            last_off <= (others => '0');
            have_on  <= '0';
            echo_rx  <= '0';
            blank_d  <= '0';
        elsif rising_edge(rx_clock) then
            if win_shift > 12 then
                win_last := to_unsigned(4095, 13);
                sh := 12;
            elsif win_shift < 4 then
                win_last := to_unsigned(15, 13);
                sh := 4;
            else
                win_last := shift_left(to_unsigned(1, 13), to_integer(win_shift)) - 1;
                sh := to_integer(win_shift);
            end if;
            if ratio_rx = 0 then
                ratio := 2;
            elsif ratio_rx > 8 then
                ratio := 8;
            else
                ratio := to_integer(ratio_rx);
            end if;

            if en_rx = '0' then
                acc      <= (others => '0');
                wcount   <= (others => '0');
                last_on  <= (others => '0');
                last_off <= (others => '0');
                have_on  <= '0';
                echo_rx  <= '0';
                blank_d  <= '0';
            else
                edge := (blank_rx /= blank_d);
                blank_d <= blank_rx;
                -- Фронт blank: окно смешало он/офф — не коммитить (EA look-through).
                if edge then
                    acc    <= (others => '0');
                    wcount <= (others => '0');
                elsif rx_valid = '1' then
                    i_sq := rx_i * rx_i;
                    q_sq := rx_q * rx_q;
                    energy := unsigned(i_sq) + unsigned(q_sq);
                    acc    <= acc + energy;
                    wcount <= wcount + 1;
                    if wcount = win_last then
                        avg := shift_right(acc + energy, sh);
                        acc    <= (others => '0');
                        wcount <= (others => '0');
                        if blank_rx = '0' then
                            last_on <= avg(31 downto 0);
                            have_on <= '1';
                        else
                            last_off <= avg(31 downto 0);
                            if have_on = '1' then
                                if last_on >= det_thr then
                                    if avg(31 downto 0) < shift_right(last_on, ratio) then
                                        echo_rx <= '1';
                                    else
                                        echo_rx <= '0';
                                    end if;
                                else
                                    echo_rx <= '0';
                                end if;
                            end if;
                        end if;
                    end if;
                end if;
            end if;
        end if;
    end process;
end architecture;
