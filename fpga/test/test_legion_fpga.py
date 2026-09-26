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
    "LEGION_REG_SCAN_F1_KHZ": lf.REG_SCAN_F1_KHZ,
    "LEGION_REG_SCAN_F2_KHZ": lf.REG_SCAN_F2_KHZ,
    "LEGION_REG_SCAN_CTRL": lf.REG_SCAN_CTRL,
    "LEGION_REG_SCAN_DWELL_US": lf.REG_SCAN_DWELL_US,
    "LEGION_REG_SEARCH_BW_HZ": lf.REG_SEARCH_BW_HZ,
    "LEGION_REG_FIRE_BW_HZ": lf.REG_FIRE_BW_HZ,
    "LEGION_REG_PEAK_KHZ": lf.REG_PEAK_KHZ,
    "LEGION_REG_PEAK_BIN": lf.REG_PEAK_BIN,
    "LEGION_REG_FFT_CTRL": lf.REG_FFT_CTRL,
    "LEGION_REG_BAND_IDX": lf.REG_BAND_IDX,
    "LEGION_REG_BAND_F1_KHZ": lf.REG_BAND_F1_KHZ,
    "LEGION_REG_BAND_F2_KHZ": lf.REG_BAND_F2_KHZ,
    "LEGION_REG_BAND_COUNT": lf.REG_BAND_COUNT,
    "LEGION_REG_SETTLE_N": lf.REG_SETTLE_N,
    "LEGION_REG_SCAN_SURVEY_US": lf.REG_SCAN_SURVEY_US,
    "LEGION_REG_SCAN_EVENT": lf.REG_SCAN_EVENT,
    "LEGION_REG_AIR_TX_GAIN_DB": lf.REG_AIR_TX_GAIN_DB,
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
    check("USB_IF_RF_LINK == bladeRF.h",
          lg2.USB_IF_RF_LINK == define_val(brf_src, "USB_IF_RF_LINK"))
    check("USB_IF_NULL == bladeRF.h",
          lg2.USB_IF_NULL == define_val(brf_src, "USB_IF_NULL"))

    class _AltDev:
        def __init__(self) -> None:
            self.alts: list[tuple[int, int]] = []
            self.kernel = False
            self.detached = False

        def is_kernel_driver_active(self, _intf: int) -> bool:
            return self.kernel

        def detach_kernel_driver(self, _intf: int) -> None:
            self.detached = True
            self.kernel = False

        def set_interface_altsetting(self, interface: int, alternate_setting: int) -> None:
            self.alts.append((interface, alternate_setting))

    class _UsbErr(Exception):
        def __init__(self, errno: int) -> None:
            self.errno = errno

    class _FakeUsb:
        class core:
            USBError = _UsbErr

        class util:
            claimed: list[int] = []

            @staticmethod
            def claim_interface(_dev: object, intf: int) -> None:
                _FakeUsb.util.claimed.append(intf)

    dev = _AltDev()
    dev.kernel = True
    tr = lg2.UsbTransport.__new__(lg2.UsbTransport)
    tr._usb = _FakeUsb
    tr._dev = dev
    tr._arm_nios_interface()
    check("NIOS: kernel driver снят", dev.detached and not dev.kernel)
    check("NIOS: интерфейс 0 занят", _FakeUsb.util.claimed == [0])
    check("NIOS: altsetting RF до bulk", dev.alts == [(0, lg2.USB_IF_RF_LINK)])
    busy = _AltDev()
    tr._dev = busy

    def _busy(_dev: object, _intf: int) -> None:
        raise _UsbErr(16)

    _FakeUsb.util.claim_interface = staticmethod(_busy)  # type: ignore[method-assign]
    try:
        tr._arm_nios_interface()
        check("NIOS: USB busy — понятный отказ", False, "исключения не было")
    except RuntimeError as e:
        check("NIOS: USB busy — понятный отказ", "USB занят" in str(e), str(e))
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
py_bits = {"playing": 0, "capture_done": 1, "det_active": 2}
# Python read_status: playing=bit0, capture_done=bit1, det_active=bit2,
# wd_fired = bit3 (HDL, живой expired) | bit4 (NIOS, липкий латч deadman —
# после автономного DISARM HDL-бит гаснет за мкс, enable=0 сбрасывает expired)
host_src = open(os.path.join(ROOT, "host", "legion_fpga.py"), encoding="utf-8").read()
for key, bit in py_bits.items():
    check(f"py read_status {key}=bit{bit}", f'"{key}": bool(data & (1 << {bit}))' in host_src)
check("py read_status wd_fired=bit3|bit4 (HDL|NIOS-латч)",
      '"wd_fired": bool(data & 0x18)' in host_src)

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
# Сторож kick_age (A2) не должен мешать основному suite: таймаут огромный,
# в dedicated-блоке ниже опускается до 1 с и возвращается обратно.
lg.KICK_TIMEOUT_S = 3600.0


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

# Длительная непрерывная работа: armed_s в status + warn по таймеру
# (температуры AD9361 в этой NIOS-сборке нет — честный заменитель,
# LEGION_ARM_WARN_S; см. шапку legion_gateway.py).
r = rpc({"op": "arm", "mode": "nco"})
check("arm для таймера длительной работы", r.get("ok") is True)
r = rpc({"op": "status"})
check("status несёт armed_s", isinstance(r.get("armed_s"), int) and r.get("armed_s") >= 0)
check("свежий ARM без warn", "warn" not in r)
lg.ARM_WARN_S = 0.05
import time as _time
_time.sleep(0.08)
r = rpc({"op": "status"})
check("после ARM_WARN_S status несёт warn про охлаждение",
      "warn" in r and "охлаждение" in r["warn"])
lg.ARM_WARN_S = 300.0
# armed_s растёт со временем ARM (целые секунды — ждём пересечение).
rpc({"op": "arm", "mode": "nco"})
_time.sleep(1.1)
r = rpc({"op": "status"})
check("armed_s растёт со временем ARM", isinstance(r.get("armed_s"), int) and r.get("armed_s") >= 1)
rpc({"op": "disarm"})
r = rpc({"op": "status"})
check("после DISARM armed_s=0 и warn снят", r.get("armed_s") == 0 and "warn" not in r)

# lb_gated без порога → честный отказ (порог 0 = гейт на шум)
r = rpc({"op": "arm", "mode": "lb_gated"})
check("lb_gated без det_thr → отказ", r.get("ok") is False)
# Явный 0 — та же дыра: раньше проходил (документация «0 шлюз отвергает»
# расходилась с кодом). floor по умолчанию 1 → 0 отвергается.
r = rpc({"op": "arm", "mode": "lb_gated", "det_thr": 0})
check("lb_gated с det_thr=0 → отказ (floor)", r.get("ok") is False)
check("det_thr=0 не взводит det_thr_set", gw.det_thr_set is False)
# Поднятый floor (LEGION_DET_THR_FLOOR на стенде): ниже него — отказ
lg.DET_THR_FLOOR = 100
r = rpc({"op": "arm", "mode": "lb_gated", "det_thr": 50})
check("lb_gated det_thr=50 < floor=100 → отказ", r.get("ok") is False)
lg.DET_THR_FLOOR = 1
# Тот же floor на низкоуровневом set: иначе «set det_thr 0» взводил бы
# det_thr_set и lb_gated без det_thr армировался с гейтом на шум (дыра
# найдена углублённой проверкой B1).
r = rpc({"op": "set", "reg": "det_thr", "value": 0})
check("set det_thr=0 → отказ (floor), det_thr_set не взведён",
      r.get("ok") is False and gw.det_thr_set is False)
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

# kick при мёртвом USB НЕ кормит сторожа шлюза: last_kick обновляется
# только за дошедший до FPGA kick — иначе при больном USB сторож молчал
# бы вечно (ни DISARM, ни release), хотя железо погасло своим WD.
kick_before = gw.last_kick
gw.fpga._t.released = True
r = rpc({"op": "kick"})
check("kick при мёртвом USB → ok:false с причиной",
      r.get("ok") is False and bool(r.get("reason")))
check("kick при мёртвом USB не тронул last_kick", gw.last_kick == kick_before)
gw.fpga._t.released = False
r = rpc({"op": "kick"})
check("kick после восстановления USB снова кормит сторожа",
      r.get("ok") is True and gw.last_kick > kick_before)

