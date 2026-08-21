-- Тестбенч legion_player: capture 8 сэмплов → play по кругу, каденс valid.
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity legion_player_tb is
end entity;

architecture tb of legion_player_tb is
    signal clock        : std_logic := '0';
    signal reset        : std_logic := '1';
    signal cap_i        : signed(15 downto 0) := (others => '0');
    signal cap_q        : signed(15 downto 0) := (others => '0');
    signal cap_valid    : std_logic := '0';
    signal capture_arm  : std_logic := '0';
    signal capture_done : std_logic;
    signal play_en      : std_logic := '0';
    signal len_m1       : unsigned(11 downto 0) := to_unsigned(7, 12);  -- 8 сэмплов
    signal out_i        : signed(15 downto 0);
    signal out_q        : signed(15 downto 0);
    signal out_valid    : std_logic;
    signal playing      : std_logic;
    signal done         : boolean := false;
begin
    clock <= not clock after 5 ns when not done;

    dut : entity work.legion_player
        port map (
            clock => clock, reset => reset,
            cap_i => cap_i, cap_q => cap_q, cap_valid => cap_valid,
            capture_arm => capture_arm, capture_done => capture_done,
            play_en => play_en, len_m1 => len_m1,
            out_i => out_i, out_q => out_q, out_valid => out_valid,
            playing => playing
        );

    stim : process
        variable expected : integer;
    begin
        wait for 20 ns;
        reset <= '0';
        wait until rising_edge(clock);

        -- CAPTURE: arm ДО старта потока (контракт: сэмпл на фронте arm
        -- не захватывается — хост сначала армирует, потом стримит)
        capture_arm <= '1';
        wait until rising_edge(clock);
        wait until rising_edge(clock);
        for k in 1 to 8 loop
            cap_i <= to_signed(k * 10, 16);
            cap_q <= to_signed(-k * 10, 16);
            cap_valid <= '1';
            wait until rising_edge(clock);
            cap_valid <= '0';
            wait until rising_edge(clock);
        end loop;
        wait until rising_edge(clock);
        assert capture_done = '1' report "FAIL: capture_done not set" severity failure;
        capture_arm <= '0';
        wait until rising_edge(clock);

        -- PLAY: два полных круга = 16 сэмплов; проверяем порядок и каденс.
        -- Сэмплирование по тактам (синхронная логика): valid высок ровно один
        -- цикл; на следующем такте после обнаружения — уже 0.
        play_en <= '1';
        for k in 0 to 15 loop
            expected := ((k mod 8) + 1) * 10;
            loop
                wait until rising_edge(clock);
                exit when out_valid = '1';
            end loop;
            assert out_i = to_signed(expected, 16)
                report "FAIL: play I iter " & integer'image(k) severity failure;
            assert out_q = to_signed(-expected, 16)
                report "FAIL: play Q iter " & integer'image(k) severity failure;
            wait until rising_edge(clock);
            assert out_valid = '0' report "FAIL: valid not low on 2nd clock" severity failure;
        end loop;
        assert playing = '1' report "FAIL: playing not active" severity failure;

        play_en <= '0';
        wait until rising_edge(clock);
        wait until rising_edge(clock);
        assert playing = '0' report "FAIL: playing not cleared" severity failure;

        report "legion_player_tb: PASS" severity note;
        done <= true;
        wait;
    end process;
end architecture;
