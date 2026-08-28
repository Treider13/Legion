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

# По умолчанию — вендоренное дерево в репозитории (самодостаточно);
# переопределение: аргумент или BLADERF_TREE (для сверки со свежим апстримом).
NUAND = sys.argv[1] if len(sys.argv) > 1 else os.environ.get(
    "BLADERF_TREE", os.path.join(ROOT, "vendor", "bladerf"))

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
    "LEGION_REG_AIR_FREQ_KHZ": lf.REG_AIR_FREQ_KHZ,
    "LEGION_REG_AIR_GAIN_DB": lf.REG_AIR_GAIN_DB,
    "LEGION_REG_AIR_PREP": lf.REG_AIR_PREP,
    "LEGION_REG_AIR_FS_HZ": lf.REG_AIR_FS_HZ,
    "LEGION_REG_AIR_BW_HZ": lf.REG_AIR_BW_HZ,
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
# 3.5. USB-константы шлюза против реальных заголовков Nuand (без памяти!)
# ---------------------------------------------------------------------------
usb_h = os.path.join(NUAND, "host", "libraries", "libbladeRF", "src", "backend", "usb", "usb.h")
brf_h = os.path.join(NUAND, "firmware_common", "bladeRF.h")
if os.path.isfile(usb_h) and os.path.isfile(brf_h):
    usb_src = open(usb_h, encoding="utf-8").read()
    brf_src = open(brf_h, encoding="utf-8").read()

    def define_val(src: str, name: str) -> int | None:
        m = re.search(rf"#define\s+{name}\s+0x([0-9A-Fa-f]+)", src)
        if m:
            return int(m.group(1), 16)
        m = re.search(rf"#define\s+{name}\s+(\d+)\s*$", src, re.M)
        return int(m.group(1)) if m else None

    import legion_gateway as lg2  # noqa: E402
    check("EP_OUT == PERIPHERAL_EP_OUT (usb.h)",
          lg2.EP_OUT == define_val(usb_src, "PERIPHERAL_EP_OUT"),
          f"мой={lg2.EP_OUT:#x} nuand={define_val(usb_src, 'PERIPHERAL_EP_OUT')}")
    check("EP_IN == PERIPHERAL_EP_IN (usb.h)",
          lg2.EP_IN == define_val(usb_src, "PERIPHERAL_EP_IN"),
          f"мой={lg2.EP_IN:#x} nuand={define_val(usb_src, 'PERIPHERAL_EP_IN')}")
    check("TIMEOUT == PERIPHERAL_TIMEOUT_MS (usb.h)",
          lg2.TIMEOUT_MS == define_val(usb_src, "PERIPHERAL_TIMEOUT_MS"))
    check("VID == USB_NUAND_VENDOR_ID (bladeRF.h)",
          lg2.BLADERF_VID == define_val(brf_src, "USB_NUAND_VENDOR_ID"))
    check("PID bladeRF1 в списке (bladeRF.h)",
          define_val(brf_src, "USB_NUAND_BLADERF_PRODUCT_ID") in lg2.BLADERF_PIDS)
    check("PID micro в списке (bladeRF.h)",
          define_val(brf_src, "USB_NUAND_BLADERF2_PRODUCT_ID") in lg2.BLADERF_PIDS)
else:
    check("заголовки Nuand для USB-констант", False, f"нет {usb_h} / {brf_h}")

# ---------------------------------------------------------------------------
# 3.6. Зеркало битов статуса: VHDL status_tx vs Python read_status
# ---------------------------------------------------------------------------
regs_vhd = open(os.path.join(ROOT, "hdl", "legion_regs.vhd"), encoding="utf-8").read()
status_bits = dict(re.findall(r"status_tx\((\d+)\)\s*<=\s*tx_(\w+);", regs_vhd))
check("статус bit0=playing (VHDL)", status_bits.get("0") == "playing")
check("статус bit1=cap_done (VHDL)", status_bits.get("1") == "cap_done")
check("статус bit2=det_active (VHDL)", status_bits.get("2") == "det_active")
check("статус bit3=wd_fired (VHDL)", status_bits.get("3") == "wd_fired")
py_bits = {"playing": 0, "capture_done": 1, "det_active": 2, "wd_fired": 3}
# Python read_status: playing=bit0, capture_done=bit1, det_active=bit2, wd_fired=bit3
host_src = open(os.path.join(ROOT, "host", "legion_fpga.py"), encoding="utf-8").read()
for key, bit in py_bits.items():
    check(f"py read_status {key}=bit{bit}", f'"{key}": bool(data & (1 << {bit}))' in host_src)

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