# Второй путь отказа kick: NIOS ответил без SUCCESS (запись не подтверждена,
# без исключения) — тоже не кормит сторожа и несёт честную причину.
kick_before2 = gw.last_kick
gw.fpga._t.fail_kick = True
r = rpc({"op": "kick"})
check("kick без SUCCESS → ok:false, причина про WD_KICK",
      r.get("ok") is False and "WD_KICK" in str(r.get("reason")))
check("kick без SUCCESS не тронул last_kick", gw.last_kick == kick_before2)
gw.fpga._t.fail_kick = False
r = rpc({"op": "kick"})
check("kick после сбоя SUCCESS снова кормит сторожа",
      r.get("ok") is True and gw.last_kick > kick_before2)

# DISARM при сбое записи CTRL: ok:false и честная причина, не «DISARM».
gw.fpga._t.fail_ctrl_write = True
r = rpc({"op": "disarm"})
check("disarm при сбое CTRL → ok:false с причиной",
      r.get("ok") is False and "не удалась" in str(r.get("reason")))
gw.fpga._t.fail_ctrl_write = False
r = rpc({"op": "disarm"})
check("disarm после сбоя снова работает", r.get("ok") is True)

# ---------------------------------------------------------------------------
# Сторож kick_age (A2): ARM жив, kicks пропали → сам DISARM → USB release
# (именно в этом порядке). Таймаут 1 с только в этом блоке.
# ---------------------------------------------------------------------------
import time as _time  # noqa: E402

lg.KICK_TIMEOUT_S = 1.0
r = rpc({"op": "arm", "mode": "player"})
check("сторож: arm player", r.get("ok") is True)
rpc({"op": "kick"})
_time.sleep(2.2)  # > таймаута 1 с при тике 0.5 с
check("сторож: kicks пропали → DISARM сам", gw._armed is False)
check("сторож: USB отпущен после DISARM", gw.fpga._t.released is True)
r = rpc({"op": "usb", "action": "acquire"})
check("сторож: после release USB занимается обратно", r.get("ok") is True)

# ARM без единого kick (панель умерла до beginFpgaKick): опора — момент ARM
gw.last_kick = 0.0
r = rpc({"op": "arm", "mode": "player"})
check("сторож: arm без kicks", r.get("ok") is True)
_time.sleep(2.2)
check("сторож: ARM без единого kick → DISARM + release",
      gw._armed is False and gw.fpga._t.released is True)
rpc({"op": "usb", "action": "acquire"})

# Регресс (найден перепроверкой A2): last_kick переживает DISARM. Старый
# kick прошлой сессии не должен сжечь свежий ARM до его первого kick —
# опора max(last_kick, _armed_at), не «or».
r = rpc({"op": "arm", "mode": "player"})
rpc({"op": "kick"})
rpc({"op": "disarm"})
_time.sleep(1.3)  # last_kick устарел (> таймаута 1 с), ARM снят
r = rpc({"op": "arm", "mode": "player"})
check("сторож: re-ARM со старым last_kick", r.get("ok") is True)
_time.sleep(0.7)  # > тика 0.5 с, < таймаута от ARM: со старым «or» тут FAIL
check("сторож: устаревший kick не сжёг свежий ARM",
      gw._armed is True and gw.fpga._t.released is False)
_time.sleep(1.4)  # суммарно > таймаута без kicks — теперь обязан сработать
check("сторож: свежий ARM без kicks гаснет по таймауту",
      gw._armed is False and gw.fpga._t.released is True)
rpc({"op": "usb", "action": "acquire"})

# wd=false — оператор отказался от deadman: сторож молчит
r = rpc({"op": "arm", "mode": "player", "wd": False})
check("сторож: arm wd=false", r.get("ok") is True)
_time.sleep(2.2)
check("сторож: wd=false → нет само-DISARM (решение оператора)",
      gw._armed is True and gw.fpga._t.released is False)
rpc({"op": "disarm"})

# Нормальный путь: kicks идут каждые 0.4 с → сторож обязан молчать
# (ранее покрыт только на уровне FPGA, E5; теперь и на уровне шлюза)
r = rpc({"op": "arm", "mode": "player"})
check("сторож: arm для живых kicks", r.get("ok") is True)
for _ in range(4):
    rpc({"op": "kick"})
    _time.sleep(0.4)
check("сторож: живые kicks → ARM жив, USB не тронут",
      gw._armed is True and gw.fpga._t.released is False)
rpc({"op": "disarm"})
lg.KICK_TIMEOUT_S = 3600.0

# ---------------------------------------------------------------------------
# A4: тихий выход (SIGTERM/SIGINT/atexit → gateway_cleanup): DISARM если
# ARM + USB release; идемпотентно (atexit после сигнала повторяет).
# ---------------------------------------------------------------------------
r = rpc({"op": "arm", "mode": "player"})
check("a4: arm player", r.get("ok") is True)
lg.gateway_cleanup(gw)
check("a4: cleanup снял ARM", gw._armed is False)
check("a4: cleanup отпустил USB", gw.fpga._t.released is True)
lg.gateway_cleanup(gw)
check("a4: cleanup идемпотентен (повтор без ошибок)", gw.fpga._t.released is True)
r = rpc({"op": "usb", "action": "acquire"})
check("a4: после cleanup USB занимается", r.get("ok") is True)
# cleanup без ARM: просто release, без ошибок
lg.gateway_cleanup(gw)
check("a4: cleanup без ARM — release без DISARM", gw.fpga._t.released is True)
rpc({"op": "usb", "action": "acquire"})

# Повторный сигнал во время cleanup: threading.Lock нереентерабелен —
# acquire(timeout=2) отваливается без дедлока, DISARM честно пропущен,
# USB release всё равно выполняется.
r = rpc({"op": "arm", "mode": "player"})
check("a4: arm для cleanup под локом", r.get("ok") is True)
gw._op_lock.acquire()
_t0 = _time.monotonic()
lg.gateway_cleanup(gw)
_dt = _time.monotonic() - _t0
gw._op_lock.release()
check("a4: cleanup при занятом локе — без дедлока (~2 с), release прошёл",
      _dt < 3.0 and gw.fpga._t.released is True)
check("a4: DISARM при занятом локе честно пропущен", gw._armed is True)
rpc({"op": "usb", "action": "acquire"})
rpc({"op": "disarm"})

# ---------------------------------------------------------------------------
# Липкий латч deadman (NIOS, STATUS bit4): после автономного DISARM HDL-бит
# wd_fired (bit3) гаснет за мкс — без латча E5 и fpgaPollStatus никогда
# не увидели бы срабатывание (найдено перепроверкой A1, раунд 4).
# ---------------------------------------------------------------------------
gw.fpga._t.wd_latch = True
r = rpc({"op": "status"})
check("wd_latch (NIOS bit4) виден как wd_fired", r.get("wd_fired") is True)
r = rpc({"op": "arm", "mode": "player"})
check("ARM снимает латч deadman", r.get("ok") is True and gw.fpga._t.wd_latch is False)
r = rpc({"op": "status"})
check("после ARM wd_fired чист", r.get("wd_fired") is False)
rpc({"op": "disarm"})

# ---------------------------------------------------------------------------
# op flash (async): валидация имени/платы/пути/ARM, старт, flash_status.
# FAKE: без CLI и без железа — проверяется протокол, не прошивка.
# ---------------------------------------------------------------------------
r = rpc({"op": "flash_status"})
check("flash_status до старта — честный отказ", r.get("ok") is False)
r = rpc({"op": "flash", "path": "/tmp/hostedxA4.rbf", "action": "load"})
check("flash hosted-имя → отказ (не артефакт legion)", r.get("ok") is False and r.get("started") is not True)
r = rpc({"op": "flash", "path": "/tmp/bladeRF_fw_latest.img", "action": "load"})
check("flash FX3 → отказ", r.get("ok") is False)
r = rpc({"op": "flash", "path": "legionx40.rbf", "action": "load"})
check("flash относительный путь → отказ (cwd CLI)", r.get("ok") is False)
r = rpc({"op": "flash", "path": "/tmp/legionxA4.rbf", "action": "load"})
check("flash A4 на bladeRF 1 → отказ (нужен x40)", r.get("ok") is False)
r = rpc({"op": "flash", "path": "/tmp/legionx40.rbf", "action": "nope"})
check("flash неизвестный action → отказ", r.get("ok") is False)
r = rpc({"op": "arm", "mode": "player"})
check("flash: arm для проверки отказа при ARM", r.get("ok") is True)
r = rpc({"op": "flash", "path": "/tmp/legionx40.rbf", "action": "load"})
check("flash при ARM → отказ (CLI и агент не делят USB)", r.get("ok") is False)
rpc({"op": "disarm"})
r = rpc({"op": "flash", "path": "/tmp/legionx40.rbf", "action": "load"})
check("flash legionx40 (fake) → started", r.get("ok") is True and r.get("started") is True)
for _ in range(30):
    r = rpc({"op": "flash_status"})
    if not r.get("running"):
        break
    _time.sleep(0.1)
