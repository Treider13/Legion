#!/usr/bin/env python3
"""LEGION FPGA — агент на шлюзе (мини-ПК с USB3 к bladeRF x40 / micro xA4).

Ноутбук (LEGION app → sdr_worker.py) шлёт JSON-строки по TCP; агент
выполняет их в железо через USB bulk на PERIPHERAL_EP — тот же путь,
что nios_access.c в libbladeRF (host↔NIOS II через FX3 UART-пакеты).

Команды (по одной JSON-строке на запрос/ответ):
  {"op":"arm", "mode":"player"|"nco"|"lb_gated"|"lb_always", "wd":true,
   "det_thr":int, "det_shift":int, "freq_mhz":float, "gain_db":int}
  {"op":"disarm"}
  {"op":"status"}                       → телеметрия регистров FPGA
  {"op":"kick"}                         — heartbeat watchdog
  {"op":"set", "reg":"nco_ftw"|..., "value":int}
  {"op":"ping"}

Плата определяется по USB PID: 0x5246 = bladeRF 1 (эфир через CONTROL
bit1/2, bladerf_p.vhd), 0x5250 = micro (эфир через AIR-регистры NIOS:
AD9361 поднимает прошивка — хост при close гасит RFIC, факт из
libbladeRF rfic_host.c/bladerf2.c).

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

# Токен доступа: если LEGION_FPGA_TOKEN задан — все команды (кроме ping)
# обязаны нести "token". Пустая переменная = открытая доверенная LAN
# (лабораторный стенд), но по умолчанию на стенде токен задавать.
AUTH_TOKEN = os.environ.get("LEGION_FPGA_TOKEN", "").strip()

# USB: bladeRF FX3, peripheral endpoint. Значения сверены с исходниками Nuand
# (тест test_legion_fpga.py читает их из реальных заголовков):
#   firmware_common/bladeRF.h: USB_NUAND_VENDOR_ID=0x2CF0,
#     BLADERF_PRODUCT_ID=0x5246 (bladeRF 1), BLADERF2_PRODUCT_ID=0x5250 (micro)
#   backend/usb/usb.h: PERIPHERAL_EP_OUT=0x02, PERIPHERAL_EP_IN=0x82,
#     PERIPHERAL_TIMEOUT_MS=250
BLADERF_VID = 0x2CF0
BLADERF_PIDS = {0x5246: "bladerf1", 0x5250: "bladerf2"}  # PID → класс платы
EP_OUT = 0x02  # PERIPHERAL_EP_OUT
EP_IN = 0x82   # PERIPHERAL_EP_IN
TIMEOUT_MS = 250  # PERIPHERAL_TIMEOUT_MS (как у Nuand)


class UsbTransport:
    """pyusb bulk-передачи 16-байтных NIOS-пакетов."""

    def __init__(self) -> None:
        import usb.core  # pyusb

        self._usb = usb
        self._dev = None
        self.board = ""  # bladerf1 | bladerf2 — по PID при acquire
        self._acquire()

    def _acquire(self) -> None:
        self._dev = None
        for pid, board in BLADERF_PIDS.items():
            self._dev = self._usb.core.find(idVendor=BLADERF_VID, idProduct=pid)
            if self._dev is not None:
                self.board = board
                break
        if self._dev is None:
            raise RuntimeError("bladeRF не найден по USB (VID %04X, PID %s)"
                               % (BLADERF_VID, "/".join(f"{p:04X}" for p in BLADERF_PIDS)))
        # set_configuration только если не настроена (активная читается — уже настроена)
        try:
            self._dev.get_active_configuration()
        except self._usb.core.USBError:
            self._dev.set_configuration()

    def release(self) -> None:
        """Отпустить USB (передать владение стрим-серверу — один владелец!)."""
        if self._dev is not None:
            self._usb.util.dispose_resources(self._dev)
            self._dev = None

    def acquire(self) -> None:
        if self._dev is None:
            self._acquire()

    def xfer(self, req: bytes, timeout_ms: int | None = None) -> bytes:
        t = TIMEOUT_MS if timeout_ms is None else int(timeout_ms)
        self._dev.write(EP_OUT, req, timeout=t)
        resp = self._dev.read(EP_IN, lf.NIOS_PKT_LEN, timeout=t)
        return bytes(resp)


class FakeTransport:
    """Проверка протокола без железа: регистры в памяти, статус синтезируется."""

    def __init__(self, board: str = "bladerf1") -> None:
        self.regs = {}
        self.cap_done = False
        self.control = 0  # штатный CONTROL-регистр FPGA (target 0x01)
        self.released = False
        self.fail_control_read = False
        self.board = board  # bladerf1 | bladerf2 — ветка эфира в ARM

    def release(self) -> None:
        self.released = True

    def acquire(self) -> None:
        self.released = False

    def xfer(self, req: bytes, timeout_ms: int | None = None) -> bytes:
        del timeout_ms  # FAKE отвечает мгновенно; параметр — для USB-транспорта
        # Отпущенный USB = честный отказ (как pyusb после dispose_resources)
        if self.released:
            raise RuntimeError("USB отпущен (release) — устройство не наше")
        # Разбор как в NIOS: magic 'C', target, flags, addr, data
        if len(req) != lf.NIOS_PKT_LEN or req[0] != lf.NIOS_PKT_8x32_MAGIC:
            return bytes(16)
        target = req[1]
        write = bool(req[2] & lf.NIOS_PKT_8x32_FLAG_WRITE)
        addr = req[4]
        data = int.from_bytes(req[5:9], "little")
        resp = bytearray(16)
        resp[0] = lf.NIOS_PKT_8x32_MAGIC
        resp[1] = req[1]
        resp[2] = lf.NIOS_PKT_8x32_FLAG_SUCCESS
        if target == 0x01:
            # Штатный CONTROL: readback = текущее значение (control_reg_read)
            if not write and self.fail_control_read:
                return bytes(16)
            if write:
                self.control = data
            resp[5:9] = self.control.to_bytes(4, "little")
            return bytes(resp)
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
    после смерти ноутбука — это и был бы фейк-deadman.

    Один владелец USB на шлюзе (факт из дескриптора FX3: интерфейс один,
    alt-settings; peripheral EP внутри RF alt) — SoapySDRServer и этот
    агент одновременно на одном bladeRF не работают (см. fpga/README.md)."""

    def __init__(self, fake: bool) -> None:
        self.fpga = lf.LegionFpga(FakeTransport() if fake else UsbTransport())
        self.fake = fake
        # bladerf1 = LMS6002D (эфир через CONTROL bit1/2), bladerf2 = micro
        # AD9361 (эфир через AIR-регистры NIOS — CONTROL там не существует)
        self.board = getattr(self.fpga._t, "board", "") or "bladerf1"
        self.last_kick = 0.0
        self.det_thr_set = False  # порог детектора записывался в этой сессии
        self._rx_by_us = False    # analog RX включён нами — снять при disarm
        self._tx_by_us = False    # analog TX включён нами — снять при disarm

    # --- Штатный CONTROL-регистр FPGA (target 0x01): read-modify-write ---
    # Бит 1 = lms_rx_enable, бит 2 = lms_tx_enable, бит 0 = lms_reset
    # (факт: pack() в bladerf_p.vhd дерева Nuand).
    LMS_RX_EN = 0x2
    LMS_TX_EN = 0x4

    def _control_read(self) -> int | None:
        """None = пакет не принят. Нельзя подставлять 0: бит 0 = lms_reset,
        биты 6:3 = выбор полосы LMS — запись 0 сажает чип в reset и сносит park."""
        ok, data = lf.unpack_8x32_resp(
            self.fpga._t.xfer(lf.pack_8x32(0x01, False, 0, 0)))
        return data if ok else None

    def _control_write(self, data: int) -> bool:
        ok, _ = lf.unpack_8x32_resp(
            self.fpga._t.xfer(lf.pack_8x32(0x01, True, 0, data)))
        return ok

    def _lms_enable(self, rx: bool | None = None, tx: bool | None = None) -> bool:
        ctrl = self._control_read()
        if ctrl is None:
            return False
        if rx is True:
            ctrl |= self.LMS_RX_EN
        elif rx is False:
            ctrl &= ~self.LMS_RX_EN
        if tx is True:
            ctrl |= self.LMS_TX_EN
        elif tx is False:
            ctrl &= ~self.LMS_TX_EN
        return self._control_write(ctrl & 0xFFFFFFFF)

    def _rx_enable(self, on: bool) -> bool:
        return self._lms_enable(rx=on)

    def _air_enable(self, mode: int, msg: dict) -> tuple[bool, str]:
        """Включить аналоговый тракт под режим. Возвращает (ok, reason).

        bladeRF 1 (LMS6002D): штатный CONTROL bit1/2 (bladerf_p.vhd), RMW.
        micro (AD9361): CONTROL там не существует — хост при закрытии USB
        гасит RFIC (bladerf2_close → rfic->standby, факт libbladeRF), поэтому
        тракт поднимает NIOS-прошивка через AIR-регистры (RFIC-интерфейс
        Nuand FPGA-tuning). Частота LO обязательна — без неё эфир чужой.
        """
        if mode == lf.MODE_PASS:
            return True, ""
        rx = mode in (lf.MODE_LB_GATED, lf.MODE_LB_ALWAYS)
        if self.board == "bladerf2":
            freq = msg.get("freq_mhz")
            if freq is None:
                return False, "micro: ARM требует freq_mhz (LO парковки для AD9361)"
            if not self.fpga.set_air_freq_mhz(float(freq)):
                return False, "micro: запись AIR_FREQ_KHZ не удалась"
            gain = msg.get("gain_db")
            if gain is not None and not self.fpga.set_air_gain_db(int(gain)):
                return False, "micro: запись AIR_GAIN_DB не удалась"
            # Первый подъём — полный ad9361_init на NIOS (сотни мс, длинный
            # таймаут внутри air_prepare); дальше — тёплый рестор из standby.
            if not self.fpga.air_prepare(True, rx=rx, tx=True):
                return False, "micro: AIR_PREP отказ — RFIC не поднялся (init/enable)"
            self._rx_by_us = rx
            self._tx_by_us = True
            return True, ""
        if rx:
            if not self._lms_enable(rx=True, tx=True):
                return False, "CONTROL: не включить RX+TX (lms_*_enable)"
            self._rx_by_us = True
            self._tx_by_us = True
        elif mode in (lf.MODE_NCO, lf.MODE_PLAYER):
            if not self._lms_enable(tx=True):
                return False, "CONTROL: не включить TX (lms_tx_enable)"
            self._tx_by_us = True
        return True, ""

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
            if msg.get("nco_ftw") is not None:
                if not self.fpga.write_reg(lf.REG_NCO_FTW, int(msg["nco_ftw"]) & 0xFFFFFFFF):
                    return {"ok": False, "reason": "запись NCO_FTW не удалась"}
            elif mode == lf.MODE_NCO:
                # Панель без FTW = DC. Шлюз ставит fs/8, не ноль.
                if not self.fpga.set_nco_freq(2.0e6 / 8.0):
                    return {"ok": False, "reason": "NCO FTW по умолчанию (fs/8) не записался"}
            # Аналог: x40 — CONTROL bit1/2; micro — AIR-регистры NIOS (AD9361).
            # Цифровой IQ после close Soapy держит HDL/RFIC, не USB-линк.
            air_ok, air_why = self._air_enable(mode, msg)
            if not air_ok:
                return {"ok": False, "reason": air_why}
            ok = self.fpga.arm(mode, bool(msg.get("wd", True)))
            if not ok and (self._rx_by_us or self._tx_by_us):
                # Откат: эфир подняли, а ARM не взвёлся — тракт под током не
                # оставляем: на micro PASS-мукс отдал бы DAC статику (несущая
                # LO на усилитель), на x40 — LMS TX под CONTROL битом.
                if self.board == "bladerf2":
                    self.fpga.air_prepare(False, rx=False, tx=False)
                else:
                    self._lms_enable(
                        rx=False if self._rx_by_us else None,
                        tx=False if self._tx_by_us else None,
                    )
                self._rx_by_us = False
                self._tx_by_us = False
            return {
                "ok": ok,
                "reason": f"ARM {mode_name}" if ok else "запись CTRL не удалась — эфир откачен",
            }
        if op == "disarm":
            ok = self.fpga.disarm()
            # micro: NIOS сам уводит RFIC в standby по CTRL=0 (legion_cmds.c),
            # флаги там информационные. x40: CONTROL снимаем как раньше —
            # при сбое флаги держим, следующий disarm повторит.
            if self.board == "bladerf2":
                self._rx_by_us = False
                self._tx_by_us = False
            elif ok and (self._rx_by_us or self._tx_by_us):
                self._lms_enable(
                    rx=False if self._rx_by_us else None,
                    tx=False if self._tx_by_us else None,
                )
                self._rx_by_us = False
                self._tx_by_us = False
            return {"ok": ok, "reason": "DISARM"}
        if op == "status":
            st = self.fpga.read_status()
            st["kick_age_ms"] = int((time.monotonic() - self.last_kick) * 1000) if self.last_kick else None
            return st
        if op == "kick":
            self.last_kick = time.monotonic()
            return {"ok": self.fpga.heartbeat()}
        if op == "rx":
            # Включить/выключить RX штатным CONTROL-регистром (для мониторинга
            # детектора без lb_*: NCO-тон с кабеля и т.п.) — только bladeRF 1.
            if self.board == "bladerf2":
                return {"ok": False,
                        "reason": "micro: CONTROL не существует — RX поднимает AIR_PREP (AD9361)"}
            on = bool(msg.get("on"))
            ok = self._rx_enable(on)
            self._rx_by_us = bool(on) if ok else self._rx_by_us
            return {"ok": ok, "reason": f"RX {'on' if on else 'off'} (CONTROL bit1)"}
        if op == "usb":
            # Один владелец USB: release → отдать устройство стрим-серверу
            # (SoapySDRServer), acquire → забрать обратно. Регистры FPGA при
            # этом не сбрасываются — они в фабрике, не в USB-линке.
            action = str(msg.get("action") or "")
            t = self.fpga._t
            if action == "release":
                if hasattr(t, "release"):
                    t.release()
                return {"ok": True, "reason": "USB отпущен (стрим-сервер может занять)"}
            if action == "acquire":
                if hasattr(t, "acquire"):
                    try:
                        t.acquire()
                    except Exception as e:
                        return {"ok": False, "reason": f"USB занять не удалось: {e}"}
                return {"ok": True, "reason": "USB занят агентом"}
            return {"ok": False, "reason": f"usb: неизвестный action {action}"}
        if op == "set":
            reg = str(msg.get("reg") or "")
            val = int(msg.get("value") or 0)
            regmap = {
                "nco_ftw": lf.REG_NCO_FTW, "det_thr": lf.REG_DET_THR,
                "det_shift": lf.REG_DET_SHIFT, "player_len": lf.REG_PLAYER_LEN,
                "player_ctl": lf.REG_PLAYER_CTL, "lb_shift": lf.REG_LB_SHIFT,
                "wd_limit": lf.REG_WD_LIMIT,
                "air_freq_khz": lf.REG_AIR_FREQ_KHZ, "air_gain_db": lf.REG_AIR_GAIN_DB,
                "air_prep": lf.REG_AIR_PREP,
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
                # Авторизация: при заданном LEGION_FPGA_TOKEN каждая команда
                # (кроме ping) несёт токен; неверный/отсутствует — отказ.
                if AUTH_TOKEN and msg.get("op") != "ping" and msg.get("token") != AUTH_TOKEN:
                    resp = {"ok": False, "reason": "нет/неверен token (LEGION_FPGA_TOKEN на шлюзе)"}
                else:
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
        mode = "FAKE (не эфир)" if FAKE else f"USB {gw.board}"
        print(f"legion-gateway: порт {port}, транспорт: {mode}", flush=True)
        srv.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