r = rpc({"op": "arm", "mode": "nco", "nco_ftw": 0x20000000})
check("arm nco пишет FTW", r.get("ok") is True and
      gw.fpga._t.regs.get(lf.REG_NCO_FTW) == 0x20000000)
r = rpc({"op": "arm", "mode": "nco"})
ftw_default = gw.fpga._t.regs.get(lf.REG_NCO_FTW)
check("arm nco без FTW → fs/8, не DC", r.get("ok") is True and ftw_default not in (None, 0))

r = rpc({"op": "set", "reg": "nope", "value": 1})
check("gateway set неизвестного reg → отказ", r.get("ok") is False)

r = rpc({"op": "arm", "mode": "nonsense"})
check("gateway arm неизвестного mode → отказ", r.get("ok") is False)

# lb_gated без порога → честный отказ (порог 0 = гейт на шум)
r = rpc({"op": "arm", "mode": "lb_gated"})
check("lb_gated без det_thr → отказ", r.get("ok") is False)
r = rpc({"op": "arm", "mode": "lb_gated", "det_thr": 5000, "det_shift": 4})
check("lb_gated с det_thr → ok", r.get("ok") is True)
check("det_thr записан до CTRL", gw.fpga._t.regs.get(lf.REG_DET_THR) == 5000)
check("det_shift=4 (окно 16 сэмплов = 8 µs @ 2 МГц)",
      gw.fpga._t.regs.get(lf.REG_DET_SHIFT) == 4)
# Analog RX+TX штатным CONTROL (бит1 lms_rx_enable, бит2 lms_tx_enable)
check("lb_gated: RX включён через CONTROL RMW (бит1)",
      bool(gw.fpga._t.control & 0x2))
check("lb_gated: TX включён через CONTROL RMW (бит2)",
      bool(gw.fpga._t.control & 0x4))
r = rpc({"op": "disarm"})
check("disarm снимает наш RX-enable", not (gw.fpga._t.control & 0x2))
check("disarm снимает наш TX-enable", not (gw.fpga._t.control & 0x4))
# повторный arm для следующего теста
rpc({"op": "arm", "mode": "player"})
check("player: TX включён через CONTROL (бит2)",
      bool(gw.fpga._t.control & 0x4))

# Heartbeat — релей от ноутбука, агент сам НЕ генерирует
r = rpc({"op": "kick"})
check("kick релей + last_kick обновлён", r.get("ok") is True and gw.last_kick > 0)
check("агент без само-кика (нет _start_kick)", not hasattr(gw, "_start_kick"))

r = rpc({"op": "disarm"})
check("gateway disarm", r.get("ok") is True and
      gw.fpga._t.regs.get(lf.REG_CTRL) == 0)

# USB release/acquire (один владелец): release → команды честно падают,
# acquire → работают снова. Регистры FPGA переживают смену владельца.
r = rpc({"op": "usb", "action": "release"})
check("usb release ok", r.get("ok") is True)
r = rpc({"op": "status"})
check("при отпущенном USB status → честный отказ", r.get("ok") is False)
r = rpc({"op": "usb", "action": "acquire"})
check("usb acquire ok", r.get("ok") is True)
r = rpc({"op": "status"})
check("после acquire status снова работает", r.get("ok") is True)
check("регистры пережили смену владельца (CTRL сохранён в fake)",
      gw.fpga._t.regs.get(lf.REG_CTRL) is not None)
r = rpc({"op": "usb", "action": "nonsense"})
check("usb nonsense action → отказ", r.get("ok") is False)

# RX on/off через штатный CONTROL (бит 1), RMW
r = rpc({"op": "rx", "on": True})
check("rx on → CONTROL bit1 взведён", r.get("ok") is True and bool(gw.fpga._t.control & 0x2))
r = rpc({"op": "rx", "on": False})
check("rx off → CONTROL bit1 снят", r.get("ok") is True and not (gw.fpga._t.control & 0x2))

