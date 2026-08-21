#!/usr/bin/env python3
"""Проверка legion_fpga.py без железа:

1. ЗОЛОТОЙ ТЕСТ: Python-упаковщик сравнивается БАЙТ-В-БАЙТ с настоящим
   nios_pkt_8x32_pack() из дерева Nuand (компилируется gcc на лету).
2. Зеркало регистровой карты: константы Python == legion_pkg.vhd == legion_cmds.h.
3. unpack: разбор ответа (success/data).

Запуск: python3 fpga/test/test_legion_fpga.py [путь к дереву Nuand bladeRF]
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "host"))
import legion_fpga as lf  # noqa: E402

NUAND = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("BLADERF_TREE", "/tmp/bladerf-hdl")

fails = 0


def check(name: str, cond: bool, detail: str = "") -> None:
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + name + ("" if cond else f"  {detail}"))
    if not cond:
        fails += 1


# ---------------------------------------------------------------------------
# 1. Золотой тест против реального C-заголовка Nuand
# ---------------------------------------------------------------------------
C_SRC = r"""
#include <stdio.h>
#include <stdint.h>
#include <stdbool.h>
#include "nios_pkt_formats.h"
#include "nios_pkt_8x32.h"

int main(void) {
    uint8_t buf[NIOS_PKT_LEN];
    /* тестовые вектора: target/write/addr/data */
    uint8_t targets[] = {0x80, 0x01, 0xFF};
    uint8_t addrs[] = {0x00, 0x05, 0xFF};
    uint32_t datas[] = {0x00000000, 0x1, 0xDEADBEEF, 0x0ABCDEF0, 0xFFFFFFFF};
    for (int t = 0; t < 3; t++)
        for (int w = 0; w < 2; w++)
            for (int a = 0; a < 3; a++)
                for (int d = 0; d < 5; d++) {
                    nios_pkt_8x32_pack(buf, targets[t], w, addrs[a], datas[d]);
                    for (int i = 0; i < NIOS_PKT_LEN; i++) printf("%02x", buf[i]);
                    printf("\n");
                }
    return 0;
}
"""

hdr = os.path.join(NUAND, "fpga_common", "include", "nios_pkt_8x32.h")
if os.path.isfile(hdr):
    with tempfile.TemporaryDirectory() as td:
        src = os.path.join(td, "ref.c")
        exe = os.path.join(td, "ref")
        with open(src, "w") as f:
            f.write(C_SRC)
        libinc = os.path.join(NUAND, "host", "libraries", "libbladeRF", "include")
        cc = subprocess.run(
            ["gcc", "-I", os.path.dirname(hdr), "-I", libinc, src, "-o", exe],
            capture_output=True, text=True)
        check("gcc собрал реальный nios_pkt_8x32.h", cc.returncode == 0, cc.stderr[-200:])
        if cc.returncode == 0:
            ref = subprocess.run([exe], capture_output=True, text=True).stdout.strip().split("\n")
            mine = []
            for t in (0x80, 0x01, 0xFF):
                for w in (False, True):  # как в C: w=0 (read), затем w=1 (write)
                    for a in (0x00, 0x05, 0xFF):
                        for d in (0x00000000, 0x1, 0xDEADBEEF, 0x0ABCDEF0, 0xFFFFFFFF):
                            mine.append(lf.pack_8x32(t, w, a, d).hex())
            check(f"байт-в-байт совпадение с Nuand C ({len(ref)} векторов)",
                  ref == mine, f"ref={len(ref)} mine={len(mine)}")
else:
    check("дерево Nuand (fpga_common/include/nios_pkt_8x32.h)", False,
          f"не найдено: {hdr} — задайте BLADERF_TREE")

# ---------------------------------------------------------------------------
# 2. Зеркало регистровой карты: Python vs VHDL vs NIOS-C
# ---------------------------------------------------------------------------
def vhdl_consts() -> dict:
    src = open(os.path.join(ROOT, "hdl", "legion_pkg.vhd"), encoding="utf-8").read()
    out = {}
    for name, val in re.findall(r"constant\s+(LEGION_REG_\w+)\s*:\s*natural\s*:=\s*16#([0-9A-F]+)#", src):
        out[name] = int(val, 16)
    return out


def nios_consts() -> dict:
    src = open(os.path.join(ROOT, "nios", "legion_cmds.h"), encoding="utf-8").read()
    out = {}
    for name, val in re.findall(r"#define\s+(LEGION_REG_\w+)\s+0x([0-9A-Fa-f]+)", src):
        out[name] = int(val, 16)
    return out


py_map = {
    "LEGION_REG_CTRL": lf.REG_CTRL,
    "LEGION_REG_NCO_FTW": lf.REG_NCO_FTW,
    "LEGION_REG_DET_THR": lf.REG_DET_THR,
    "LEGION_REG_DET_SHIFT": lf.REG_DET_SHIFT,
    "LEGION_REG_PLAYER_LEN": lf.REG_PLAYER_LEN,
    "LEGION_REG_PLAYER_CTL": lf.REG_PLAYER_CTL,
    "LEGION_REG_LB_SHIFT": lf.REG_LB_SHIFT,
    "LEGION_REG_WD_LIMIT": lf.REG_WD_LIMIT,
    "LEGION_REG_WD_KICK": lf.REG_WD_KICK,
}

v, n = vhdl_consts(), nios_consts()
for name, pyval in py_map.items():
    check(f"карта {name}: py={pyval} vhdl={v.get(name)} nios={n.get(name)}",
          v.get(name) == pyval and n.get(name) == pyval)

# ---------------------------------------------------------------------------
# 3. unpack ответа
# ---------------------------------------------------------------------------
resp = bytearray(16)
resp[0] = ord("C")
resp[2] = lf.NIOS_PKT_8x32_FLAG_SUCCESS
resp[5:9] = (0xDEADBEEF).to_bytes(4, "little")
ok, data = lf.unpack_8x32_resp(bytes(resp))
check("unpack: success+data", ok and data == 0xDEADBEEF)
ok2, _ = lf.unpack_8x32_resp(bytes(16))
check("unpack: неверный magic → fail", not ok2)

# ---------------------------------------------------------------------------
# 4. Шлюз: TCP loopback с FAKE-транспортом (протокол без железа)
# ---------------------------------------------------------------------------
os.environ["LEGION_FPGA_FAKE"] = "1"
sys.path.insert(0, os.path.join(ROOT, "host"))
import legion_gateway as lg  # noqa: E402
import socket as _socket  # noqa: E402

gw = lg.LegionGateway(fake=True)
srv = lg._Server(("127.0.0.1", 0), lg._Handler)
srv.gw = gw
import threading as _th
_th.Thread(target=srv.serve_forever, daemon=True).start()
port = srv.server_address[1]


def rpc(msg: dict) -> dict:
    with _socket.create_connection(("127.0.0.1", port), timeout=3) as s:
        s.sendall((json_dumps(msg) + "\n").encode())
        f = s.makefile("rb")
        return json_loads(f.readline().decode())


import json as _json  # noqa: E402
json_dumps = lambda m: _json.dumps(m, ensure_ascii=False)  # noqa: E731
json_loads = _json.loads

r = rpc({"op": "ping"})
check("gateway ping (fake)", r.get("ok") is True and r.get("fake") is True)

r = rpc({"op": "arm", "mode": "player"})
check("gateway arm player", r.get("ok") is True)
check("fake: CTRL записан", gw.fpga._t.regs.get(lf.REG_CTRL) ==
      lf.CTRL_ARM | (lf.MODE_PLAYER << 1) | lf.CTRL_WD_EN)

r = rpc({"op": "status"})
check("gateway status playing", r.get("ok") is True and r.get("playing") is True)

r = rpc({"op": "set", "reg": "nco_ftw", "value": 12345678})
check("gateway set nco_ftw", r.get("ok") is True and
      gw.fpga._t.regs.get(lf.REG_NCO_FTW) == 12345678)

r = rpc({"op": "set", "reg": "nope", "value": 1})
check("gateway set неизвестного reg → отказ", r.get("ok") is False)

r = rpc({"op": "arm", "mode": "nonsense"})
check("gateway arm неизвестного mode → отказ", r.get("ok") is False)

r = rpc({"op": "disarm"})
check("gateway disarm", r.get("ok") is True and
      gw.fpga._t.regs.get(lf.REG_CTRL) == 0)

srv.shutdown()
srv.server_close()

print("LEGION FPGA HOST: ALL PASS" if fails == 0 else f"LEGION FPGA HOST: {fails} FAILURES")
sys.exit(0 if fails == 0 else 1)
