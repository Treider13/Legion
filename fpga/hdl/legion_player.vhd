-- ============================================================================
-- LEGION — плеер волны из RAM (tx_clock домен).
-- CAPTURE: capture_arm взводится ДО старта потока (контракт: сэмпл,
--   совпавший с фронтом capture_arm, не захватывается — хост армирует,
--   затем стримит). Пока capture_arm='1', сэмплы с входа (выход fifo_reader —
--   обычный TX-стрим хоста) пишутся в RAM; по достижении len capture_done='1'
--   (липкий, держится после снятия capture_arm).
-- PLAY: пока play_en='1', RAM читается по кругу; valid импульс каждый 2-й такт
--   — контракт TX-интерфейса LMS6002D (lms6002d.vhd, процесс tx_sample).
-- RAM: 4096×32 (I16:Q16) — на EP4CE40 отображается на 16 блоков M9K.
-- ============================================================================
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity legion_player is
    generic (
        DEPTH : natural := 4096
    );
    port (
        clock        : in  std_logic;
        reset        : in  std_logic;
        -- CAPTURE: входной поток (tx_clock домен, из fifo_reader)
        cap_i        : in  signed(15 downto 0);
        cap_q        : in  signed(15 downto 0);
        cap_valid    : in  std_logic;
        capture_arm  : in  std_logic;
        capture_done : out std_logic;
        -- PLAY
        play_en      : in  std_logic;
        len_m1       : in  unsigned(11 downto 0);  -- длина-1 (0..4095)
        out_i        : out signed(15 downto 0);
        out_q        : out signed(15 downto 0);
        out_valid    : out std_logic;
        playing      : out std_logic
    );
end entity;

architecture rtl of legion_player is
    type ram_t is array (0 to DEPTH-1) of std_logic_vector(31 downto 0);
    signal ram : ram_t := (others => (others => '0'));
    -- Подсказка фиттеру Quartus: разместить в M9K (не в LE)
    attribute ramstyle : string;
    attribute ramstyle of ram : signal is "M9K";

    signal wr_addr    : unsigned(11 downto 0);
    signal rd_addr    : unsigned(11 downto 0);
    signal cap_done_r : std_logic;
    signal cap_arm_d  : std_logic;  -- детект фронта capture_arm
    signal phase      : std_logic;  -- 0/1: valid каждый 2-й такт
    signal playing_r  : std_logic;
begin
    capture_done <= cap_done_r;
    playing      <= playing_r;

    -- Запись (capture) и чтение (play) — один процесс на порт, синхронная RAM
    ram_rw : process(clock)
        variable rd_word : std_logic_vector(31 downto 0);
    begin
        if rising_edge(clock) then
            -- CAPTURE порт
            if capture_arm = '1' and cap_valid = '1' and cap_done_r = '0' then
                ram(to_integer(wr_addr)) <= std_logic_vector(cap_i) & std_logic_vector(cap_q);
            end if;
            -- PLAY порт (синхронное чтение): читаем при phase='0',
            -- чтобы данные были на выходе к такту, где out_valid='1'
            if play_en = '1' and phase = '0' then
                rd_word := ram(to_integer(rd_addr));
                out_i <= signed(rd_word(31 downto 16));
                out_q <= signed(rd_word(15 downto 0));
            end if;
        end if;
    end process;

    control : process(clock, reset)
    begin
        if reset = '1' then
            wr_addr    <= (others => '0');
            rd_addr    <= (others => '0');
            cap_done_r <= '0';
            cap_arm_d  <= '0';
            phase      <= '0';
            playing_r  <= '0';
            out_valid  <= '0';
        elsif rising_edge(clock) then
            -- ---------- CAPTURE ----------
            -- capture_done ЛИПКИЙ: держится после снятия capture_arm
            -- (иначе play никогда не стартует). Сброс — новым фронтом arm.
            cap_arm_d <= capture_arm;
            if capture_arm = '1' and cap_arm_d = '0' then
                wr_addr    <= (others => '0');
                cap_done_r <= '0';
            elsif capture_arm = '1' and cap_done_r = '0' and cap_valid = '1' then
                if wr_addr = len_m1 then
                    cap_done_r <= '1';           -- записано len сэмплов
                else
                    wr_addr <= wr_addr + 1;
                end if;
            end if;

            -- ---------- PLAY (valid каждый 2-й такт — контракт LMS TX) ----------
            out_valid <= '0';
            if play_en = '1' and cap_done_r = '1' then
                phase <= not phase;
                if phase = '1' then
                    out_valid <= '1';
                    playing_r <= '1';
                    if rd_addr = len_m1 then
                        rd_addr <= (others => '0');
                    else
                        rd_addr <= rd_addr + 1;
                    end if;
                end if;
            else
                phase     <= '0';
                playing_r <= '0';
                rd_addr   <= (others => '0');
            end if;
        end if;
    end process;
end architecture;