check("flash_status: done + ok", r.get("done") is True and r.get("ok") is True)
check("flash fake честно помечен (не железо)", "FAKE" in str(r.get("log")))
r = rpc({"op": "flash", "path": "/tmp/legion_x40.rbf", "action": "store"})
check("flash алиас legion_x40 (старые docs) → started", r.get("ok") is True and r.get("started") is True)
for _ in range(30):
    r = rpc({"op": "flash_status"})
    if not r.get("running"):
        break
    _time.sleep(0.1)
check("flash store (-L) тоже ok", r.get("done") is True and r.get("ok") is True and r.get("action") == "store")

# ---------------------------------------------------------------------------
# Детект ревизии legion: hosted NIOS не обслуживает 0x80 → ping legion=False,
# ARM честно отказывает (иначе команда ушла бы в пустоту).
# ---------------------------------------------------------------------------
check("fake: ping несёт legion=True", rpc({"op": "ping"}).get("legion") is True)


class _HostedTransport(lg.FakeTransport):
    """Стоковый NIOS: target 0x80 → invalid id, ответ без SUCCESS
    (default в perform_read/perform_write, pkt_8x32.c hosted-ревизии)."""

    def xfer(self, req, timeout_ms=None):
        if len(req) == lf.NIOS_PKT_LEN and req[1] == 0x80:
            return bytes(16)
        return super().xfer(req, timeout_ms)


gw_h = lg.LegionGateway(fake=True)
gw_h.fpga = lf.LegionFpga(_HostedTransport(board="bladerf1"))
gw_h._detect_legion()
check("hosted: 0x80 без SUCCESS → legion=False", gw_h._legion is False)
r = gw_h.handle({"op": "ping"})
check("hosted: ping legion=False", r.get("legion") is False)
r = gw_h.handle({"op": "arm", "mode": "player"})
check("hosted: ARM отказ с причиной про ревизию", r.get("ok") is False and "legion" in str(r.get("reason")))
gw_h.handle({"op": "usb", "action": "release"})
check("hosted: после release ревизия неизвестна (None, не False)", gw_h._legion is None)
r = gw_h.handle({"op": "usb", "action": "acquire"})
check("hosted: re-acquire снова детектит hosted", r.get("ok") is True and gw_h._legion is False)
st_h = gw_h.handle({"op": "status"})
check("hosted: status несёт legion=False", st_h.get("legion") is False)

# ---------------------------------------------------------------------------
# flash: результат CLI и возврат USB — разные исходы. CLI ok + re-acquire
# провал (Soapy держит USB) → ok=True + warn, не ложный «отказ»; CLI упал →
# ok=False. Стабы: транспорт с падающим acquire + подмена subprocess.run.
# ---------------------------------------------------------------------------
import types as _types_f  # noqa: E402


class _FlakyAcquireTransport(lg.FakeTransport):
    def acquire(self):
        raise RuntimeError("USB занят SoapySDRServer")


gw_f = lg.LegionGateway(fake=True)
gw_f.fake = False  # дальше — «реальный» путь _flash_run, но со стабами
gw_f.fpga = lf.LegionFpga(_FlakyAcquireTransport(board="bladerf1"))
gw_f.board = "bladerf1"
_orig_run = lg.subprocess.run
lg.subprocess.run = lambda *a, **k: _types_f.SimpleNamespace(returncode=0, stdout="Flashing done", stderr="")
gw_f._flash = {"running": True, "done": False, "ok": False, "log": "",
               "action": "load", "path": "/abs/legionx40.rbf", "warn": ""}
gw_f._flash_run("/abs/legionx40.rbf", "load")
lg.subprocess.run = _orig_run
check("flash: CLI ok + re-acquire провал → ok=True (запись состоялась)",
      gw_f._flash["ok"] is True)
check("flash: warn про re-acquire присутствует", "re-acquire" in gw_f._flash["warn"])
check("flash: _legion обнулён при release (не протухшее True из fake-init)",
      gw_f._legion is None)
r = gw_f.handle({"op": "flash_status"})
check("flash_status: reason несёт ВНИМАНИЕ про USB",
      r.get("ok") is True and "ВНИМАНИЕ" in str(r.get("reason")) and bool(r.get("warn")))

gw_f2 = lg.LegionGateway(fake=True)
gw_f2.fake = False
gw_f2.fpga = lf.LegionFpga(lg.FakeTransport(board="bladerf1"))  # acquire не падает
gw_f2.board = "bladerf1"
lg.subprocess.run = lambda *a, **k: _types_f.SimpleNamespace(returncode=1, stdout="", stderr="fpga not configured")
gw_f2._flash = {"running": True, "done": False, "ok": False, "log": "",
                "action": "load", "path": "/abs/legionx40.rbf", "warn": ""}
gw_f2._flash_run("/abs/legionx40.rbf", "load")
lg.subprocess.run = _orig_run
check("flash: CLI exit≠0 → ok=False, warn пуст (acquire прошёл)",
      gw_f2._flash["ok"] is False and not gw_f2._flash["warn"])
check("flash: после удачного acquire ревизия перечитана (fake-транспорт = legion)",
      gw_f2._legion is True)
r = gw_f2.handle({"op": "flash_status"})
check("flash_status: отказ CLI без ВНИМАНИЯ", r.get("ok") is False and "отказ" in str(r.get("reason")))

# Сбой старта потока: running откатывается, следующий flash доступен.
gw_t = lg.LegionGateway(fake=True)


class _BoomThread:
    def __init__(self, *a, **k):
        pass

    def start(self):
        raise RuntimeError("no threads")


_orig_thread = lg.threading.Thread
lg.threading.Thread = _BoomThread
r = gw_t.handle({"op": "flash", "path": "/abs/legionx40.rbf", "action": "load"})
lg.threading.Thread = _orig_thread
check("flash: поток не стартовал → честный отказ", r.get("ok") is False and "поток" in str(r.get("reason")))
check("flash: running не залип после сбоя потока", gw_t._flash["running"] is False)
r = gw_t.handle({"op": "flash", "path": "/abs/legionx40.rbf", "action": "load"})
check("flash после сбоя потока снова доступен", r.get("ok") is True and r.get("started") is True)
for _ in range(30):
    r = gw_t.handle({"op": "flash_status"})
    if not r.get("running"):
        break
    _time.sleep(0.1)
check("flash после сбоя потока доезжает (fake)", r.get("done") is True and r.get("ok") is True)

# ---------------------------------------------------------------------------
# flash + probe физического size FPGA (bladeRF-cli -p): xA4/xA9 и x40/x115
# по USB PID неразличимы — перед записью сверяем size из probe с size в
# имени образа. Мягкая деградация: probe не распознан → как раньше.
# ---------------------------------------------------------------------------


def _mk_flash_gw():
    g = lg.LegionGateway(fake=True)
    g.fake = False  # «реальный» путь _flash_run со стабами (как gw_f выше)
    g.fpga = lf.LegionFpga(lg.FakeTransport(board="bladerf2"))
    g.board = "bladerf2"
    g._flash = {"running": True, "done": False, "ok": False, "log": "",
                "action": "load", "path": "", "warn": ""}
    return g


_probe_calls: list = []


def _stub_run_probe(size_text):
    def _run(argv, *a, **k):
        _probe_calls.append(list(argv))
        if "-p" in argv:
            return _types_f.SimpleNamespace(
                returncode=0, stdout=f"  FPGA size:      {size_text}\n", stderr="")
        return _types_f.SimpleNamespace(returncode=0, stdout="Flashing done", stderr="")
    return _run


