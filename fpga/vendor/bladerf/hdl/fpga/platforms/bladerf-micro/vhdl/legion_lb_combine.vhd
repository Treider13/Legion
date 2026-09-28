-- ============================================================================
-- LEGION — сумма двух отводов DRFM (tx_clock).
-- ApplSci multi-scatterer / RFSoC 2026 «до 4 целей»: на xA4 — две.
-- Каждая копия × Q15, затем насыщение I/Q. A1=0 — один отвод (mesarcik).
-- Модуль × Q15, затем знак: ASR отрицательных дал бы I ≠ −Q.
-- ============================================================================
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity legion_lb_combine is
    port (
        clock     : in  std_logic;
        reset     : in  std_logic;
        sample_en : in  std_logic;
        amp0      : in  unsigned(15 downto 0);
        amp1      : in  unsigned(15 downto 0);
        din0      : in  std_logic_vector(31 downto 0);
        din1      : in  std_logic_vector(31 downto 0);
        dout      : out std_logic_vector(31 downto 0)
    );
end entity;

architecture rtl of legion_lb_combine is
    signal q : std_logic_vector(31 downto 0) := (others => '0');

    function amp_q15(x : signed(15 downto 0); a : unsigned(15 downto 0)) return signed is
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
        prod := mag * a;
        y := signed(prod(30 downto 15));
        if ext < 0 then
            return -y;
        end if;
        return y;
    end function;

    function sat16(x : signed(16 downto 0)) return signed is
    begin
        if x > 32767 then
            return to_signed(32767, 16);
        elsif x < -32768 then
            return to_signed(-32768, 16);
        end if;
        return x(15 downto 0);
    end function;
begin
    dout <= q;

    process(clock, reset)
        variable i0, q0, i1, q1 : signed(15 downto 0);
        variable si, sq : signed(16 downto 0);
    begin
        if reset = '1' then
            q <= (others => '0');
        elsif rising_edge(clock) then
            if sample_en = '1' then
                i0 := amp_q15(signed(din0(31 downto 16)), amp0);
                q0 := amp_q15(signed(din0(15 downto 0)), amp0);
                i1 := amp_q15(signed(din1(31 downto 16)), amp1);
                q1 := amp_q15(signed(din1(15 downto 0)), amp1);
                si := resize(i0, 17) + resize(i1, 17);
                sq := resize(q0, 17) + resize(q1, 17);
                q <= std_logic_vector(sat16(si)) & std_logic_vector(sat16(sq));
            end if;
        end if;
    end process;
end architecture;
