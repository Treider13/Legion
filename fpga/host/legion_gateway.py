#!/usr/bin/env python3
"""LEGION FPGA — агент на шлюзе (мини-ПК с USB3 к bladeRF x40).

Ноутбук (LEGION app → sdr_worker.py) шлёт JSON-строки по TCP; агент
выполняет их в железо через USB bulk на PERIPHERAL_EP — тот же путь,
что nios_access.c в libbladeRF (host↔NIOS II через FX3 UART-пакеты).

Команды (по одной JSON-строке на запрос/ответ):
  {"op":"arm", "mode":"player"|"nco"|"lb_gated"|"lb_always", "wd":true}
  {"op":"disarm"}
  {"op":"status"}                       → телеметрия регистров FPGA
  {"op":"kick"}                         — heartbeat watchdog
  {"op":"set", "reg":"nco_ftw"|..., "value":int}
  {"op":"ping"}

LEGION_FPGA_FAKE=1 — проверка протокола без железа (не эфир).
"""
from __future__ import annotations

import json
import os
import socket
import socketserver
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import legion_fpga as lf  # noqa: E402

FAKE = os.environ.get("LEGION_FPGA_FAKE", "").strip() in ("1", "true", "yes")

# USB: bladeRF FX3, peripheral endpoint (как PERIPHERAL_EP_OUT/IN в
# host/libraries/libbladeRF/src/backend/usb/nios_access.c)
BLADERF_VID = 0x2CF0  # Nuand
BLADERF1_PID = 0x5246  # bladeRF 1
EP_OUT = 0x02  # PERIPHERAL_EP_OUT
EP_IN = 0x86   # PERIPHERAL_EP_IN
TIMEOUT_MS = 1000  # PERIPHERAL_TIMEOUT_MS


class UsbTransport:
    """pyusb bulk-передачи 16-байтных NIOS-пакетов."""

    def __init__(self) -> None:
        import usb.core  # pyusb

        self._dev = usb.core.find(idVendor=BLADERF_VID, idProduct=BLADERF1_PID)
        if self._dev is None:
            raise RuntimeError("bladeRF 1 не найден по USB (VID:PID %04X:%04X)"
                               % (BLADERF_VID, BLADERF1_PID))
        try:
            self._dev.set_configuration()
        except Exception:
            pass

    def xfer(self, req: bytes) -> bytes:
        self._dev.write(EP_OUT, req, timeout=TIMEOUT_MS)
        resp = self._dev.read(EP_IN, lf.NIOS_PKT_LEN, timeout=TIMEOUT_MS)
        return bytes(resp)


class FakeTransport:
    """Проверка протокола без железа: регистры в памяти, статус синтезируется."""

    def __init__(self) -> None:
        self.regs = {}

    def xfer(self, req: bytes) -> bytes:
        # Разбор как в NIOS: magic 'C', target, flags, addr, data
        if len(req) != lf.NIOS_PKT_LEN or req[0] != lf.NIOS_PKT_8x32_MAGIC:
            return bytes(16)
        write = bool(req[2] & lf.NIOS_PKT_8x32_FLAG_WRITE)
        addr = req[4]
        data = int.from_bytes(req[5:9], "little")
        resp = bytearray(16)
        resp[0] = lf.NIOS_PKT_8x32_MAGIC
        resp[1] = req[1]
        resp[2] = lf.NIOS_PKT_8x32_FLAG_SUCCESS
        if write:
            self.regs[addr] = data
        else:
            ctrl = self.regs.get(lf.REG_CTRL, 0)
            armed = bool(ctrl & lf.CTRL_ARM)
            mode = (ctrl >> 1) & 0x7
            status = 0
            status |= int(armed and mode in (lf.MODE_PLAYER,)) << 0   # playing
            status |= int(self.regs.get(lf.REG_PLAYER_CTL, 0) == 0) << 1  # capture_done (fake)
            status |= 0 << 2  # det_active
            status |= 0 << 3  # wd_fired
            resp[5:9] = status.to_bytes(4, "little")
        return bytes(resp)