# Сбой чтения CONTROL: нельзя писать 0 (lms_reset + полосы LMS)
gw.fpga._t.control = 0x1  # bit0 = lms_reset отпущен, как после init
gw.fpga._t.fail_control_read = True
r = rpc({"op": "arm", "mode": "lb_gated", "det_thr": 5000})
check("CONTROL read fail → arm отказ", r.get("ok") is False)
check("CONTROL не затёрт в 0 при сбое чтения", gw.fpga._t.control == 0x1)
gw.fpga._t.fail_control_read = False

# Откат эфира при сбое записи CTRL (x40): CONTROL bit2 взвели под nco,
# CTRL не записался — бит обязан быть снят (TX не остаётся под током).
gw.fpga._t.control = 0x1
gw.fpga._t.fail_ctrl_write = True
r = rpc({"op": "arm", "mode": "nco", "nco_ftw": 0x20000000})
check("x40: сбой CTRL → ARM отказ", r.get("ok") is False)
check("x40: CONTROL bit2 откачен (TX не под током)", not (gw.fpga._t.control & 0x4))
gw.fpga._t.fail_ctrl_write = False

# Re-arm при ЖИВОМ ARM: сбой CTRL не откатывает эфир предыдущего ARM.
r = rpc({"op": "arm", "mode": "nco", "nco_ftw": 0x20000000})
check("x40: arm nco ok (для re-arm теста)", r.get("ok") is True and bool(gw.fpga._t.control & 0x4))
gw.fpga._t.fail_ctrl_write = True
r = rpc({"op": "arm", "mode": "player"})
check("x40: re-arm при живом ARM — сбой CTRL → отказ", r.get("ok") is False)
check("x40: эфир предыдущего ARM жив (bit2 не откачен)", bool(gw.fpga._t.control & 0x4))
gw.fpga._t.fail_ctrl_write = False
rpc({"op": "disarm"})

r = rpc({"op": "tune", "freq_mhz": 2475.0})
check("x40: tune → отказ (нет AIR, hop только Soapy)", r.get("ok") is False)

srv.shutdown()
srv.server_close()

# ---------------------------------------------------------------------------
# 4.5. Шлюз на micro (bladerf2/AD9361): эфир через AIR-регистры, не CONTROL
# ---------------------------------------------------------------------------
gw_m = lg.LegionGateway(fake=True)
gw_m.fpga = lf.LegionFpga(lg.FakeTransport(board="bladerf2"))
gw_m.board = "bladerf2"
srv_m = lg._Server(("127.0.0.1", 0), lg._Handler)
srv_m.gw = gw_m
_th.Thread(target=srv_m.serve_forever, daemon=True).start()
port_m = srv_m.server_address[1]


def rpcm(msg: dict) -> dict:
    with _socket.create_connection(("127.0.0.1", port_m), timeout=3) as s:
        s.sendall((json_dumps(msg) + "\n").encode())
        return json_loads(s.makefile("rb").readline().decode())


r = rpcm({"op": "arm", "mode": "lb_gated", "det_thr": 5000, "det_shift": 4})
check("micro: ARM lb_gated без freq_mhz → отказ (LO обязателен)", r.get("ok") is False)
r = rpcm({"op": "arm", "mode": "lb_gated", "det_thr": 5000, "det_shift": 4, "freq_mhz": 2442.5, "gain_db": 42})
check("micro: ARM lb_gated с freq_mhz → ok", r.get("ok") is True)
check("micro: AIR_FREQ_KHZ = 2442500", gw_m.fpga._t.regs.get(lf.REG_AIR_FREQ_KHZ) == 2442500)
check("micro: AIR_GAIN_DB = 1042 (код = gain + 1000, сентинел не сталкивается)",
      gw_m.fpga._t.regs.get(lf.REG_AIR_GAIN_DB) == 1042)
check("micro: AIR_PREP up+RX+TX (0x7)", gw_m.fpga._t.regs.get(lf.REG_AIR_PREP) == 0x7)
st_m = rpcm({"op": "status"})
check("micro: status несёт readback эфира (air_up)",
      st_m.get("ok") is True and st_m.get("air_up") is True and st_m.get("air_freq_set") is True)
