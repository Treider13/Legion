-- Связка как в bladerf-legion: одно CDC-слово
-- [63:32] = база DC, [31:0] = вырез, уже крутящийся на +90° за сэмпл.
-- aim(bin=64) на верхней половине даёт +90°. Та же синусоида от нижней
-- половины дала бы +180°: второй сэмпл I≈−AMP, а не Q≈+AMP.
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity legion_lb_aim_pipe_tb is
end entity;

architecture tb of legion_lb_aim_pipe_tb is
    constant AMP : integer := 4000;

    signal wr_clk   : std_logic := '0';
    signal rd_clk   : std_logic := '0';
    signal wr_reset : std_logic := '1';
    signal rd_reset : std_logic := '1';
    signal wr_data  : std_logic_vector(63 downto 0) := (others => '0');
    signal wr_en    : std_logic := '0';
    signal wr_full  : std_logic;
    signal rd_word  : std_logic_vector(63 downto 0);
    signal rd_en    : std_logic := '0';
    signal rd_empty : std_logic;
    signal rd_level : unsigned(7 downto 0);
    signal bb_dly   : std_logic_vector(31 downto 0);
    signal aim_out  : std_logic_vector(31 downto 0);
    signal ch_target : std_logic_vector(31 downto 0) := x"80000040";
    signal dly      : unsigned(11 downto 0) := (others => '0');
    signal done     : boolean := false;

    function pack(i, q : integer) return std_logic_vector is
    begin
        return std_logic_vector(to_signed(i, 16)) & std_logic_vector(to_signed(q, 16));
    end function;

    -- Вырез, уже стоящий на +90° за сэмпл (bin 64 до синтеза).
    function cutout_at(k : integer) return std_logic_vector is
    begin
        case k mod 4 is
            when 0 => return pack(AMP, 0);
            when 1 => return pack(0, AMP);
            when 2 => return pack(-AMP, 0);
            when others => return pack(0, -AMP);
        end case;
    end function;
begin
    wr_clk <= not wr_clk after 5 ns when not done;
    rd_clk <= not rd_clk after 5.5 ns when not done;

    fifo : entity work.legion_dcfifo
        generic map ( WIDTH => 64 )
        port map (
            wr_clk => wr_clk, wr_reset => wr_reset,
            wr_data => wr_data, wr_en => wr_en, wr_full => wr_full,
            rd_clk => rd_clk, rd_reset => rd_reset,
            rd_data => rd_word, rd_en => rd_en,
            rd_empty => rd_empty, rd_level => rd_level
        );

    dline : entity work.legion_delayline
        port map (
            clock => rd_clk, reset => rd_reset,
            delay => dly, din => rd_word(63 downto 32),
            sample_en => rd_en, dout => bb_dly
        );

    aim : entity work.legion_lb_aim
        port map (
            clock => rd_clk, reset => rd_reset,
            ch_target => ch_target, sample_en => rd_en,
            din => bb_dly, dout => aim_out
        );

    stim : process
        variable n    : integer := 0;
        variable yi   : integer;
        variable yq   : integer;
        variable seen : std_logic_vector(31 downto 0);
    begin
        wait for 40 ns;
        wr_reset <= '0';
        rd_reset <= '0';
        wait for 40 ns;

        for k in 0 to 7 loop
            wr_data <= pack(AMP, 0) & cutout_at(k);
            wr_en <= '1';
            wait until rising_edge(wr_clk);
        end loop;
        wr_en <= '0';

        while n < 4 loop
            wait until rising_edge(rd_clk);
            if rd_empty = '0' and rd_en = '0' then
                seen := rd_word(63 downto 32);
                assert seen = pack(AMP, 0)
                    report "FAIL: baseband half is not DC" severity failure;
                seen := rd_word(31 downto 0);
                assert seen = cutout_at(n)
                    report "FAIL: cutout half lost at " & integer'image(n)
                    severity failure;
                rd_en <= '1';
            elsif rd_en = '1' then
                wait for 1 ns;
                yi := to_integer(signed(aim_out(31 downto 16)));
                yq := to_integer(signed(aim_out(15 downto 0)));
                if n = 0 then
                    assert abs(yi - AMP) < 40 and abs(yq) < 40
                        report "FAIL: phase0 yi=" & integer'image(yi)
                        severity failure;
                elsif n = 1 then
                    -- База × +90°. Вырез × +90° был бы yi≈−AMP, yq≈0.
                    assert abs(yi) < 40 and abs(yq - AMP) < 40
                        report "FAIL: double-shift yi=" & integer'image(yi) &
                               " yq=" & integer'image(yq)
                        severity failure;
                elsif n = 2 then
                    assert abs(yi + AMP) < 40 and abs(yq) < 40
                        report "FAIL: +180 yi=" & integer'image(yi)
                        severity failure;
                else
                    assert abs(yi) < 40 and abs(yq + AMP) < 40
                        report "FAIL: +270 yq=" & integer'image(yq)
                        severity failure;
                end if;
                n := n + 1;
                rd_en <= '0';
            end if;
        end loop;

        report "legion_lb_aim_pipe_tb: PASS" severity note;
        done <= true;
        wait;
    end process;
end architecture;
