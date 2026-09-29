-- ============================================================================
-- LEGION — канальный аккумулятор после radix-2 DIT-256.
-- Не PFB (GNU Radio pfb_channelizer — IQ каналов). Occupancy:
--   Σ mag[31:16] по корзине, как USRP FPGA scanner (FOSDEM: energy window).
-- map raw: ch = (fftshift(bin) | bin) >> grp_shift, клип к 8 или 80.
-- map lut: NIOS пишет bin→ch (ELRS 80×1 МГц / ISM 8×10 МГц / O4 3 центра).
-- 64 бина = 10 МГц только при fs=40e6; на xA4 56e6 это ~14 МГц — поэтому LUT.
-- Слово: [7:0] idx, [23:8] pwr, [30:24] frame, [31] valid — как peak_word.
-- ============================================================================
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
use work.legion_pkg.all;

entity legion_fft_channelize is
    port (
        clock     : in  std_logic;
        reset     : in  std_logic;
        enable    : in  std_logic;
        ch_ctrl   : in  std_logic_vector(15 downto 0);
        ch_idx    : in  unsigned(6 downto 0);
        lut_we    : in  std_logic;
        lut_addr  : in  unsigned(7 downto 0);
        lut_data  : in  unsigned(7 downto 0);
        mag_valid : in  std_logic;
        mag_last  : in  std_logic;
        mag_bin   : in  unsigned(7 downto 0);
        mag_pow   : in  unsigned(15 downto 0);
        mag_frame : in  unsigned(6 downto 0);
        ch_word   : out std_logic_vector(31 downto 0)
    );
end entity;

architecture rtl of legion_fft_channelize is
    type acc_t is array (0 to LEGION_CH_N - 1) of unsigned(23 downto 0);
    type pwr_t is array (0 to LEGION_CH_N - 1) of unsigned(15 downto 0);
    type lut_t is array (0 to 255) of unsigned(7 downto 0);

    signal acc   : acc_t := (others => (others => '0'));
    signal snap  : pwr_t := (others => (others => '0'));
    signal lut   : lut_t := (others => x"FF");
    -- Mapping is intentionally available in the same cycle as mag_bin.
    -- Declaring logic storage preserves that contract on Cyclone IV and V
    -- instead of asking Quartus to infer an unsupported asynchronous M9K/M10K.
    attribute ramstyle : string;
    attribute ramstyle of lut : signal is "logic";
    signal fr_r  : unsigned(6 downto 0) := (others => '0');
    signal vld_r : std_logic := '0';
    signal word_r : std_logic_vector(31 downto 0) := (others => '0');

    function sat16(x : unsigned(23 downto 0)) return unsigned is
    begin
        if x(23 downto 16) /= x"00" then
            return x"FFFF";
        end if;
        return x(15 downto 0);
    end function;
begin
    ch_word <= word_r;

    lut_p : process(clock)
    begin
        if rising_edge(clock) then
            if lut_we = '1' then
                lut(to_integer(lut_addr)) <= lut_data;
            end if;
        end if;
    end process;

    acc_p : process(clock, reset)
        variable map_mode : unsigned(1 downto 0);
        variable sh       : integer;
        variable n_ch     : integer;
        variable b        : unsigned(7 downto 0);
        variable ch       : unsigned(7 downto 0);
        variable idx      : integer;
        variable rd       : integer;
        variable pwr      : unsigned(15 downto 0);
        variable skip_dc  : boolean;
    begin
        if reset = '1' then
            acc    <= (others => (others => '0'));
            snap   <= (others => (others => '0'));
            fr_r   <= (others => '0');
            vld_r  <= '0';
            word_r <= (others => '0');
        elsif rising_edge(clock) then
            if enable = '0' then
                acc    <= (others => (others => '0'));
                snap   <= (others => (others => '0'));
                vld_r  <= '0';
                word_r <= (others => '0');
            else
                map_mode := unsigned(ch_ctrl(1 downto 0));
                sh := to_integer(unsigned(ch_ctrl(4 downto 2)));
                if ch_ctrl(LEGION_CH_N80) = '1' then
                    n_ch := LEGION_CH_N;
                else
                    n_ch := 8;
                end if;
                skip_dc := ch_ctrl(LEGION_CH_DC_SKIP) = '1';

                if mag_valid = '1' then
                    b := mag_bin;
                    if map_mode = to_unsigned(LEGION_CH_MAP_LUT, 2) then
                        ch := lut(to_integer(b));
                    else
                        if ch_ctrl(LEGION_CH_FFTSHIFT) = '1' then
                            b := b + 128;
                        end if;
                        ch := shift_right(b, sh);
                    end if;
                    if (not skip_dc or mag_bin /= 0) and ch < n_ch then
                        idx := to_integer(ch);
                        if acc(idx) > (x"FFFFFF" - resize(mag_pow, 24)) then
                            acc(idx) <= x"FFFFFF";
                        else
                            acc(idx) <= acc(idx) + resize(mag_pow, 24);
                        end if;
                    end if;
                    if mag_last = '1' then
                        -- snap в следующем такте от обновлённого acc нельзя:
                        -- здесь добиваем текущий бин в копии и защёлкиваем.
                        for k in 0 to LEGION_CH_N - 1 loop
                            if k = to_integer(ch) and ch < n_ch
                               and (not skip_dc or mag_bin /= 0) then
                                if acc(k) > (x"FFFFFF" - resize(mag_pow, 24)) then
                                    snap(k) <= x"FFFF";
                                else
                                    snap(k) <= sat16(acc(k) + resize(mag_pow, 24));
                                end if;
                            else
                                snap(k) <= sat16(acc(k));
                            end if;
                        end loop;
                        acc   <= (others => (others => '0'));
                        fr_r  <= mag_frame;
                        vld_r <= '1';
                    end if;
                end if;

                rd := to_integer(ch_idx);
                if rd < LEGION_CH_N then
                    pwr := snap(rd);
                else
                    pwr := (others => '0');
                end if;
                word_r(7 downto 0)   <= std_logic_vector(resize(ch_idx, 8));
                word_r(23 downto 8)  <= std_logic_vector(pwr);
                word_r(30 downto 24) <= std_logic_vector(fr_r);
                word_r(31)           <= vld_r;
            end if;
        end if;
    end process;
end architecture;