# A4-плата + образ A9 → отказ ДО записи (bladeRF-cli -l/-L не вызывался).
gw_p = _mk_flash_gw()
_probe_calls.clear()
lg.subprocess.run = _stub_run_probe("A4")
gw_p._flash_run("/abs/legionxA9.rbf", "load")
lg.subprocess.run = _orig_run
check("flash probe: A4 + образ A9 → отказ", gw_p._flash["ok"] is False)
check("flash probe: причина называет оба size",
      "xa4" in gw_p._flash["log"] and "xa9" in gw_p._flash["log"])
check("flash probe: до записи не дошло (-l/-L не вызывался)",
      not any(("-l" in c or "-L" in c) for c in _probe_calls))
# UI показывает st.reason ?? st.log (store.ts) — при отказе probe reason
# обязан нести само сообщение, а не обобщённый «bladeRF-cli отказ»
# (bladeRF-cli -l/-L не вызывался — обвинять его было бы ложным следом).
r = gw_p.handle({"op": "flash_status"})
check("flash probe: flash_status reason = сообщение отказа, не «bladeRF-cli отказ»",
      "отказано до записи" in str(r.get("reason")) and "bladeRF-cli отказ" not in str(r.get("reason")))

# A4-плата + образ A4 → запись идёт.
gw_p2 = _mk_flash_gw()
_probe_calls.clear()
lg.subprocess.run = _stub_run_probe("A4")
gw_p2._flash_run("/abs/legionxA4.rbf", "load")
lg.subprocess.run = _orig_run
check("flash probe: A4 + образ A4 → записано", gw_p2._flash["ok"] is True)
check("flash probe: -l вызван", any("-l" in c for c in _probe_calls))

# Probe не распознан → мягкий пропуск, поведение как раньше.
gw_p3 = _mk_flash_gw()
lg.subprocess.run = lambda *a, **k: _types_f.SimpleNamespace(
    returncode=0, stdout="unrecognized probe output", stderr="")
gw_p3._flash_run("/abs/legionxA4.rbf", "load")
lg.subprocess.run = _orig_run
check("flash probe: нераспознанный probe → мягкий пропуск", gw_p3._flash["ok"] is True)

# Парсер: «40 KLE» (bladeRF 1) и «A9» (micro) оба принимаются.
check("flash probe: карта size «40 KLE»/«A9»",
      lg._FPGA_SIZE_KEYS.get("40") == "x40" and lg._FPGA_SIZE_KEYS.get("A9") == "xa9")

# ---------------------------------------------------------------------------
# D1/D2: UsbTransport против стаба pyusb — QUERY_FPGA_STATUS на acquire
# (BLADE_USB_CMD 1, 0xC0 — как usb_is_fpga_configured в libbladeRF) и
# retry xfer с re-acquire при USBError (re-enumerate).
# ---------------------------------------------------------------------------
import types as _types  # noqa: E402


class _USBError(Exception):
    pass


class _FakeUsbDev:
    def __init__(self):
        self.configured = 1      # FPGA status: 1=загружена, 0=пустая
        self.write_fails = 0     # сколько первых write упадут USBError
        self.disposed = 0
        self.finds = 0           # сколько раз find() отдал это устройство

    def get_active_configuration(self):
        return 1

    def set_configuration(self):
        pass

    def is_kernel_driver_active(self, _intf):
        return False

    def set_interface_altsetting(self, interface, alternate_setting):
        self.alt = (interface, alternate_setting)

    def ctrl_transfer(self, bm, req, wv, wi, n, timeout=None):
        assert bm == 0xC0 and req == 1 and n == 4, (bm, req, n)
        return self.configured.to_bytes(4, "little", signed=True)

    def write(self, ep, data, timeout=None):
        if self.write_fails > 0:
            self.write_fails -= 1
            raise _USBError("re-enumerate")

    def read(self, ep, n, timeout=None):
        return bytes(16)


def _stub_usb(dev):
    fake_usb = _types.ModuleType("usb")
    fake_core = _types.ModuleType("usb.core")
    fake_util = _types.ModuleType("usb.util")
    fake_core.USBError = _USBError

    def _find(**kw):
        dev.finds += 1
        return dev

    fake_core.find = _find
    fake_util.dispose_resources = lambda d: setattr(dev, "disposed", dev.disposed + 1)
    fake_util.claim_interface = lambda d, i: None
    fake_usb.core = fake_core
    fake_usb.util = fake_util
    old = {k: sys.modules.get(k) for k in ("usb", "usb.core", "usb.util")}
    sys.modules["usb"] = fake_usb
    sys.modules["usb.core"] = fake_core
    sys.modules["usb.util"] = fake_util
    return old


def _restore_usb(old):
    for k, v in old.items():
        if v is None:
            sys.modules.pop(k, None)
        else:
            sys.modules[k] = v


_dev = _FakeUsbDev()
_old_usb = _stub_usb(_dev)
try:
    t_usb = lg.UsbTransport()
    check("d1: FPGA загружена → acquire ok (board bladerf1)",
          t_usb._dev is _dev and t_usb.board == "bladerf1")
    check("d1: NIOS altsetting RF до bulk", _dev.alt == (0, lg.USB_IF_RF_LINK))
    # D2: один USBError → re-acquire + повтор успешен
    _dev.write_fails = 1
    resp = t_usb.xfer(lf.pack_8x32(lf.LEGION_TARGET, False, 0, 0))
    check("d2: USBError → re-acquire и повтор успешен",
          len(resp) == 16 and _dev.finds >= 2)
    check("d2: старый handle dispose при re-acquire", _dev.disposed >= 1)
    # D2: постоянный сбой → честная ошибка после ОДНОГО ретрая
    _dev.write_fails = 100
    try:
        t_usb.xfer(lf.pack_8x32(lf.LEGION_TARGET, False, 0, 0))
        check("d2: постоянный USBError → отказ", False)
    except _USBError:
        check("d2: постоянный USBError → отказ", True)
finally:
    _restore_usb(_old_usb)

# D1: FPGA пустая (питание xA4 от USB — выдёргивание = образ потерян)
_dev2 = _FakeUsbDev()
_dev2.configured = 0
_old_usb2 = _stub_usb(_dev2)
try:
    os.environ.pop("LEGION_FPGA_RBF", None)
    try:
        lg.UsbTransport()
        check("d1: FPGA пустая → честный отказ", False)
    except RuntimeError as e:
        check("d1: FPGA пустая → честный отказ", "FPGA не загружена" in str(e))
    os.environ["LEGION_FPGA_RBF"] = "/nonexistent/legionxA4.rbf"
    try:
        lg.UsbTransport()
        check("d1: LEGION_FPGA_RBF не найден → отказ с причиной", False)
    except RuntimeError as e:
        check("d1: LEGION_FPGA_RBF не найден → отказ с причиной",
              "не найден" in str(e))
    os.environ.pop("LEGION_FPGA_RBF", None)
finally:
    _restore_usb(_old_usb2)

# D3: провалившийся _acquire не оставляет полуоткрытый handle (_dev=None) —
# иначе следующий acquire() считался бы no-op «успехом» по непустому _dev.
# И xfer без устройства — честная причина вместо AttributeError о NoneType.
_dev3 = _FakeUsbDev()
_old_usb3 = _stub_usb(_dev3)
try:
    t3 = lg.UsbTransport()  # плата найдена, FPGA загружена
    _dev3.configured = 0    # образ потерян (питание xA4 — от USB)
    os.environ.pop("LEGION_FPGA_RBF", None)
    try:
        t3._acquire()
        check("d3: _acquire с пустой FPGA → отказ", False)
    except RuntimeError:
        check("d3: _acquire с пустой FPGA → отказ", True)
    check("d3: провалившийся _acquire не держит handle (_dev None)", t3._dev is None)
    try:
        t3.xfer(lf.pack_8x32(lf.LEGION_TARGET, False, 0, 0))
        check("d3: xfer без устройства → честная причина", False)
    except RuntimeError as e:
        check("d3: xfer без устройства → честная причина", "USB не занят" in str(e))
    _dev3.configured = 1    # образ вернули — acquire снова работает
    t3.acquire()
    check("d3: после восстановления FPGA acquire занимает USB", t3._dev is _dev3)
finally:
    _restore_usb(_old_usb3)

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
r = rpc({"op": "arm", "mode": "nco", "nco_ftw": 0x20000000, "tx_gain_db": 60})
check("x40: tx_gain_db не пишет регистр micro",
      r.get("ok") is True and lf.REG_AIR_TX_GAIN_DB not in gw.fpga._t.regs)
