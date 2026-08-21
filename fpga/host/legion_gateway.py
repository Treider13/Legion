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
import socketserver
import sys
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
        self.cap_done = False

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
            # Модель capture: player_ctl 1→0 = «захватили» (как липкий флаг в HDL)
            if addr == lf.REG_PLAYER_CTL:
                if data == 0 and self.regs.get(lf.REG_PLAYER_CTL, 0) == 1:
                    self.cap_done = True
            self.regs[addr] = data
        else:
            ctrl = self.regs.get(lf.REG_CTRL, 0)
            armed = bool(ctrl & lf.CTRL_ARM)
            mode = (ctrl >> 1) & 0x7
            status = 0
            status |= int(armed and mode in (lf.MODE_PLAYER,)) << 0   # playing
            status |= int(self.cap_done) << 1                          # capture_done
            status |= 0 << 2  # det_active
            status |= 0 << 3  # wd_fired
            resp[5:9] = status.to_bytes(4, "little")
        return bytes(resp)


class LegionGateway:
    """Релей команд ноутбука в FPGA. Heartbeat НЕ генерируется здесь:
    deadman-цепь end-to-end — ноутбук шлёт kick каждые 0.5 с; замерло
    любое звено (app/TCP/агент/USB) → kicks прекращаются → watchdog в FPGA
    гасит TX сам. Агент, генерирующий heartbeat сам, держал бы TX живым
    после смерти ноутбука — это и был бы фейк-deadman."""

    def __init__(self, fake: bool) -> None:
        self.fpga = lf.LegionFpga(FakeTransport() if fake else UsbTransport())
        self.fake = fake
        self.last_kick = 0.0
        self.det_thr_set = False  # порог детектора записывался в этой сессии

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
            # lb_gated без явного порога = гейт на шум (порог 0). Отказ честно.
            if mode == lf.MODE_LB_GATED and msg.get("det_thr") is None and not self.det_thr_set:
                return {"ok": False, "reason": "lb_gated: сначала det_thr (порог детектора)"}
            if msg.get("det_thr") is not None:
                if not self.fpga.set_detector(int(msg["det_thr"]), int(msg.get("det_shift", 8))):
                    return {"ok": False, "reason": "запись DET_THR не удалась"}
                self.det_thr_set = True
            ok = self.fpga.arm(mode, bool(msg.get("wd", True)))
            return {"ok": ok, "reason": f"ARM {mode_name}" if ok else "запись CTRL не удалась"}
        if op == "disarm":
            return {"ok": self.fpga.disarm(), "reason": "DISARM"}
        if op == "status":
            st = self.fpga.read_status()
            st["kick_age_ms"] = int((time.monotonic() - self.last_kick) * 1000) if self.last_kick else None
            return st
        if op == "kick":
            self.last_kick = time.monotonic()
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
            ok = self.fpga.write_reg(regmap[reg], val)
            if ok and reg == "det_thr":
                self.det_thr_set = True
            return {"ok": ok}
        return {"ok": False, "reason": f"unknown op {op}"}


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
