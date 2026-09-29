-- Тестбенч legion_fft_channelize: raw-группы, LUT, snap последнего бина
-- без двойного счёта, слово как peak_word.
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
use work.legion_pkg.all;

entity legion_fft_channelize_tb is
end entity;

architecture tb of legion_fft_channelize_tb is
    signal clk   : std_logic := '0';
    signal rst   : std_logic := '1';
    signal en    : std_logic := '0';
    signal ctrl  : std_logic_vector(15 downto 0) := (others => '0');
    signal idx   : unsigned(6 downto 0) := (others => '0');
    signal lut_we : std_logic := '0';
    signal lut_a  : unsigned(7 downto 0) := (others => '0');
    signal lut_d  : unsigned(7 downto 0) := (others => '0');
    signal mag_v  : std_logic := '0';
    signal mag_l  : std_logic := '0';
    signal mag_b  : unsigned(7 downto 0) := (others => '0');
    signal mag_p  : unsigned(15 downto 0) := (others => '0');
    signal mag_f  : unsigned(6 downto 0) := (others => '0');
    signal word  : std_logic_vector(31 downto 0);
    signal done  : boolean := false;

    procedure tick(signal c : in std_logic) is
    begin
        wait until rising_edge(c);
    end procedure;

    procedure feed_bin(signal c : in std_logic;
                       signal v : out std_logic;
                       signal last : out std_logic;
                       signal b : out unsigned(7 downto 0);
                       signal p : out unsigned(15 downto 0);
                       constant bin : in integer;
                       constant pow : in integer;
                       constant is_last : in boolean) is
    begin
        b <= to_unsigned(bin, 8);
        p <= to_unsigned(pow, 16);
        last <= '1' when is_last else '0';
        v <= '1';
        wait until rising_edge(c);
        v <= '0';
        last <= '0';
    end procedure;

    procedure feed_frame(signal c : in std_logic;
                         signal v : out std_logic;
                         signal last : out std_logic;
                         signal b : out unsigned(7 downto 0);
                         signal p : out unsigned(15 downto 0);
                         constant hit_bin : in integer;
                         constant hit_pow : in integer) is
    begin
        for i in 0 to 255 loop
            if i = hit_bin then
                feed_bin(c, v, last, b, p, i, hit_pow, i = 255);
            else
                feed_bin(c, v, last, b, p, i, 0, i = 255);
            end if;
        end loop;
    end procedure;
