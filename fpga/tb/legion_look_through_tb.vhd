-- Look-through: blank не трогает LO (его здесь нет). Эхо закрывает гейт.
-- Энергия в TX-офф держит гейт. Каденс valid жив.
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity legion_look_through_tb is
end entity;

architecture tb of legion_look_through_tb is
    signal tx_clock : std_logic := '0';
    signal rx_clock : std_logic := '0';
    signal tx_reset : std_logic := '1';
    signal rx_reset : std_logic := '1';
    signal enable   : std_logic := '0';
    signal period   : unsigned(31 downto 0) := to_unsigned(32, 32);
    signal width    : unsigned(31 downto 0) := to_unsigned(32, 32);
    signal ratio    : unsigned(3 downto 0) := to_unsigned(2, 4);
    signal det_thr  : unsigned(31 downto 0) := to_unsigned(100, 32);
    signal win_sh   : unsigned(3 downto 0) := to_unsigned(4, 4);
    signal rx_i     : signed(15 downto 0) := (others => '0');
    signal rx_q     : signed(15 downto 0) := (others => '0');
    signal rx_valid : std_logic := '0';
    signal blank    : std_logic;
    signal echo_hold : std_logic;
    signal status   : std_logic_vector(31 downto 0);
    signal done     : boolean := false;
begin
    tx_clock <= not tx_clock after 5 ns when not done;
    rx_clock <= not rx_clock after 7 ns when not done;

    dut : entity work.legion_look_through
        port map (
            tx_clock => tx_clock, tx_reset => tx_reset,
            rx_clock => rx_clock, rx_reset => rx_reset,
            enable => enable, period => period, width => width,
            ratio_shift => ratio, det_thr => det_thr, win_shift => win_sh,
            rx_i => rx_i, rx_q => rx_q, rx_valid => rx_valid,
            blank => blank, echo_hold => echo_hold, status => status
        );

    stim : process
        variable saw_blank : boolean;
        variable saw_on    : boolean;
        variable k         : integer;
    begin
        wait for 40 ns;
        tx_reset <= '0';
        rx_reset <= '0';
        wait for 40 ns;

        -- Выкл: blank не встаёт
        for k in 0 to 63 loop
            wait until rising_edge(tx_clock);
            assert blank = '0' report "FAIL: blank while disabled" severity failure;
        end loop;

        enable <= '1';
        saw_blank := false;
        saw_on := false;
        for k in 0 to 255 loop
            wait until rising_edge(tx_clock);
            if blank = '1' then saw_blank := true; end if;
            if blank = '0' then saw_on := true; end if;
        end loop;
        assert saw_blank report "FAIL: never blanked" severity failure;
        assert saw_on report "FAIL: never TX-on" severity failure;

        -- Эхо: энергия только когда TX-он (blank=0)
        for k in 0 to 4000 loop
            wait until rising_edge(rx_clock);
            rx_valid <= '1';
            if blank = '0' then
                rx_i <= to_signed(2000, 16);
                rx_q <= to_signed(0, 16);
            else
                rx_i <= to_signed(0, 16);
                rx_q <= to_signed(0, 16);
            end if;
        end loop;
        rx_valid <= '0';
        for k in 0 to 15 loop wait until rising_edge(tx_clock); end loop;
        assert echo_hold = '1' report "FAIL: echo did not close gate" severity failure;

        -- Чужой сигнал: энергия и в TX-офф
        for k in 0 to 4000 loop
            wait until rising_edge(rx_clock);
            rx_valid <= '1';
            rx_i <= to_signed(2000, 16);
            rx_q <= to_signed(0, 16);
        end loop;
        rx_valid <= '0';
        for k in 0 to 15 loop wait until rising_edge(tx_clock); end loop;
        assert echo_hold = '0' report "FAIL: real signal closed gate" severity failure;

        enable <= '0';
        for k in 0 to 31 loop wait until rising_edge(tx_clock); end loop;
        for k in 0 to 15 loop wait until rising_edge(rx_clock); end loop;
        for k in 0 to 7 loop wait until rising_edge(tx_clock); end loop;
        assert blank = '0' report "FAIL: blank stuck after disable" severity failure;
        assert echo_hold = '0' report "FAIL: echo stuck after disable" severity failure;

        report "legion_look_through_tb: PASS" severity note;
        done <= true;
        wait;
    end process;
end architecture;