class LegionGateway:
    def __init__(self, fake: bool) -> None:
        self.fpga = lf.LegionFpga(FakeTransport() if fake else UsbTransport())
        self.fake = fake
        self._kick_stop = threading.Event()
        self._kick_thr: threading.Thread | None = None

    def handle(self, msg: dict) -> dict:
        op = msg.get("op")
        if op == "ping":
            return {"ok": True, "fake": self.fake}
        if op == "arm":
            mode_name = str(msg.get("mode") or "player")
            mode = {"player": lf.MODE_PLAYER, "nco": lf.MODE_NCO,
                    "lb_gated": lf.MODE_LB_GATED, "lb_always": lf.MODE_LB_ALWAYS}.get(mode_name)
            if mode is None:
                return {"ok": False, "reason": f"неизвестный mode {mode_name}"}
            ok = self.fpga.arm(mode, bool(msg.get("wd", True)))
            if ok:
                self._start_kick()
            return {"ok": ok, "reason": f"ARM {mode_name}" if ok else "запись CTRL не удалась"}
        if op == "disarm":
            self._stop_kick()
            return {"ok": self.fpga.disarm(), "reason": "DISARM"}
        if op == "status":
            return self.fpga.read_status()
        if op == "kick":
            return {"ok": self.fpga.heartbeat()}
        if op == "set":
            reg = str(msg.get("reg") or "")
            val = int(msg.get("value") or 0)
            regmap = {
                "nco_ftw": lf.REG_NCO_FTW, "det_thr": lf.REG_DET_THR,
                "det_shift": lf.REG_DET_SHIFT, "player_len": lf.REG_PLAYER_LEN,
                "player_ctl": lf.REG_PLAYER_CTL, "lb_shift": lf.REG_LB_SHIFT,
                "wd_limit": lf.REG_WD_LIMIT,
            }
            if reg not in regmap:
                return {"ok": False, "reason": f"неизвестный reg {reg}"}
            return {"ok": self.fpga.write_reg(regmap[reg], val)}
        return {"ok": False, "reason": f"unknown op {op}"}

    def _start_kick(self) -> None:
        # Heartbeat 2 Гц: watchdog в FPGA (limit ~1 с) не должен срабатывать,
        # пока жив ноутбук/шлюз. Обрыв любого звена → TX off сам.
        if self._kick_thr and self._kick_thr.is_alive():
            return
        self._kick_stop.clear()

        def loop() -> None:
            while not self._kick_stop.wait(0.5):
                try:
                    self.fpga.heartbeat()
                except Exception:
                    break

        self._kick_thr = threading.Thread(target=loop, name="legion-fpga-kick", daemon=True)
        self._kick_thr.start()

    def _stop_kick(self) -> None:
        self._kick_stop.set()


class _Handler(socketserver.StreamRequestHandler):
    def handle(self) -> None:
        gw: LegionGateway = self.server.gw  # type: ignore[attr-defined]
        for raw in self.rfile:
            line = raw.strip()
            if not line:
                continue
            try:
                msg = json.loads(line.decode("utf-8", "replace"))
                resp = gw.handle(msg)
            except Exception as e:
                resp = {"ok": False, "reason": str(e)}
            self.wfile.write((json.dumps(resp, ensure_ascii=False) + "\n").encode())


class _Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main() -> int:
    port = int(os.environ.get("LEGION_FPGA_PORT", "5531"))
    gw = LegionGateway(FAKE)
    with _Server(("0.0.0.0", port), _Handler) as srv:
        srv.gw = gw  # type: ignore[attr-defined]
        mode = "FAKE (не эфир)" if FAKE else "USB bladeRF1"
        print(f"legion-gateway: порт {port}, транспорт: {mode}", flush=True)
        srv.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