rpc({"op": "disarm"})

r = rpc({"op": "tune", "freq_mhz": 2475.0})
check("x40: tune → отказ (нет AIR, hop только Soapy)", r.get("ok") is False)

r = rpc({"op": "ping"})
check("x40: ping несёт board=bladerf1 (авто-детект приёмки)",
      r.get("ok") is True and r.get("board") == "bladerf1")

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
check("micro: без tx_gain_db регистр TX не пишется",
      lf.REG_AIR_TX_GAIN_DB not in gw_m.fpga._t.regs)
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
r = rpcm({"op": "arm", "mode": "lb_gated", "det_thr": 5000, "det_shift": 4,
          "freq_mhz": 2442.5, "tx_gain_db": 30})
check("micro: ARM с tx_gain_db → ok", r.get("ok") is True)
check("micro: AIR_TX_GAIN_DB = 1030 (код = gain + 1000)",
      gw_m.fpga._t.regs.get(lf.REG_AIR_TX_GAIN_DB) == 1030)
r = rpcm({"op": "arm", "mode": "lb_gated", "det_thr": 5000, "det_shift": 4,
          "freq_mhz": 2442.5, "tx_gain_db": 60})
check("micro xA4: 60 дБ → код 1060", r.get("ok") is True
      and gw_m.fpga._t.regs.get(lf.REG_AIR_TX_GAIN_DB) == 1060)
rpcm({"op": "disarm"})
gw_m.fpga._t.reject_reg = lf.REG_AIR_TX_GAIN_DB
r = rpcm({"op": "arm", "mode": "lb_gated", "det_thr": 5000, "det_shift": 4,
          "freq_mhz": 2442.5, "tx_gain_db": 12})
check("micro: старый образ без регистра TX — ARM всё равно ok", r.get("ok") is True)
check("micro: отказ регистра не затирает прошлый код",
      gw_m.fpga._t.regs.get(lf.REG_AIR_TX_GAIN_DB) == 1060)
gw_m.fpga._t.reject_reg = None
rpcm({"op": "disarm"})
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

# Solo: fs/BW окна до AIR_PREP. Без полей — пишется ЯВНЫЙ дефолт (0 = NIOS
# 2 МГц, WD_LIMIT от 2e6 на micro = 122 ≈ 2 с при tx_clock=2×fs): статики/регистры переживают сессии.
r = rpcm({"op": "arm", "mode": "player", "freq_mhz": 2450.0})
check("micro: ARM player без fs_hz → ok (дефолт NIOS 2 МГц)", r.get("ok") is True)
check("micro: без fs_hz AIR_FS = дефолт 0 явно", gw_m.fpga._t.regs.get(lf.REG_AIR_FS_HZ) == 0)
check("micro: без fs_hz WD_LIMIT от 2e6 (=122 ≈ 2 с)",
      gw_m.fpga._t.regs.get(lf.REG_WD_LIMIT) == lf.watchdog_limit_for_fs(2_000_000, "bladerf2"))
check("micro: без bw_mhz AIR_BW = дефолт 0 явно", gw_m.fpga._t.regs.get(lf.REG_AIR_BW_HZ) == 0)
rpcm({"op": "disarm"})

r = rpcm({"op": "arm", "mode": "lb_gated", "det_thr": 5000, "det_shift": 4, "freq_mhz": 2442.5})
check("micro: ARM lb_gated без fs → ok", r.get("ok") is True)
check("micro: эфир без fs_hz пишет AIR_FS=0 (дефолт 2 МГц)", gw_m.fpga._t.regs.get(lf.REG_AIR_FS_HZ) == 0)
check("micro: эфир без bw_mhz пишет AIR_BW=0", gw_m.fpga._t.regs.get(lf.REG_AIR_BW_HZ) == 0)
rpcm({"op": "disarm"})

check("wd limit x40 2 МГц ≈ 2 с", lf.watchdog_limit_for_fs(2_000_000, "bladerf1") == 122)
check("wd limit micro 2 МГц ≈ 2 с (tx_clock=2×fs)", lf.watchdog_limit_for_fs(2_000_000, "bladerf2") == 122)
check("wd limit micro 10 МГц ≈ 2 с", lf.watchdog_limit_for_fs(10_000_000, "bladerf2") == 610)
check("wd limit micro 20 МГц ≈ 2 с", lf.watchdog_limit_for_fs(20_000_000, "bladerf2") == 1221)
check("wd limit micro 56 МГц ≈ 2 с", lf.watchdog_limit_for_fs(56_000_000, "bladerf2") == 3418)
# 610×65536/(2×10e6) ≈ 2.0 с > 0.5 с kick; дефолт прошивки 61×65536/(2×10e6) = 0.200 с.

r = rpcm({"op": "arm", "mode": "player", "freq_mhz": 2425.0, "fs_hz": 20_000_000, "bw_mhz": 20})
check("micro: ARM player с fs_hz=20e6 → ok", r.get("ok") is True)
check("micro: AIR_FS_HZ = 20e6", gw_m.fpga._t.regs.get(lf.REG_AIR_FS_HZ) == 20_000_000)
check("micro: ARM 20e6 пишет WD_LIMIT=1221", gw_m.fpga._t.regs.get(lf.REG_WD_LIMIT) == 1221)
check("micro: AIR_BW_HZ = 20e6 (из bw_mhz)", gw_m.fpga._t.regs.get(lf.REG_AIR_BW_HZ) == 20_000_000)
check("micro: AIR_FREQ_KHZ = 2425000", gw_m.fpga._t.regs.get(lf.REG_AIR_FREQ_KHZ) == 2_425_000)
ctrl_before_tune = gw_m.fpga._t.regs.get(lf.REG_CTRL)
r = rpcm({"op": "tune", "freq_mhz": 2475.0, "fs_hz": 20_000_000, "bw_mhz": 20})
check("micro: tune → ok", r.get("ok") is True)
check("micro: tune сменил AIR_FREQ на 2475000", gw_m.fpga._t.regs.get(lf.REG_AIR_FREQ_KHZ) == 2_475_000)
check("micro: tune не DISARM (CTRL тот же)", gw_m.fpga._t.regs.get(lf.REG_CTRL) == ctrl_before_tune)
check("micro: tune не отпускает USB", gw_m.fpga._t.released is False)
check("micro: после tune USB status жив", rpcm({"op": "status"}).get("ok") is True)
r = rpcm({"op": "tune", "freq_mhz": 2442.0, "fs_hz": 20_000_000, "bw_mhz": 20, "det_thr": 4800})
check("micro: tune с det_thr (air-обход) → ok", r.get("ok") is True)
check("micro: tune записал DET_THR=4800", gw_m.fpga._t.regs.get(lf.REG_DET_THR) == 4800)
check("micro: tune с det_thr не DISARM (CTRL тот же)", gw_m.fpga._t.regs.get(lf.REG_CTRL) == ctrl_before_tune)
r = rpcm({"op": "tune", "freq_mhz": 2442.0, "det_thr": 0})
check("micro: tune det_thr ниже floor → отказ (гейт на шум)", r.get("ok") is False)
r = rpcm({"op": "tune", "freq_mhz": 2475.0})
check("micro: tune без det_thr не трогает DET_THR", gw_m.fpga._t.regs.get(lf.REG_DET_THR) == 4800)
r = rpcm({"op": "tune"})
check("micro: tune без freq_mhz → отказ", r.get("ok") is False)
rpcm({"op": "disarm"})

# Регресс порядка сессий: статики fs/bw и WD_LIMIT переживают DISARM.
# ARM без fs_hz после 20-МГц сессии обязан получить дефолты явно — иначе
# волна, снятая на 2 MSPS, игралась бы на 20 MSPS, а deadman растянулся
# бы с ~2 с до ~20 с (1221×65536/(2×2e6)).
r = rpcm({"op": "arm", "mode": "player", "freq_mhz": 2450.0})
check("micro: ARM без fs после 20-МГц сессии → ok", r.get("ok") is True)
check("micro: AIR_FS_HZ сброшен в дефолт после 20-МГц сессии",
      gw_m.fpga._t.regs.get(lf.REG_AIR_FS_HZ) == 0)
