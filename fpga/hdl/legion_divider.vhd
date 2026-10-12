-- ============================================================================
-- LEGION — последовательный restoring-делитель (без оператора "/" / "mod").
-- Q = floor(dividend / divisor), R = dividend mod divisor.
-- ITERATIONS = DIVIDEND_W тактов после start (один бит делимого за такт).
-- divisor=0 → Q=0, R=0. Если Q не влезает в QUOTIENT_W — насыщение (все 1).
-- Все регистры на clk. Комбинаторного lpm_divide нет.
-- ============================================================================
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity legion_divider is
    generic (
        DIVIDEND_W : natural := 64;
        DIVISOR_W  : natural := 32;
        QUOTIENT_W : natural := 32
    );
    port (
        clk      : in  std_logic;
        reset    : in  std_logic;
        start    : in  std_logic;
        dividend : in  unsigned(DIVIDEND_W - 1 downto 0);
        divisor  : in  unsigned(DIVISOR_W - 1 downto 0);
        quotient : out unsigned(QUOTIENT_W - 1 downto 0);
        remain   : out unsigned(DIVISOR_W - 1 downto 0);
        valid    : out std_logic;
        busy     : out std_logic
    );
end entity;

architecture rtl of legion_divider is
    signal busy_r  : std_logic;
    signal valid_r : std_logic;
    signal bit_i   : integer range 0 to DIVIDEND_W;
    signal num     : unsigned(DIVIDEND_W - 1 downto 0);
    signal acc     : unsigned(DIVISOR_W downto 0);
    signal q_acc   : unsigned(DIVIDEND_W - 1 downto 0);
    signal d_r     : unsigned(DIVISOR_W - 1 downto 0);
begin
    busy  <= busy_r;
    valid <= valid_r;

    process(clk, reset)
        variable trial : unsigned(DIVISOR_W downto 0);
        variable acc_n : unsigned(DIVISOR_W downto 0);
        variable q_n   : unsigned(DIVIDEND_W - 1 downto 0);
        variable hi    : unsigned(DIVIDEND_W - 1 downto QUOTIENT_W);
    begin
        if reset = '1' then
            busy_r   <= '0';
            valid_r  <= '0';
            bit_i    <= 0;
            num      <= (others => '0');
            acc      <= (others => '0');
            q_acc    <= (others => '0');
            d_r      <= (others => '0');
            quotient <= (others => '0');
            remain   <= (others => '0');
        elsif rising_edge(clk) then
            valid_r <= '0';
            if start = '1' and busy_r = '0' then
                busy_r <= '1';
                num    <= dividend;
                acc    <= (others => '0');
                q_acc  <= (others => '0');
                d_r    <= divisor;
                bit_i  <= DIVIDEND_W;
            elsif busy_r = '1' then
                trial := acc(DIVISOR_W - 1 downto 0) & num(DIVIDEND_W - 1);
                num   <= num(DIVIDEND_W - 2 downto 0) & '0';
                if d_r /= 0 and trial >= resize(d_r, DIVISOR_W + 1) then
                    acc_n := trial - resize(d_r, DIVISOR_W + 1);
                    q_n   := q_acc(DIVIDEND_W - 2 downto 0) & '1';
                else
                    acc_n := trial;
                    q_n   := q_acc(DIVIDEND_W - 2 downto 0) & '0';
                end if;
                acc   <= acc_n;
                q_acc <= q_n;
                if bit_i = 1 then
                    busy_r  <= '0';
                    valid_r <= '1';
                    if d_r = 0 then
                        remain   <= (others => '0');
                        quotient <= (others => '0');
                    else
                        remain <= acc_n(DIVISOR_W - 1 downto 0);
                        if DIVIDEND_W > QUOTIENT_W then
                            hi := q_n(DIVIDEND_W - 1 downto QUOTIENT_W);
                            if hi /= 0 then
                                quotient <= (others => '1');
                            else
                                quotient <= q_n(QUOTIENT_W - 1 downto 0);
                            end if;
                        else
                            quotient <= resize(q_n, QUOTIENT_W);
                        end if;
                    end if;
                else
                    bit_i <= bit_i - 1;
                end if;
            end if;
        end if;
    end process;
end architecture;
