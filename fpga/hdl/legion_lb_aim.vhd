-- ============================================================================
-- LEGION — синтез: цифровой hop DRFM → TX (tx_clock).
-- Вырез (legion_lb_xlat) оставляет канал на его bin. Этот блок — второй
-- тракт: baseband после MA × NCO, FTW = signed(CH_TARGET[7:0]) << 24
-- (f = bin·fs/256, та же формула что xlat / legion_nco).
-- din — отдельный отвод базы, не up-mix выреза: умножение на exp(+j2πft)
-- сдвигает центр на f, и вырез на bin пика уехал бы в peak+target.
-- Механика host Attack: bb * exp(j·2π·f·t) без setFrequency. LO стоит,
-- реакция — следующий sample_en (каденс mux), не обёртка фазы и не
-- период обзора. Фаза непрерывна при смене bin; arm=0 сбрасывает фазу
-- и пропускает din без регистра (delay=0 → mux в том же такте).
-- Упаковка: I[31:16] Q[15:0]. Масштаб LUT >>11, как up-mix xlat.
-- ============================================================================
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
use work.legion_pkg.all;

entity legion_lb_aim is
    port (
        clock     : in  std_logic;
        reset     : in  std_logic;
        ch_target : in  std_logic_vector(31 downto 0);
        sample_en : in  std_logic;
        din       : in  std_logic_vector(31 downto 0);
        dout      : out std_logic_vector(31 downto 0)
    );
end entity;

architecture rtl of legion_lb_aim is
    type lut_t is array (0 to 255) of unsigned(11 downto 0);
    constant QUARTER_SINE : lut_t := (
        12x"000", 12x"00D", 12x"019", 12x"026", 12x"032", 12x"03F", 12x"04B", 12x"058",
        12x"064", 12x"071", 12x"07E", 12x"08A", 12x"097", 12x"0A3", 12x"0B0", 12x"0BC",
        12x"0C9", 12x"0D5", 12x"0E2", 12x"0EE", 12x"0FB", 12x"107", 12x"113", 12x"120",
        12x"12C", 12x"139", 12x"145", 12x"152", 12x"15E", 12x"16A", 12x"177", 12x"183",
        12x"18F", 12x"19C", 12x"1A8", 12x"1B4", 12x"1C1", 12x"1CD", 12x"1D9", 12x"1E5",
        12x"1F1", 12x"1FE", 12x"20A", 12x"216", 12x"222", 12x"22E", 12x"23A", 12x"246",
        12x"252", 12x"25E", 12x"26A", 12x"276", 12x"282", 12x"28E", 12x"29A", 12x"2A6",
        12x"2B2", 12x"2BD", 12x"2C9", 12x"2D5", 12x"2E1", 12x"2EC", 12x"2F8", 12x"304",
        12x"30F", 12x"31B", 12x"327", 12x"332", 12x"33E", 12x"349", 12x"354", 12x"360",
        12x"36B", 12x"377", 12x"382", 12x"38D", 12x"398", 12x"3A4", 12x"3AF", 12x"3BA",
        12x"3C5", 12x"3D0", 12x"3DB", 12x"3E6", 12x"3F1", 12x"3FC", 12x"407", 12x"412",
        12x"41C", 12x"427", 12x"432", 12x"43D", 12x"447", 12x"452", 12x"45C", 12x"467",
        12x"471", 12x"47C", 12x"486", 12x"490", 12x"49B", 12x"4A5", 12x"4AF", 12x"4B9",
        12x"4C3", 12x"4CD", 12x"4D7", 12x"4E1", 12x"4EB", 12x"4F5", 12x"4FF", 12x"509",
        12x"513", 12x"51C", 12x"526", 12x"530", 12x"539", 12x"543", 12x"54C", 12x"555",
        12x"55F", 12x"568", 12x"571", 12x"57A", 12x"583", 12x"58D", 12x"596", 12x"59F",
        12x"5A7", 12x"5B0", 12x"5B9", 12x"5C2", 12x"5CB", 12x"5D3", 12x"5DC", 12x"5E4",
        12x"5ED", 12x"5F5", 12x"5FD", 12x"606", 12x"60E", 12x"616", 12x"61E", 12x"626",
        12x"62E", 12x"636", 12x"63E", 12x"646", 12x"64E", 12x"655", 12x"65D", 12x"665",
        12x"66C", 12x"674", 12x"67B", 12x"682", 12x"68A", 12x"691", 12x"698", 12x"69F",
        12x"6A6", 12x"6AD", 12x"6B4", 12x"6BB", 12x"6C1", 12x"6C8", 12x"6CF", 12x"6D5",
        12x"6DC", 12x"6E2", 12x"6E9", 12x"6EF", 12x"6F5", 12x"6FB", 12x"701", 12x"707",
        12x"70D", 12x"713", 12x"719", 12x"71F", 12x"724", 12x"72A", 12x"730", 12x"735",
        12x"73A", 12x"740", 12x"745", 12x"74A", 12x"74F", 12x"754", 12x"759", 12x"75E",
        12x"763", 12x"768", 12x"76D", 12x"771", 12x"776", 12x"77A", 12x"77F", 12x"783",
        12x"787", 12x"78C", 12x"790", 12x"794", 12x"798", 12x"79C", 12x"79F", 12x"7A3",
        12x"7A7", 12x"7AA", 12x"7AE", 12x"7B1", 12x"7B5", 12x"7B8", 12x"7BB", 12x"7BF",
        12x"7C2", 12x"7C5", 12x"7C8", 12x"7CA", 12x"7CD", 12x"7D0", 12x"7D3", 12x"7D5",
        12x"7D8", 12x"7DA", 12x"7DC", 12x"7DF", 12x"7E1", 12x"7E3", 12x"7E5", 12x"7E7",
        12x"7E9", 12x"7EB", 12x"7EC", 12x"7EE", 12x"7F0", 12x"7F1", 12x"7F3", 12x"7F4",
        12x"7F5", 12x"7F6", 12x"7F7", 12x"7F8", 12x"7F9", 12x"7FA", 12x"7FB", 12x"7FC",
        12x"7FD", 12x"7FD", 12x"7FE", 12x"7FE", 12x"7FE", 12x"7FF", 12x"7FF", 12x"7FF"
    );

    signal phase_acc : unsigned(31 downto 0) := (others => '0');
    signal q         : std_logic_vector(31 downto 0) := (others => '0');

    function sine_lookup(phase10 : unsigned(9 downto 0)) return signed is
        variable quad : unsigned(1 downto 0);
        variable idx  : unsigned(7 downto 0);
        variable val  : unsigned(11 downto 0);
        variable sgn  : std_logic;
    begin
        quad := phase10(9 downto 8);
        idx  := phase10(7 downto 0);
        if quad(0) = '1' then
            val := QUARTER_SINE(255 - to_integer(idx));
        else
            val := QUARTER_SINE(to_integer(idx));
        end if;
        sgn := quad(1);
        if sgn = '1' then
            return -signed(resize(val, 16));
        else
            return signed(resize(val, 16));
        end if;
    end function;

    function mix_sum(a, b, c, d : signed(15 downto 0); sub : boolean) return signed is
        variable p : signed(31 downto 0);
    begin
        if sub then
            p := (a * c) - (b * d);
        else
            p := (a * c) + (b * d);
        end if;
        return resize(shift_right(p, 11), 16);
    end function;