check("micro: AIR_BW_HZ сброшен в дефолт после 20-МГц сессии",
      gw_m.fpga._t.regs.get(lf.REG_AIR_BW_HZ) == 0)
check("micro: WD_LIMIT сброшен от 2e6 (122 ≈ 2 с), не 1221 прошлой сессии",
      gw_m.fpga._t.regs.get(lf.REG_WD_LIMIT) == lf.watchdog_limit_for_fs(2_000_000, "bladerf2"))
rpcm({"op": "disarm"})
r = rpcm({"op": "tune", "freq_mhz": 2475.0})
check("micro: tune после DISARM → отказ (не поднимаем TX)", r.get("ok") is False and "ARM" in (r.get("reason") or ""))

# tune при латче deadman: автономный DISARM в NIOS (wd_fired) до шлюза не
# дошёл — _armed ещё True, но STATUS авторитетнее: отказ ДО записей,
# иначе AIR_PREP поднял бы TX поверх погашенного deadman'ом тракта.
r = rpcm({"op": "arm", "mode": "nco", "freq_mhz": 2440.0})
check("micro: ARM nco для wd-tune теста → ok", r.get("ok") is True)
freq_before = gw_m.fpga._t.regs.get(lf.REG_AIR_FREQ_KHZ)
thr_before = gw_m.fpga._t.regs.get(lf.REG_DET_THR)
air_before = gw_m.fpga._t.regs.get(lf.REG_AIR_PREP)
gw_m.fpga._t.wd_latch = True  # как NIOS после deadman (bit4 в STATUS)
r = rpcm({"op": "tune", "freq_mhz": 2475.0, "det_thr": 4800})
check("micro: tune при wd-латче → отказ (deadman)",
      r.get("ok") is False and "deadman" in str(r.get("reason")))
check("micro: отказной tune не тронул AIR_FREQ", gw_m.fpga._t.regs.get(lf.REG_AIR_FREQ_KHZ) == freq_before)
check("micro: отказной tune не тронул DET_THR", gw_m.fpga._t.regs.get(lf.REG_DET_THR) == thr_before)
check("micro: отказной tune не тронул AIR_PREP", gw_m.fpga._t.regs.get(lf.REG_AIR_PREP) == air_before)
rpcm({"op": "disarm"})
r = rpcm({"op": "arm", "mode": "nco", "freq_mhz": 2440.0})
check("micro: re-ARM после deadman-отказа → ok", r.get("ok") is True)
check("micro: re-ARM снял wd-латч (как NIOS)", gw_m.fpga._t.wd_latch is False)
r = rpcm({"op": "tune", "freq_mhz": 2475.0})
check("micro: tune после re-ARM снова работает", r.get("ok") is True)
rpcm({"op": "disarm"})

# tune при мёртвом USB: STATUS не прочитать → fail-closed отказ, эфир не
# тронут (исключение из xfer ловит _Handler и отвечает ok:false).
r = rpcm({"op": "arm", "mode": "nco", "freq_mhz": 2440.0})
check("micro: ARM nco для fail-closed теста → ok", r.get("ok") is True)
air_before_fc = gw_m.fpga._t.regs.get(lf.REG_AIR_PREP)
gw_m.fpga._t.released = True  # USB отпущен — любой xfer падает
r = rpcm({"op": "tune", "freq_mhz": 2475.0})
check("micro: tune при мёртвом USB → отказ (fail-closed)", r.get("ok") is False)
gw_m.fpga._t.released = False
check("micro: fail-closed tune не тронул AIR_PREP",
      gw_m.fpga._t.regs.get(lf.REG_AIR_PREP) == air_before_fc)
rpcm({"op": "disarm"})

r = rpcm({"op": "set", "reg": "air_fs_hz", "value": 10_000_000})
check("set air_fs_hz", r.get("ok") is True and gw_m.fpga._t.regs.get(lf.REG_AIR_FS_HZ) == 10_000_000)
r = rpcm({"op": "set", "reg": "air_bw_hz", "value": 10_000_000})
check("set air_bw_hz", r.get("ok") is True and gw_m.fpga._t.regs.get(lf.REG_AIR_BW_HZ) == 10_000_000)
rpcm({"op": "disarm"})

r = rpcm({"op": "arm", "mode": "nco", "freq_mhz": 2442.5, "fs_hz": 20_000_000, "bw_mhz": 20})
check("micro: ARM nco с fs/bw → ok", r.get("ok") is True)
check("micro: nco AIR_FS_HZ = 20e6", gw_m.fpga._t.regs.get(lf.REG_AIR_FS_HZ) == 20_000_000)
rpcm({"op": "disarm"})

# ---------------------------------------------------------------------------
# air-hop обход как серия tune (сторона шлюза): ARM lb_gated на первой
# стоянке → N шагов подряд, каждый несёт LO + det_thr своей полки (таблица
# порогов из калибровочного прохода). Между шагами CTRL не трогается, USB
# не отпускается; финальный DISARM чистый.
# ---------------------------------------------------------------------------
r = rpcm({"op": "arm", "mode": "lb_gated", "freq_mhz": 2412.0,
          "fs_hz": 2_000_000, "bw_mhz": 2, "det_thr": 3000})
check("air-hop: ARM lb_gated первой стоянки → ok", r.get("ok") is True)
ctrl_walk = gw_m.fpga._t.regs.get(lf.REG_CTRL)
for i, (f, thr) in enumerate([(2412.0, 3000), (2437.0, 5200), (2462.0, 4100), (2437.0, 5200)]):
    r = rpcm({"op": "tune", "freq_mhz": f, "fs_hz": 2_000_000, "bw_mhz": 2, "det_thr": thr})
    check(f"air-hop: шаг {i} tune {f} МГц → ok", r.get("ok") is True)
    check(f"air-hop: шаг {i} AIR_FREQ стоянки",
          gw_m.fpga._t.regs.get(lf.REG_AIR_FREQ_KHZ) == int(f * 1000))
    check(f"air-hop: шаг {i} DET_THR своей полки",
          gw_m.fpga._t.regs.get(lf.REG_DET_THR) == thr)
check("air-hop: CTRL не тронут за весь обход", gw_m.fpga._t.regs.get(lf.REG_CTRL) == ctrl_walk)
check("air-hop: USB не отпускался между шагами", gw_m.fpga._t.released is False)
r = rpcm({"op": "disarm"})
check("air-hop: DISARM после обхода → ok", r.get("ok") is True)

# op flash на micro: семейство A-серии, x40 отвергается (PID общий 0x5250,
# A4/A9 по USB не различить — size на операторе, как в docs Nuand).
r = rpcm({"op": "flash", "path": "/tmp/legionx40.rbf", "action": "load"})
check("micro: flash x40 → отказ (нужен A4/A9)", r.get("ok") is False)
r = rpcm({"op": "flash", "path": "/tmp/legionxA4.rbf", "action": "load"})
check("micro: flash legionxA4 (fake) → started", r.get("ok") is True and r.get("started") is True)
for _ in range(30):
    r = rpcm({"op": "flash_status"})
    if not r.get("running"):
        break
    _time.sleep(0.1)
check("micro: flash_status done ok", r.get("done") is True and r.get("ok") is True)

# Defense-in-depth: _lms_enable на micro — no-op True, CONTROL не трогаем
# (там питание/клоки по bladerf2_common.h, не LMS-биты; аналог = AIR_PREP).
check("micro: _lms_enable no-op True, CONTROL не тронут",
      gw_m._lms_enable(rx=True, tx=True) is True and gw_m.fpga._t.control == 0)

# Онбордовый обзор: ARM пишет SCAN_*, status читает freq_mhz из AIR_FREQ
r = rpcm({"op": "arm", "mode": "lb_gated", "det_thr": 5000, "det_shift": 4,
          "freq_mhz": 2414.0, "fs_hz": 28_000_000, "bw_mhz": 28,
          "scan_enable": True, "scan_f1_mhz": 2400, "scan_f2_mhz": 2500,
          "scan_turn": True, "scan_dwell_us": 400})
check("micro: ARM scan_enable ok", r.get("ok") is True)
check("micro: SCAN_F1 = 2400000 кГц", gw_m.fpga._t.regs.get(lf.REG_SCAN_F1_KHZ) == 2_400_000)
check("micro: SCAN_F2 = 2500000 кГц", gw_m.fpga._t.regs.get(lf.REG_SCAN_F2_KHZ) == 2_500_000)
check("micro: SCAN_CTRL enable|turn",
      gw_m.fpga._t.regs.get(lf.REG_SCAN_CTRL) == (lf.SCAN_CTRL_EN | lf.SCAN_CTRL_TURN))
