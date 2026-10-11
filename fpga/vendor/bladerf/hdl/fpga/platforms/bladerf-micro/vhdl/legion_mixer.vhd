-- ============================================================================
-- LEGION — комплексный смеситель DRFM (tx_clock). mesarcik/DRFM:
-- store + delay + frequency shift. Амплитуда — аналоговый TX gain платы,
-- не этот блок и не LB_SHIFT mux.
-- Delay — legion_delayline. Сдвиг — умножение на LO после линии:
--   y = x · (cos ωn + j sin ωn) = (I cos − Q sin) + j (I sin + Q cos).
-- LO — второй legion_nco (не REG_NCO_FTW). FTW=0: обход, dout=din.
-- Иначе фаза 0 дала бы Q=0 и занулила бы квадратуру. Каденс — sample_en
-- (сэмплы, не такты tx_clock).
-- S1 захват din/LO/mix_en, S2 смесь/обход → q. +1 sample vs одностадийной
-- версии. mixer0 и mixer1 — один entity, задержка общая (отводы не разъедутся).
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
    signal din_r : std_logic_vector(31 downto 0) := (others => '0');
    signal loi_r : signed(15 downto 0) := (others => '0');
    signal loq_r : signed(15 downto 0) := (others => '0');
    signal men_r : std_logic := '0';
    signal se_d  : std_logic := '0';
    signal q     : std_logic_vector(31 downto 0) := (others => '0');

    attribute preserve : boolean;
    attribute preserve of din_r : signal is true;
    attribute preserve of loi_r : signal is true;
    attribute preserve of loq_r : signal is true;
    attribute preserve of men_r : signal is true;
    attribute preserve of se_d  : signal is true;
begin
    dout <= q;

    -- S1: захват. Обход и смесь — тот же такт, оба отвода.
    process(clock, reset)
    begin
        if reset = '1' then
            din_r <= (others => '0');
            loi_r <= (others => '0');
            loq_r <= (others => '0');
            men_r <= '0';
            se_d  <= '0';
        elsif rising_edge(clock) then
            se_d <= sample_en;
            if sample_en = '1' then
                din_r <= din;
                loi_r <= lo_i;
                loq_r <= lo_q;
                men_r <= mix_en;
            end if;
        end if;
    end process;

    -- S2: смесь / обход → q
    process(clock, reset)
        variable xi, xq : signed(15 downto 0);
        variable acc_i  : signed(31 downto 0);
        variable acc_q  : signed(31 downto 0);
        variable yi, yq : signed(15 downto 0);
    begin
        if reset = '1' then
            q <= (others => '0');
        elsif rising_edge(clock) then
            if se_d = '1' then
                if men_r = '0' then
                    q <= din_r;
                else
                    xi := signed(din_r(31 downto 16));
                    xq := signed(din_r(15 downto 0));
                    -- Q15: NCO ≈ 2047<<4 = 32752 ≈ 2^15
                    acc_i := resize(xi * loi_r, 32) - resize(xq * loq_r, 32);
                    acc_q := resize(xi * loq_r, 32) + resize(xq * loi_r, 32);
                    yi := acc_i(30 downto 15);
                    yq := acc_q(30 downto 15);
                    q <= std_logic_vector(yi) & std_logic_vector(yq);
                end if;
            end if;
        end if;
    end process;
end architecture;
