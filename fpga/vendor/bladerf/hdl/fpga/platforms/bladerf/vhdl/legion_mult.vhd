-- ============================================================================
-- LEGION — последовательное умножение (без оператора "*").
-- product = a * b. ITERATIONS = B_W тактов после start (один бит b за такт).
-- shift-add: если b[0]=1 → acc += mcand; mcand <<= 1; b >>= 1.
-- a=0 или b=0 → product=0. Все регистры на clk. Комбинаторного lpm_mult нет.
-- ============================================================================
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity legion_mult is
    generic (
        A_W : natural := 32;
        B_W : natural := 32;
        P_W : natural := 64
    );
    port (
        clk     : in  std_logic;
        reset   : in  std_logic;
        start   : in  std_logic;
        a       : in  unsigned(A_W - 1 downto 0);
        b       : in  unsigned(B_W - 1 downto 0);
        product : out unsigned(P_W - 1 downto 0);
        valid   : out std_logic;
        busy    : out std_logic
    );
end entity;

architecture rtl of legion_mult is
    signal busy_r  : std_logic;
    signal valid_r : std_logic;
    signal bit_i   : integer range 0 to B_W;
    signal acc     : unsigned(P_W - 1 downto 0);
    signal mcand   : unsigned(P_W - 1 downto 0);
    signal mplier  : unsigned(B_W - 1 downto 0);
begin
    busy  <= busy_r;
    valid <= valid_r;

    process(clk, reset)
        variable acc_n : unsigned(P_W - 1 downto 0);
    begin
        if reset = '1' then
            busy_r  <= '0';
            valid_r <= '0';
            bit_i   <= 0;
            acc     <= (others => '0');
            mcand   <= (others => '0');
            mplier  <= (others => '0');
            product <= (others => '0');
        elsif rising_edge(clk) then
            valid_r <= '0';
            if start = '1' and busy_r = '0' then
                busy_r <= '1';
                acc    <= (others => '0');
                mcand  <= resize(a, P_W);
                mplier <= b;
                bit_i  <= B_W;
            elsif busy_r = '1' then
                acc_n := acc;
                if mplier(0) = '1' then
                    acc_n := acc + mcand;
                end if;
                acc    <= acc_n;
                mcand  <= mcand(P_W - 2 downto 0) & '0';
                mplier <= '0' & mplier(B_W - 1 downto 1);
                if bit_i = 1 then
                    busy_r  <= '0';
                    valid_r <= '1';
                    product <= acc_n;
                else
                    bit_i <= bit_i - 1;
                end if;
            end if;
        end if;
    end process;
end architecture;