check("micro: SCAN_DWELL 0.4 мс = 400 мкс", gw_m.fpga._t.regs.get(lf.REG_SCAN_DWELL_US) == 400)
check("micro: ARM без fft_enable гасит leftover FFT",
      gw_m.fpga._t.regs.get(lf.REG_FFT_CTRL, 1) == 0)
st = rpcm({"op": "status"})
check("micro: status freq_mhz = 2414 (AIR_FREQ readback)",
      st.get("ok") is True and abs(float(st.get("freq_mhz") or 0) - 2414.0) < 0.01)
rpcm({"op": "disarm"})
r = rpcm({"op": "arm", "mode": "lb_gated", "det_thr": 5000, "det_shift": 4,
          "freq_mhz": 2500.0, "fs_hz": 56_000_000, "bw_mhz": 56,
          "scan_enable": True, "scan_f1_mhz": 2400, "scan_f2_mhz": 2600,
          "scan_turn": False, "scan_dwell_us": 400,
          "fft_enable": True, "fire_bw_mhz": 2,
          "scan_bands": [{"f1_mhz": 2400, "f2_mhz": 2600}]})
check("micro: ARM fft_enable ok", r.get("ok") is True)
check("micro: FFT_CTRL enable|notch",
      gw_m.fpga._t.regs.get(lf.REG_FFT_CTRL) == (lf.FFT_CTRL_EN | lf.FFT_CTRL_DC_NOTCH))
check("micro: SEARCH_BW = взгляд 56e6",
      gw_m.fpga._t.regs.get(lf.REG_SEARCH_BW_HZ) == 56_000_000)
check("micro: FIRE_BW = 2e6",
      gw_m.fpga._t.regs.get(lf.REG_FIRE_BW_HZ) == 2_000_000)
check("micro: SETTLE_N = 6 мс @ 56e6",
      gw_m.fpga._t.regs.get(lf.REG_SETTLE_N) == lf.settle_n_for_fs(56_000_000))
check("micro: BAND_COUNT 1", gw_m.fpga._t.regs.get(lf.REG_BAND_COUNT) == 1)
check("settle_n_for_fs 56e6 = 336000", lf.settle_n_for_fs(56_000_000) == 336000)
rpcm({"op": "disarm"})
r = rpcm({"op": "arm", "mode": "lb_gated", "det_thr": 5000, "det_shift": 4,
          "freq_mhz": 2428.0, "fs_hz": 56_000_000, "bw_mhz": 56,
          "scan_enable": True, "scan_f1_mhz": 2400, "scan_f2_mhz": 2500,
          "scan_turn": True, "scan_dwell_us": 400,
          "fft_enable": True, "fire_bw_mhz": 2})
check("micro: ARM FFT+TURN 2400-2500 ok", r.get("ok") is True)
check("micro: FFT+TURN SCAN_CTRL enable|turn",
      gw_m.fpga._t.regs.get(lf.REG_SCAN_CTRL) == (lf.SCAN_CTRL_EN | lf.SCAN_CTRL_TURN))
check("micro: FFT+TURN SCAN_DWELL 400 мкс",
      gw_m.fpga._t.regs.get(lf.REG_SCAN_DWELL_US) == 400)
check("micro: FFT+TURN FFT_CTRL enable|notch",
      gw_m.fpga._t.regs.get(lf.REG_FFT_CTRL) == (lf.FFT_CTRL_EN | lf.FFT_CTRL_DC_NOTCH))
check("micro: FFT+TURN SEARCH_BW 56e6",
      gw_m.fpga._t.regs.get(lf.REG_SEARCH_BW_HZ) == 56_000_000)
rpcm({"op": "disarm"})
r = rpcm({"op": "arm", "mode": "lb_gated", "det_thr": 5000, "det_shift": 4,
          "freq_mhz": 2443.5, "fs_hz": 56_000_000, "bw_mhz": 56,
          "scan_enable": True, "scan_f1_mhz": 2400, "scan_f2_mhz": 2487,
          "scan_park": True, "scan_dwell_us": 400,
          "fft_enable": True, "fire_bw_mhz": 2})
check("micro: ARM FFT+PARK 2400-2487 ok", r.get("ok") is True)
check("micro: FFT+PARK SCAN_CTRL enable|park",
      gw_m.fpga._t.regs.get(lf.REG_SCAN_CTRL) == (lf.SCAN_CTRL_EN | lf.SCAN_CTRL_PARK))
check("micro: FFT+PARK SCAN_F2 = 2487e3",
      gw_m.fpga._t.regs.get(lf.REG_SCAN_F2_KHZ) == 2_487_000)
rpcm({"op": "disarm"})
r = rpcm({"op": "arm", "mode": "lb_gated", "det_thr": 5000, "det_shift": 4,
          "freq_mhz": 2028.0, "fs_hz": 56_000_000, "bw_mhz": 56,
          "scan_enable": True, "scan_f1_mhz": 2000, "scan_f2_mhz": 3000,
          "scan_survey": True, "scan_dwell_us": 3_000_000,
          "fft_enable": True, "fire_bw_mhz": 2})
check("micro: ARM FFT+SURVEY 2000-3000 ok", r.get("ok") is True)
check("micro: FFT+SURVEY SCAN_CTRL enable|survey",
      gw_m.fpga._t.regs.get(lf.REG_SCAN_CTRL) == (lf.SCAN_CTRL_EN | lf.SCAN_CTRL_SURVEY))
check("micro: FFT+SURVEY без park не ставит PARK",
      (gw_m.fpga._t.regs.get(lf.REG_SCAN_CTRL) & lf.SCAN_CTRL_PARK) == 0)
rpcm({"op": "disarm"})
r = rpcm({"op": "arm", "mode": "lb_gated", "det_thr": 5000, "det_shift": 4,
          "freq_mhz": 2028.0, "fs_hz": 56_000_000, "bw_mhz": 56,
          "scan_enable": True, "scan_f1_mhz": 2000, "scan_f2_mhz": 3000,
          "scan_park": True, "scan_survey": True, "scan_turn": True,
          "scan_dwell_us": 400, "scan_survey_us": 5_000_000,
          "fft_enable": True, "fire_bw_mhz": 2})
check("micro: ARM ИИ park+survey+turn ok", r.get("ok") is True)
check("micro: ИИ SCAN_CTRL en|turn|park|survey",
      gw_m.fpga._t.regs.get(lf.REG_SCAN_CTRL) == (
          lf.SCAN_CTRL_EN | lf.SCAN_CTRL_TURN | lf.SCAN_CTRL_PARK | lf.SCAN_CTRL_SURVEY))
check("micro: ИИ SCAN_SURVEY_US 5e6",
      gw_m.fpga._t.regs.get(lf.REG_SCAN_SURVEY_US) == 5_000_000)
rpcm({"op": "disarm"})
r = rpcm({"op": "arm", "mode": "lb_gated", "det_thr": 5000, "det_shift": 4,
          "freq_mhz": 5400.0, "fs_hz": 56_000_000, "bw_mhz": 56,
          "scan_enable": True, "scan_f1_mhz": 5000, "scan_f2_mhz": 5800,
          "fft_enable": True, "fire_bw_mhz": 2,
          "scan_bands": [{"f1_mhz": 5000, "f2_mhz": 5800}]})
check("micro: ARM коридор 5000-5800 (выше ADF 4400)", r.get("ok") is True)
check("micro: SCAN_F1 = 5e6 кГц", gw_m.fpga._t.regs.get(lf.REG_SCAN_F1_KHZ) == 5_000_000)
check("micro: SCAN_F2 = 5.8e6 кГц", gw_m.fpga._t.regs.get(lf.REG_SCAN_F2_KHZ) == 5_800_000)
rpcm({"op": "disarm"})
r = rpcm({"op": "arm", "mode": "lb_gated", "det_thr": 5000, "det_shift": 4,
          "freq_mhz": 98.0, "fs_hz": 56_000_000, "bw_mhz": 56,
          "scan_enable": True, "scan_f1_mhz": 70, "scan_f2_mhz": 6000,
          "fft_enable": True, "fire_bw_mhz": 2})