begin
    clk <= not clk after 10 ns when not done;

    dut : entity work.legion_fft_channelize
        port map (
            clock => clk, reset => rst, enable => en,
            ch_ctrl => ctrl, ch_idx => idx,
            lut_we => lut_we, lut_addr => lut_a, lut_data => lut_d,
            mag_valid => mag_v, mag_last => mag_l,
            mag_bin => mag_b, mag_pow => mag_p, mag_frame => mag_f,
            ch_word => word
        );

    stim : process
        variable pwr : integer;
    begin
        wait for 40 ns;
        rst <= '0';
        tick(clk);

        -- raw, grp_shift=5 (32 бина → 8 каналов), n80=0
        en <= '1';
        ctrl <= x"0014"; -- [4:2]=5, map=raw, n80=0
        mag_f <= to_unsigned(3, 7);
        feed_frame(clk, mag_v, mag_l, mag_b, mag_p, 32, 16#1234#);
        -- 80 тактов копии + публикация + регистр слова.
        for k in 0 to 89 loop
            tick(clk);
        end loop;
        idx <= to_unsigned(1, 7);
        for k in 0 to 2 loop
            tick(clk);
        end loop;
        assert word(31) = '1' report "FAIL: raw valid" severity failure;
        assert unsigned(word(7 downto 0)) = to_unsigned(1, 8)
            report "FAIL: raw idx echo" severity failure;
        pwr := to_integer(unsigned(word(23 downto 8)));
        assert pwr = 16#1234#
            report "FAIL: raw ch1 pwr got " & integer'image(pwr) severity failure;
        assert unsigned(word(30 downto 24)) = to_unsigned(3, 7)
            report "FAIL: raw frame" severity failure;

        idx <= to_unsigned(0, 7);
        for k in 0 to 2 loop
            tick(clk);
        end loop;
        assert unsigned(word(23 downto 8)) = 0
            report "FAIL: raw ch0 should be empty" severity failure;

        -- последний бин один несёт энергию: ch = 255>>5 = 7, без двойного счёта
        mag_f <= to_unsigned(4, 7);
        feed_frame(clk, mag_v, mag_l, mag_b, mag_p, 255, 16#00AB#);
        for k in 0 to 89 loop
            tick(clk);
        end loop;
        idx <= to_unsigned(7, 7);
        for k in 0 to 2 loop
            tick(clk);
        end loop;
        pwr := to_integer(unsigned(word(23 downto 8)));
        assert pwr = 16#00AB#
            report "FAIL: last-bin snap got " & integer'image(pwr) severity failure;

        -- LUT: bin 16 → ch 3, остальные 0xFF
        en <= '0';
        tick(clk);
        en <= '1';
        ctrl <= x"0001"; -- map=lut, n80=0
        lut_a <= to_unsigned(16, 8);
        lut_d <= to_unsigned(3, 8);
        lut_we <= '1';
        tick(clk);
        lut_we <= '0';
        mag_f <= to_unsigned(5, 7);
        feed_frame(clk, mag_v, mag_l, mag_b, mag_p, 16, 16#2222#);
        for k in 0 to 89 loop
            tick(clk);
        end loop;
        idx <= to_unsigned(3, 7);
        for k in 0 to 2 loop
            tick(clk);
        end loop;
        pwr := to_integer(unsigned(word(23 downto 8)));
        assert word(31) = '1' report "FAIL: lut valid" severity failure;
        assert pwr = 16#2222#
            report "FAIL: lut ch3 pwr got " & integer'image(pwr) severity failure;
        idx <= to_unsigned(1, 7);
        for k in 0 to 2 loop
            tick(clk);
        end loop;
        assert unsigned(word(23 downto 8)) = 0
            report "FAIL: lut unmapped ch leftover" severity failure;

        -- Одновременные запись и чтение LUT сохраняют текущий VHDL-контракт:
        -- этот бин идёт по старой карте, новая карта действует со следующего.
        en <= '0';
        tick(clk);
        en <= '1';
        lut_a <= to_unsigned(16, 8);
        lut_d <= to_unsigned(4, 8);
        lut_we <= '1';
        mag_f <= to_unsigned(6, 7);
        feed_bin(clk, mag_v, mag_l, mag_b, mag_p, 16, 16#3333#, true);
        lut_we <= '0';
        for k in 0 to 89 loop
            tick(clk);
        end loop;
        idx <= to_unsigned(3, 7);
        for k in 0 to 2 loop
            tick(clk);
        end loop;
        assert unsigned(word(23 downto 8)) = to_unsigned(16#3333#, 16)
            report "FAIL: LUT same-cycle write changed current read" severity failure;
        idx <= to_unsigned(4, 7);
        for k in 0 to 2 loop
            tick(clk);
        end loop;
        assert unsigned(word(23 downto 8)) = 0
            report "FAIL: LUT same-cycle write leaked to new channel" severity failure;

        -- Следующий бин видит уже записанную карту без дополнительного
        -- конвейерного такта и переносит энергию в канал 4.
        mag_f <= to_unsigned(7, 7);
        feed_bin(clk, mag_v, mag_l, mag_b, mag_p, 16, 16#4444#, true);
        for k in 0 to 89 loop
            tick(clk);
        end loop;
        idx <= to_unsigned(4, 7);
        for k in 0 to 2 loop
            tick(clk);
        end loop;
        assert unsigned(word(23 downto 8)) = to_unsigned(16#4444#, 16)
            report "FAIL: LUT update not visible on next read" severity failure;
        idx <= to_unsigned(3, 7);
        for k in 0 to 2 loop
            tick(clk);
        end loop;
        assert unsigned(word(23 downto 8)) = 0
            report "FAIL: previous LUT channel retained energy" severity failure;

        -- enable=0 снимает valid
        en <= '0';
        for k in 0 to 3 loop
            tick(clk);
        end loop;
        assert word(31) = '0' report "FAIL: valid after disable" severity failure;

        report "legion_fft_channelize_tb: PASS" severity note;
        done <= true;
        wait;
    end process;
end architecture;