check("micro: CONTROL не тронут (AD9361 не кормится LMS-битами)",
      gw_m.fpga._t.control == 0)
check("micro: CTRL ARM lb_gated записан",
      gw_m.fpga._t.regs.get(lf.REG_CTRL) == lf.CTRL_ARM | (lf.MODE_LB_GATED << 1) | lf.CTRL_WD_EN)
r = rpcm({"op": "rx", "on": True})
check("micro: op rx → честный отказ (нет CONTROL)", r.get("ok") is False)
r = rpcm({"op": "disarm"})
check("micro: disarm ok, CONTROL по-прежнему 0", r.get("ok") is True and gw_m.fpga._t.control == 0)
r = rpcm({"op": "arm", "mode": "nco", "freq_mhz": 2450.0})
check("micro: ARM nco с freq_mhz → ok", r.get("ok") is True)
check("micro: AIR_PREP для nco = up+TX (0x5)", gw_m.fpga._t.regs.get(lf.REG_AIR_PREP) == 0x5)
r = rpcm({"op": "arm", "mode": "nco"})
check("micro: ARM nco без freq_mhz → отказ", r.get("ok") is False)
rpcm({"op": "disarm"})  # снять nco ARM выше: дальше тестируем откат без живого ARM

# Откат эфира при сбое записи CTRL: эфир подняли, ARM не взвёлся, живого
# ARM нет — тракт под током не оставляем (micro: AIR_PREP down).
gw_m.fpga._t.fail_ctrl_write = True
r = rpcm({"op": "arm", "mode": "lb_gated", "det_thr": 5000, "det_shift": 4, "freq_mhz": 2442.5})
check("micro: сбой CTRL → ARM отказ", r.get("ok") is False)
check("micro: эфир откачен (AIR_PREP=0)", gw_m.fpga._t.regs.get(lf.REG_AIR_PREP) == 0)
check("micro: флаги эфира сняты", not gw_m._rx_by_us and not gw_m._tx_by_us)
gw_m.fpga._t.fail_ctrl_write = False

# Re-arm при ЖИВОМ ARM: сбой CTRL не откатывает эфир — он нужен предыдущему.
r = rpcm({"op": "arm", "mode": "lb_gated", "det_thr": 5000, "det_shift": 4, "freq_mhz": 2442.5})
check("micro: повторный ARM lb_gated ok", r.get("ok") is True)
gw_m.fpga._t.fail_ctrl_write = True
r = rpcm({"op": "arm", "mode": "lb_gated", "det_thr": 5000, "det_shift": 4, "freq_mhz": 2442.5})
check("micro: re-arm при живом ARM — сбой CTRL → отказ", r.get("ok") is False)
check("micro: эфир предыдущего ARM жив (AIR_PREP не откачен)",
      gw_m.fpga._t.regs.get(lf.REG_AIR_PREP) == 0x7)
gw_m.fpga._t.fail_ctrl_write = False
rpcm({"op": "disarm"})

# Solo: fs/BW окна до AIR_PREP. Без полей — регистры не пишутся (NIOS 2 МГц).
r = rpcm({"op": "arm", "mode": "player", "freq_mhz": 2450.0})
check("micro: ARM player без fs_hz → ok (дефолт NIOS 2 МГц)", r.get("ok") is True)
check("micro: без fs_hz AIR_FS не писали", lf.REG_AIR_FS_HZ not in gw_m.fpga._t.regs)
check("micro: без bw_mhz AIR_BW не писали", lf.REG_AIR_BW_HZ not in gw_m.fpga._t.regs)
rpcm({"op": "disarm"})

r = rpcm({"op": "arm", "mode": "lb_gated", "det_thr": 5000, "det_shift": 4, "freq_mhz": 2442.5})
check("micro: ARM lb_gated без fs → ok", r.get("ok") is True)
check("micro: эфир не пишет AIR_FS (2 МГц NIOS)", lf.REG_AIR_FS_HZ not in gw_m.fpga._t.regs)
check("micro: эфир не пишет AIR_BW", lf.REG_AIR_BW_HZ not in gw_m.fpga._t.regs)
rpcm({"op": "disarm"})

