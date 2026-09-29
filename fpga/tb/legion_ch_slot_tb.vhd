-- Слот 10 МГц: новая функция без оператора "/" обязана совпасть
-- со старым trunc-делением (k·fs ± 128000) / 256000 и / 10000.
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
use work.legion_pkg.all;

entity legion_ch_slot_tb is
end entity;

architecture tb of legion_ch_slot_tb is
    function ref_slot(bin : natural; fs : unsigned(31 downto 0);
                      lo : unsigned(31 downto 0)) return integer is
        variable sb      : integer;
        variable prod    : signed(47 downto 0);
        variable off_khz : signed(31 downto 0);
        variable f_khz   : integer;
        variable slot    : integer;
    begin
        if fs = 0 or lo = 0 then
            return bin / 32;
        end if;
        if bin < 128 then
            sb := bin;
        else
            sb := bin - 256;
        end if;
        prod := to_signed(sb, 16) * signed(resize(fs, 32));
        if prod >= 0 then
            off_khz := resize((prod + to_signed(128000, 48)) /
                              to_signed(256000, 48), 32);
        else
            off_khz := resize((prod - to_signed(128000, 48)) /
                              to_signed(256000, 48), 32);
        end if;
        f_khz := to_integer(signed(resize(lo, 32)) + off_khz);
        if f_khz < LEGION_OCUSYNC_F0_KHZ or
           f_khz >= LEGION_OCUSYNC_F0_KHZ + 8 * LEGION_OCUSYNC_BW_KHZ then
            return -1;
        end if;
        slot := (f_khz - LEGION_OCUSYNC_F0_KHZ) / LEGION_OCUSYNC_BW_KHZ;
        if slot < 0 or slot > 7 then
            return -1;
        end if;
        return slot;
    end function;
begin
    stim : process
        type fs_arr_t is array (natural range <>) of unsigned(31 downto 0);
        type lo_arr_t is array (natural range <>) of unsigned(31 downto 0);
        constant fs_list : fs_arr_t := (
            x"00000000", x"00000001", x"000003E7", x"000003E8",
            x"000007FF", x"00000800", x"00002710", x"0001E848",
            x"0003D090", x"000F4240", x"002625A0", x"02625A00",
            x"0356F8C0", x"03A98000", x"07530000", x"7FFFFFFF",
            x"80000000", x"FFFFFFFF", x"00FFFFFF", x"01000000"
        );
        constant lo_list : lo_arr_t := (
            x"00000000", x"00249F00", x"00251C40", x"00253A80",
            x"0025D4D8", x"002DC6C0", x"FFFFFFFF"
        );
        variable got : integer;
        variable exp : integer;
        variable n   : integer := 0;
    begin
        got := legion_ch_slot(16, to_unsigned(40000000, 32),
                              to_unsigned(2440000, 32));
        assert got = 4
            report "FAIL: bin16 @ 40 MHz slot " & integer'image(got)
            severity failure;

        got := legion_ch_slot(240, to_unsigned(40000000, 32),
                              to_unsigned(2440000, 32));
        exp := ref_slot(240, to_unsigned(40000000, 32),
                        to_unsigned(2440000, 32));
        assert got = exp
            report "FAIL: bin240 slot" severity failure;
        assert got = 3
            report "FAIL: bin240 expected slot 3 got " & integer'image(got)
            severity failure;

        for b in 0 to 255 loop
            for fi in fs_list'range loop
                for li in lo_list'range loop
                    got := legion_ch_slot(b, fs_list(fi), lo_list(li));
                    exp := ref_slot(b, fs_list(fi), lo_list(li));
                    assert got = exp
                        report "FAIL: bin " & integer'image(b)
                            & " fs " & integer'image(to_integer(fs_list(fi)))
                            & " got " & integer'image(got)
                            & " exp " & integer'image(exp)
                        severity failure;
                    n := n + 1;
                end loop;
            end loop;
        end loop;

        report "legion_ch_slot_tb: PASS" severity note;
        wait;
    end process;
end architecture;