begin
    -- arm=0: провод. Иначе регистр, готовый к захвату mux на такте после sample_en.
    dout <= din when ch_target(31) = '0' else q;

    process(clock, reset)
        variable ftw : unsigned(31 downto 0);
        variable c_i : signed(15 downto 0);
        variable s_q : signed(15 downto 0);
        variable xi  : signed(15 downto 0);
        variable xq  : signed(15 downto 0);
        variable yi  : signed(15 downto 0);
        variable yq  : signed(15 downto 0);
    begin
        if reset = '1' then
            phase_acc <= (others => '0');
            q         <= (others => '0');
        elsif rising_edge(clock) then
            if ch_target(31) = '0' then
                -- q не копирует din. Иначе первый захват mux после arm
                -- (он берёт регистр, а не результат этого же фронта) — сырая
                -- база на bin 0, до первого произведения.
                phase_acc <= (others => '0');
                q         <= (others => '0');
            elsif sample_en = '1' then
                -- FTW живой: новый bin входит в шаг этого valid, cis
                -- следующего. Обёртку аккумулятора не ждём (rotator hop).
                ftw := legion_bin_ftw(ch_target(7 downto 0));
                c_i := sine_lookup(phase_acc(31 downto 22) + 256);
                s_q := sine_lookup(phase_acc(31 downto 22));
                xi  := signed(din(31 downto 16));
                xq  := signed(din(15 downto 0));
                -- (I+jQ)·(cos+j sin), как host bb·exp(+jωt)
                yi := mix_sum(xi, xq, c_i, s_q, true);
                yq := mix_sum(xi, xq, s_q, c_i, false);
                q  <= std_logic_vector(yi) & std_logic_vector(yq);
                phase_acc <= phase_acc + ftw;
            end if;
        end if;
    end process;
end architecture;