r = rpcm({"op": "arm", "mode": "player", "freq_mhz": 2425.0, "fs_hz": 20_000_000, "bw_mhz": 20})
check("micro: ARM player с fs_hz=20e6 → ok", r.get("ok") is True)
check("micro: AIR_FS_HZ = 20e6", gw_m.fpga._t.regs.get(lf.REG_AIR_FS_HZ) == 20_000_000)
check("micro: AIR_BW_HZ = 20e6 (из bw_mhz)", gw_m.fpga._t.regs.get(lf.REG_AIR_BW_HZ) == 20_000_000)
check("micro: AIR_FREQ_KHZ = 2425000", gw_m.fpga._t.regs.get(lf.REG_AIR_FREQ_KHZ) == 2_425_000)
ctrl_before_tune = gw_m.fpga._t.regs.get(lf.REG_CTRL)
r = rpcm({"op": "tune", "freq_mhz": 2475.0, "fs_hz": 20_000_000, "bw_mhz": 20})
check("micro: tune → ok", r.get("ok") is True)
check("micro: tune сменил AIR_FREQ на 2475000", gw_m.fpga._t.regs.get(lf.REG_AIR_FREQ_KHZ) == 2_475_000)
check("micro: tune не DISARM (CTRL тот же)", gw_m.fpga._t.regs.get(lf.REG_CTRL) == ctrl_before_tune)
check("micro: tune не отпускает USB", gw_m.fpga._t.released is False)
check("micro: после tune USB status жив", rpcm({"op": "status"}).get("ok") is True)
r = rpcm({"op": "tune"})
check("micro: tune без freq_mhz → отказ", r.get("ok") is False)
r = rpcm({"op": "set", "reg": "air_fs_hz", "value": 10_000_000})
check("set air_fs_hz", r.get("ok") is True and gw_m.fpga._t.regs.get(lf.REG_AIR_FS_HZ) == 10_000_000)
r = rpcm({"op": "set", "reg": "air_bw_hz", "value": 10_000_000})
check("set air_bw_hz", r.get("ok") is True and gw_m.fpga._t.regs.get(lf.REG_AIR_BW_HZ) == 10_000_000)
rpcm({"op": "disarm"})

r = rpcm({"op": "arm", "mode": "nco", "freq_mhz": 2442.5, "fs_hz": 20_000_000, "bw_mhz": 20})
check("micro: ARM nco с fs/bw → ok", r.get("ok") is True)
check("micro: nco AIR_FS_HZ = 20e6", gw_m.fpga._t.regs.get(lf.REG_AIR_FS_HZ) == 20_000_000)
rpcm({"op": "disarm"})

srv_m.shutdown()
srv_m.server_close()

# ---------------------------------------------------------------------------
# 5. Авторизация шлюза токеном (LEGION_FPGA_TOKEN)
# ---------------------------------------------------------------------------
os.environ["LEGION_FPGA_TOKEN"] = "sekret"
import importlib as _imp
_imp.reload(lg)  # подхватить AUTH_TOKEN заново
gw2 = lg.LegionGateway(fake=True)
srv2 = lg._Server(("127.0.0.1", 0), lg._Handler)
srv2.gw = gw2
_th.Thread(target=srv2.serve_forever, daemon=True).start()
port2 = srv2.server_address[1]


def rpc2(msg: dict) -> dict:
    with _socket.create_connection(("127.0.0.1", port2), timeout=3) as s:
        s.sendall((json_dumps(msg) + "\n").encode())
        return json_loads(s.makefile("rb").readline())


r = rpc2({"op": "ping"})
check("ping без токена — открыт (discovery)", r.get("ok") is True)
r = rpc2({"op": "status"})
check("status без токена — отказ", r.get("ok") is False and "token" in str(r.get("reason")))
r = rpc2({"op": "status", "token": "wrong"})
check("неверный токен — отказ", r.get("ok") is False)
r = rpc2({"op": "status", "token": "sekret"})
check("верный токен — работает", r.get("ok") is True)
r = rpc2({"op": "arm", "mode": "player", "token": "sekret"})
check("arm с токеном — работает", r.get("ok") is True)
srv2.shutdown()
srv2.server_close()
os.environ.pop("LEGION_FPGA_TOKEN")

print("LEGION FPGA HOST: ALL PASS" if fails == 0 else f"LEGION FPGA HOST: {fails} FAILURES")
sys.exit(0 if fails == 0 else 1)
