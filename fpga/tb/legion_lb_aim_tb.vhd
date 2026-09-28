-- Тестбенч legion_lb_aim: arm=0 провод; bin 0 ≈ 1; bin +64 крутит на 90°
-- за сэмпл; bin −64 в другую сторону; смена bin на следующем valid,
-- не после полного периода (256 сэмплов у bin 1).
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
use ieee.math_real.all;

entity legion_lb_aim_tb is
end entity;

architecture tb of legion_lb_aim_tb is
    signal clock     : std_logic := '0';
    signal reset     : std_logic := '1';
    signal ch_target : std_logic_vector(31 downto 0) := (others => '0');
    signal sample_en : std_logic := '0';
    signal din       : std_logic_vector(31 downto 0) := (others => '0');
    signal dout      : std_logic_vector(31 downto 0);
    signal done      : boolean := false;

    constant AMP : integer := 4000;
    constant PI  : real := 3.141592653589793;

    function pack_iq(i, q : integer) return std_logic_vector is
    begin
        return std_logic_vector(to_signed(i, 16)) & std_logic_vector(to_signed(q, 16));
    end function;

    function unpack_i(w : std_logic_vector) return integer is
    begin
        return to_integer(signed(w(31 downto 16)));
    end function;

    function unpack_q(w : std_logic_vector) return integer is
    begin
        return to_integer(signed(w(15 downto 0)));
    end function;

    -- Фаза на выходе сэмпла k: k оборотов/256 (bin=1) до hop, дальше +64/256.
    function tone_at(cycles_num : integer; cycles_den : integer; which : character) return integer is
        variable th : real;
        variable y  : real;
    begin
        th := 2.0 * PI * real(cycles_num) / real(cycles_den);
        if which = 'I' then
            y := cos(th);
        else
            y := sin(th);
        end if;
        return integer(round(real(AMP) * y * 2047.0 / 2048.0));
    end function;
begin
    clock <= not clock after 5 ns when not done;

    dut : entity work.legion_lb_aim
        port map (
            clock => clock, reset => reset, ch_target => ch_target,
            sample_en => sample_en, din => din, dout => dout
        );

    stim : process
        variable yi, yq : integer;
        variable ei, eq : integer;
    begin
        din <= pack_iq(AMP, 0);
        wait for 20 ns;
        reset <= '0';
        wait until rising_edge(clock);

        -- arm=0: провод, без sample_en
        ch_target <= (others => '0');
        din <= pack_iq(1234, -222);
        wait for 1 ns;
        assert unpack_i(dout) = 1234 and unpack_q(dout) = -222
            report "FAIL: arm=0 passthrough" severity failure;

        -- bin 0, arm: FTW=0, фаза 0 → (I, Q) почти как есть
        ch_target <= x"80000000";
        din <= pack_iq(AMP, 0);
        sample_en <= '1';
        wait until rising_edge(clock);
        sample_en <= '0';
        wait for 1 ns;
        yi := unpack_i(dout);
        yq := unpack_q(dout);
        assert abs(yi - AMP) < 8 and abs(yq) < 8
            report "FAIL: bin0 yi=" & integer'image(yi) & " yq=" & integer'image(yq)
            severity failure;

        -- bin +64 = fs/4: каждый сэмпл +90°. Сэмпл 0 ещё фаза 0.
        ch_target <= x"80000040";
        sample_en <= '1';
        wait until rising_edge(clock); -- этот valid ещё на фазе 0 (bin0 не шагнул)
        wait for 1 ns;
        yi := unpack_i(dout);
        yq := unpack_q(dout);
        assert abs(yi - AMP) < 8 and abs(yq) < 8
            report "FAIL: hop latency, first +64 still phase 0" severity failure;
        wait until rising_edge(clock); -- шаг +64 уже в фазе: +90°
        wait for 1 ns;
        yi := unpack_i(dout);
        yq := unpack_q(dout);
        assert abs(yi) < 40 and abs(yq - AMP) < 40
            report "FAIL: +90 yi=" & integer'image(yi) & " yq=" & integer'image(yq)
            severity failure;
        wait until rising_edge(clock); -- +180
        wait for 1 ns;
        yi := unpack_i(dout);
        yq := unpack_q(dout);
        assert abs(yi + AMP) < 40 and abs(yq) < 40
            report "FAIL: +180 yi=" & integer'image(yi) & " yq=" & integer'image(yq)
            severity failure;

        -- Сброс фазы по arm=0, затем bin −64 (0xC0): следующий valid после
        -- фазы 0 даёт −90° (Q < 0), не +90.
        sample_en <= '0';
        ch_target <= (others => '0');
        wait until rising_edge(clock);
        ch_target <= x"800000C0";
        sample_en <= '1';
        wait until rising_edge(clock); -- фаза 0
        wait until rising_edge(clock); -- −90°
        wait for 1 ns;
        yi := unpack_i(dout);
        yq := unpack_q(dout);
        assert abs(yi) < 40 and yq < -AMP + 40
            report "FAIL: -90 yi=" & integer'image(yi) & " yq=" & integer'image(yq)
            severity failure;

        -- Не ждём период. 10 сэмплов bin=1 (период 256), затем bin=64.
        -- Выход сэмпла 11 должен сидеть на фазе 10/256+64/256, не на 11/256.
        sample_en <= '0';
        ch_target <= (others => '0');
        wait until rising_edge(clock);
        ch_target <= x"80000001";
        sample_en <= '1';
        for k in 0 to 9 loop
            wait until rising_edge(clock);
        end loop;
        ch_target <= x"80000040";
        -- этот фронт ещё cis(10/256), шаг уже +64. Следующий — 74/256.
        wait until rising_edge(clock);
        wait until rising_edge(clock);
        wait for 1 ns;
        yi := unpack_i(dout);
        yq := unpack_q(dout);
        ei := tone_at(74, 256, 'I');
        eq := tone_at(74, 256, 'Q');
        assert abs(yi - ei) < 80 and abs(yq - eq) < 80
            report "FAIL: hop-now yi=" & integer'image(yi) & " exp " & integer'image(ei) &
                   " yq=" & integer'image(yq) & " exp " & integer'image(eq)
            severity failure;
        ei := tone_at(11, 256, 'I');
        assert abs(yi - ei) > 400
            report "FAIL: NCO waited full bin1 period" severity failure;

        -- После arm=0 регистр не держит сырой din: первый dout при arm
        -- без нового sample_en — ноль, не база на bin 0.
        sample_en <= '0';
        ch_target <= (others => '0');
        din <= pack_iq(AMP, 0);
        wait until rising_edge(clock);
        wait for 1 ns;
        ch_target <= x"80000040";
        wait until rising_edge(clock);
        wait for 1 ns;
        assert unpack_i(dout) = 0 and unpack_q(dout) = 0
            report "FAIL: armed dout held raw baseband" severity failure;

        report "legion_lb_aim_tb: PASS" severity note;
        done <= true;
        wait;
    end process;
end architecture;