check("micro: ARM 70-6000", r.get("ok") is True)
check("micro: SCAN_F1 = 70e3 кГц", gw_m.fpga._t.regs.get(lf.REG_SCAN_F1_KHZ) == 70_000)
check("micro: SCAN_F2 = 6e6 кГц", gw_m.fpga._t.regs.get(lf.REG_SCAN_F2_KHZ) == 6_000_000)
rpcm({"op": "disarm"})
r = rpcm({"op": "arm", "mode": "lb_gated", "det_thr": 5000, "det_shift": 4,
          "freq_mhz": 2414.0, "scan_enable": True, "scan_f1_mhz": 2400, "scan_f2_mhz": 2500,
          "scan_turn": True, "scan_dwell_ms": 1.5})
check("micro: scan_dwell_ms 1.5 → 1500 мкс (совместимость)",
      r.get("ok") is True and gw_m.fpga._t.regs.get(lf.REG_SCAN_DWELL_US) == 1500)
r = rpcm({"op": "arm", "mode": "nco", "freq_mhz": 2440.0})
check("micro: ARM без scan_enable пишет SCAN_CTRL=0",
      r.get("ok") is True and gw_m.fpga._t.regs.get(lf.REG_SCAN_CTRL) == 0)
rpcm({"op": "disarm"})
r = rpcm({"op": "arm", "mode": "lb_gated", "det_thr": 5000,
          "freq_mhz": 2414.0, "scan_enable": True})
check("micro: scan_enable без коридора → отказ", r.get("ok") is False)
ok_air, air = gw_m.fpga.read_reg(lf.REG_AIR_PREP)
check("U1: отказ SCAN до эфира — AIR_PREP down",
      ok_air and (air & 0x1) == 0)
check("U1: флаги владения эфиром сняты",
      gw_m._rx_by_us is False and gw_m._tx_by_us is False)

r = rpcm({"op": "arm", "mode": "lb_gated", "det_thr": 5000, "det_shift": 4,
          "freq_mhz": 2450.0, "fs_hz": 10_000_000, "bw_mhz": 10,
          "scan_enable": True, "scan_f1_mhz": 2445, "scan_f2_mhz": 2455,
          "scan_turn": True, "scan_dwell_us": 400})
check("micro: ARM взгляд 10 / 2450 ok", r.get("ok") is True)
ok_s, f1 = gw_m.fpga.read_reg(lf.REG_SCAN_F1_KHZ)
ok_s2, f2 = gw_m.fpga.read_reg(lf.REG_SCAN_F2_KHZ)
ok_sd, dwell = gw_m.fpga.read_reg(lf.REG_SCAN_DWELL_US)
ok_sc, sctrl = gw_m.fpga.read_reg(lf.REG_SCAN_CTRL)
check("U5: read SCAN_F1 по проводу, не STATUS",
      ok_s and f1 == 2_445_000)
check("U5: read SCAN_F2 по проводу", ok_s2 and f2 == 2_455_000)
check("U5: read SCAN_DWELL 400", ok_sd and dwell == 400)
check("U5: read SCAN_CTRL не STATUS",
      ok_sc and sctrl == (lf.SCAN_CTRL_EN | lf.SCAN_CTRL_TURN))
check("T1: 10e6 micro WD_LIMIT=610",
      gw_m.fpga._t.regs.get(lf.REG_WD_LIMIT) == lf.watchdog_limit_for_fs(10_000_000, "bladerf2"))
rpcm({"op": "disarm"})

r = rpcm({"op": "arm", "mode": "lb_gated", "det_thr": 5000,
          "freq_mhz": 2450.0, "fs_hz": 520834, "bw_mhz": 0.2})
check("T1: ARM 520834 micro WD_LIMIT=32",
      r.get("ok") is True and
      gw_m.fpga._t.regs.get(lf.REG_WD_LIMIT) == 32)
rpcm({"op": "disarm"})
r = rpcm({"op": "arm", "mode": "nco", "freq_mhz": 2440.0})
check("T1: ARM без fs_hz — WD от дефолта 2e6 (122 ≈ 2 с)",
      r.get("ok") is True and
      gw_m.fpga._t.regs.get(lf.REG_WD_LIMIT) == lf.watchdog_limit_for_fs(2_000_000, "bladerf2"))
rpcm({"op": "disarm"})

r = rpcm({"op": "set", "reg": "scan_dwell_ms", "value": 0.4})
check("U6: set scan_dwell_ms 0.4 → регистр 400",
      r.get("ok") is True and gw_m.fpga._t.regs.get(lf.REG_SCAN_DWELL_US) == 400)
ok_rd, dwell_rd = gw_m.fpga.read_reg(lf.REG_SCAN_DWELL_US)
check("U6: readback dwell 400", ok_rd and dwell_rd == 400)
r = rpcm({"op": "set", "reg": "scan_dwell_ms", "value": "0,4"})
check("U6: set 0,4 — отказ", r.get("ok") is False)
r = rpcm({"op": "set", "reg": "scan_dwell_ms", "value": "нет"})
check("U6: set нечисло — отказ", r.get("ok") is False)

r = rpcm({"op": "ping"})
check("micro: ping несёт board=bladerf2 (авто-детект приёмки)",
      r.get("ok") is True and r.get("board") == "bladerf2")

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

# ---------------------------------------------------------------------------
# 6. Таймаут клиентского сокета (LEGION_FPGA_CLIENT_TIMEOUT_S): зависший
#    peer не держит поток handler'а вечно (аудит P2).
# ---------------------------------------------------------------------------
import time as _time  # noqa: E402

lg.CLIENT_TIMEOUT_S = 0.3
gw3 = lg.LegionGateway(fake=True)
srv3 = lg._Server(("127.0.0.1", 0), lg._Handler)
srv3.gw = gw3
_th.Thread(target=srv3.serve_forever, daemon=True).start()
port3 = srv3.server_address[1]

# Молчащее соединение: сервер обязан закрыть его сам по таймауту.
s3 = _socket.create_connection(("127.0.0.1", port3), timeout=3)
s3.settimeout(3)
t0 = _time.monotonic()
closed = False
try:
    while _time.monotonic() - t0 < 3:
        if s3.recv(16) == b"":
            closed = True
            break
except _socket.timeout:
    pass
s3.close()
check("молчаливый клиент отброшен по CLIENT_TIMEOUT_S", closed)


def rpc3(msg: dict) -> dict:
    with _socket.create_connection(("127.0.0.1", port3), timeout=3) as s:
        s.sendall((json_dumps(msg) + "\n").encode())
        return json_loads(s.makefile("rb").readline())


r = rpc3({"op": "ping"})
check("при CLIENT_TIMEOUT_S=0.3 живой ping работает", r.get("ok") is True)
srv3.shutdown()
srv3.server_close()
lg.CLIENT_TIMEOUT_S = 300.0

# ---------------------------------------------------------------------------
# 7. Один экземпляр агента (flock): второй захват на том же пути отказывает.
#    Два открытых fd на один файл = два open-file-description → конфликт
#    воспроизводится внутри одного процесса, второй агент не нужен.
# ---------------------------------------------------------------------------
os.environ["LEGION_FPGA_LOCK"] = f"/tmp/legion-test-lock-{os.getpid()}"
h1 = lg.acquire_instance_lock()
check("instance lock: первый захват получен", h1 is not None)
h2 = lg.acquire_instance_lock()
check("instance lock: второй экземпляр отказан", h2 is None)
if h1 is not None and h1 is not True:
    h1.close()  # смерть процесса сняла бы лок; здесь закрываем явно
h3 = lg.acquire_instance_lock()
check("instance lock: после освобождения захват снова возможен", h3 is not None)
if h3 is not None and h3 is not True:
    h3.close()
# Недоступный путь (нет каталога/прав) — чистый отказ None, не traceback.
os.environ["LEGION_FPGA_LOCK"] = f"/tmp/legion-no-such-dir-{os.getpid()}/lock"
h4 = lg.acquire_instance_lock()
check("instance lock: недоступный путь → чистый отказ (fail-closed)", h4 is None)
os.environ.pop("LEGION_FPGA_LOCK")

print("LEGION FPGA HOST: ALL PASS" if fails == 0 else f"LEGION FPGA HOST: {fails} FAILURES")
sys.exit(0 if fails == 0 else 1)
