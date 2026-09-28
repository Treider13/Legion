-- ============================================================================
-- LEGION — комплексный смеситель DRFM (tx_clock). mesarcik/DRFM:
-- store + delay + amplitude + frequency shift. Amplitude — LB_SHIFT в mux.
-- Delay — legion_delayline. Сдвиг — умножение на LO после линии:
--   y = x · (cos ωn + j sin ωn) = (I cos − Q sin) + j (I sin + Q cos).
-- LO — второй legion_nco (не REG_NCO_FTW). FTW=0: обход, dout=din.
-- Иначе фаза 0 дала бы Q=0 и занулила бы квадратуру. Каденс — sample_en
-- (сэмплы, не такты tx_clock). xA4: 16×16 OK на 122.88 МГц с регистром.
-- Упаковка слова: I[31:16] Q[15:0] (как FIFO xlating / delayline).
-- ============================================================================
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity legion_mixer is
    port (
        clock     : in  std_logic;
        reset     : in  std_logic;
        mix_en    : in  std_logic;                 -- 0 = обход
        sample_en : in  std_logic;
        din       : in  std_logic_vector(31 downto 0);
        lo_i      : in  signed(15 downto 0);       -- cos
        lo_q      : in  signed(15 downto 0);       -- sin
        dout      : out std_logic_vector(31 downto 0)
    );
end entity;

architecture rtl of legion_mixer is
    signal q : std_logic_vector(31 downto 0) := (others => '0');
begin
    dout <= din when mix_en = '0' else q;

    process(clock, reset)
        variable xi, xq : signed(15 downto 0);
        variable acc_i  : signed(31 downto 0);
        variable acc_q  : signed(31 downto 0);
        variable yi, yq : signed(15 downto 0);
    begin
        if reset = '1' then
            q <= (others => '0');
        elsif rising_edge(clock) then
            if mix_en = '1' and sample_en = '1' then
                xi := signed(din(31 downto 16));
                xq := signed(din(15 downto 0));
                -- Q15: NCO ≈ 2047≪4 = 32752 ≈ 2^15
                acc_i := resize(xi * lo_i, 32) - resize(xq * lo_q, 32);
                acc_q := resize(xi * lo_q, 32) + resize(xq * lo_i, 32);
                yi := acc_i(30 downto 15);
                yq := acc_q(30 downto 15);
                q <= std_logic_vector(yi) & std_logic_vector(yq);
            end if;
        end if;
    end process;
end architecture;
