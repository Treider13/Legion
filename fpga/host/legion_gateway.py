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
BLADERF_PIDS = (0x5246, 0x5250)  # bladeRF 1, bladeRF 2 micro
EP_OUT = 0x02  # PERIPHERAL_EP_OUT
EP_IN = 0x82   # PERIPHERAL_EP_IN
TIMEOUT_MS = 250  # PERIPHERAL_TIMEOUT_MS (как у Nuand)


class UsbTransport:
    """pyusb bulk-передачи 16-байтных NIOS-пакетов."""

    def __init__(self) -> None:
        import usb.core  # pyusb

        self._usb = usb
        self._dev = None
        self.board = "unknown"
        self._acquire()

    def _acquire(self) -> None:
        self._dev = None
        for pid in BLADERF_PIDS:
            self._dev = self._usb.core.find(idVendor=BLADERF_VID, idProduct=pid)
            if self._dev is not None:
                # PID из дескриптора FX3 — факт платы: 0x5246 bladeRF 1
                # (LMS6002D), 0x5250 micro (AD9361). От этого зависит, чем
                # включать эфир: CONTROL bit1/2 или RFIC-команды 16x64.
                self.board = lf.board_name_for_pid(pid)
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

    def xfer(self, req: bytes) -> bytes:
        self._dev.write(EP_OUT, req, timeout=TIMEOUT_MS)
        resp = self._dev.read(EP_IN, lf.NIOS_PKT_LEN, timeout=TIMEOUT_MS)
        return bytes(resp)


class FakeTransport:
    """Проверка протокола без железа: регистры в памяти, статус синтезируется."""

    def __init__(self, board: str = "bladerf1") -> None:
        self.regs = {}
        self.cap_done = False
        self.control = 0  # штатный CONTROL-регистр FPGA (target 0x01)
        self.released = False
        self.fail_control_read = False
        self.fail_ctrl_write = False  # честный сбой записи REG_CTRL (тест отката)
        self.board = board
        # Модель RFIC (micro): init_state ON?, включённые каналы, LO по каналам
        self.rfic_on = False
        self.rfic_enabled: set[int] = set()
        self.rfic_freq: dict[int, int] = {}

    def release(self) -> None:
        self.released = True

    def acquire(self) -> None:
        self.released = False

    def _xfer_rfic(self, req: bytes) -> bytes:
        """16x64 target RFIC: очередь записи мгновенно пуста, успех всегда."""
        write = bool(req[2] & lf.NIOS_PKT_8x32_FLAG_WRITE)
        addr = req[4] | (req[5] << 8)
        cmd = addr & 0xFF
        ch = (addr >> 8) & 0xF
        data = 0
        for i in range(8):
            data |= req[6 + i] << (8 * i)
        out = 0
        if write:
            if cmd == lf.RFIC_CMD_INIT:
                self.rfic_on = data == lf.RFIC_INIT_ON
            elif cmd == lf.RFIC_CMD_ENABLE:
                if data:
                    self.rfic_enabled.add(ch)
                else:
                    self.rfic_enabled.discard(ch)
            elif cmd == lf.RFIC_CMD_FREQUENCY:
                self.rfic_freq[ch] = data
        else:
            if cmd == lf.RFIC_CMD_STATUS:
                out = (int(self.rfic_on) << 0) | (1 << 1)  # init + wqsuccess, wqlen=0
            elif cmd == lf.RFIC_CMD_FREQUENCY:
                out = self.rfic_freq.get(ch, 0)
        resp = bytearray(req)
        resp[2] = (req[2] & 0x1) | lf.NIOS_PKT_8x32_FLAG_SUCCESS
        for i in range(8):
            resp[6 + i] = (out >> (8 * i)) & 0xFF
        return bytes(resp)

    def xfer(self, req: bytes) -> bytes:
        # Отпущенный USB = честный отказ (как pyusb после dispose_resources)
        if self.released:
            raise RuntimeError("USB отпущен (release) — устройство не наше")
        if len(req) != lf.NIOS_PKT_LEN:
            return bytes(16)
        if req[0] == lf.NIOS_PKT_16x64_MAGIC:
            return self._xfer_rfic(req)
        # Разбор как в NIOS: magic 'C', target, flags, addr, data
        if req[0] != lf.NIOS_PKT_8x32_MAGIC:
            return bytes(16)
        target = req[1]
        write = bool(req[2] & lf.NIOS_PKT_8x32_FLAG_WRITE)
        addr = req[4]
        data = int.from_bytes(req[5:9], "little")
        if write and self.fail_ctrl_write and target == lf.LEGION_TARGET and addr == lf.REG_CTRL:
            return bytes(16)  # нет SUCCESS: запись CTRL в FPGA не прошла
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
    агент одновременно на одном x40 не работают (см. fpga/README.md)."""

    def __init__(self, fake: bool) -> None:
        self.fpga = lf.LegionFpga(FakeTransport() if fake else UsbTransport())
        self.fake = fake
        self.last_kick = 0.0
        self.det_thr_set = False  # порог детектора записывался в этой сессии
        self._rx_by_us = False    # analog RX включён нами — снять при disarm
        self._tx_by_us = False    # analog TX включён нами — снять при disarm

    # --- Штатный CONTROL-регистр FPGA (target 0x01): read-modify-write ---
    # Бит 1 = lms_rx_enable, бит 2 = lms_tx_enable, бит 0 = lms_reset
    # (факт: pack() в bladerf_p.vhd дерева Nuand). Только bladeRF 1: на micro
    # target 0x01 — это rffe_gpo (пины AD9361 enable/txnrx/reset_n, pack() в
    # platforms/bladerf-micro/vhdl/bladerf_p.vhd) — LMS-биты туда писать нельзя.
    LMS_RX_EN = 0x2
    LMS_TX_EN = 0x4

    def _board(self) -> str:
        return getattr(self.fpga._t, "board", "unknown")

    # --- micro (AD9361): включение эфира RFIC-командами 16x64 ---
    # После закрытия Soapy libbladeRF уводит RFIC в STANDBY (bladerf2_close →
    # rfic->standby: «shut down any current RF activity, but will not lose the
    # RF state»). Поэтому агент сам поднимает INIT=ON (из STANDBY паркованный
    # LO/rate сохраняются — devices_rfic_cmds.c пер-настраивает только из OFF)
    # и включает каналы ENABLE. Частоту сверяем readback'ом с park_mhz.

    def _rfic_ensure_on(self) -> tuple[bool, str]:
        init = self.fpga.rfic_is_initialized()
        if init is None:
            return False, "RFIC STATUS не ответил (образ без RFIC-очереди?)"
        if not init and not self.fpga.rfic_initialize():
            return False, "RFIC INIT=ON не выполнен (spinwait/очередь)"
        return True, ""

    def _rfic_air_enable(self, rx: bool, tx: bool,
                         park_mhz: float | None = None) -> tuple[bool, str]:
        ok, why = self._rfic_ensure_on()
        if not ok:
            return False, why
        if park_mhz is not None and park_mhz > 0:
            # 1 МГц — тот же допуск, что park() воркера: ловит «LO не тот».
            f = self.fpga.rfic_frequency_hz(lf.RFIC_CH_RX0)
            if f is None:
                return False, "RFIC FREQUENCY RX не ответил — park не подтвердить"
            if abs(f - park_mhz * 1e6) > 1e6:
                return False, (f"RFIC LO {f / 1e6:.3f} МГц ≠ park {park_mhz:.3f} — "
                               "FPGA ретранслировал бы чужую частоту, отказ")
        if rx and not self.fpga.rfic_enable_channel(lf.RFIC_CH_RX0, True):
            return False, "RFIC ENABLE RX0 не выполнен"
        if tx and not self.fpga.rfic_enable_channel(lf.RFIC_CH_TX0, True):
            if rx:
                # TX не встал — включённый RX не оставляем сиротой
                self.fpga.rfic_enable_channel(lf.RFIC_CH_RX0, False)
            return False, "RFIC ENABLE TX0 не выполнен"
        return True, ""

    def _rfic_air_disable(self, rx: bool, tx: bool) -> bool:
        ok = True
        if rx:
            ok = self.fpga.rfic_enable_channel(lf.RFIC_CH_RX0, False) and ok
        if tx:
            ok = self.fpga.rfic_enable_channel(lf.RFIC_CH_TX0, False) and ok
        return ok

    def _analog_disable_ours(self) -> None:
        """Снять то, что включали мы (флаги _rx/_tx_by_us), по плате."""
        if self._board() == "bladerf2":
            self._rfic_air_disable(self._rx_by_us, self._tx_by_us)
        else:
            self._lms_enable(
                rx=False if self._rx_by_us else None,
                tx=False if self._tx_by_us else None,
            )
        self._rx_by_us = False
        self._tx_by_us = False

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
        if self._board() == "bladerf2":
            ok, _ = self._rfic_ensure_on()
            return ok and self.fpga.rfic_enable_channel(lf.RFIC_CH_RX0, on)
        return self._lms_enable(rx=on)

    def handle(self, msg: dict) -> dict:
        op = msg.get("op")
        if op == "ping":
            return {"ok": True, "fake": self.fake, "board": self._board()}
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
            # Analog: lb_* = антенна + усилитель, nco/player = только TX.
            # bladeRF 1: CONTROL bit1/2 (LMS6002D). micro: RFIC ENABLE по 16x64
            # (AD9361; CONTROL там — пины RFFE, не трогаем). park_mhz — readback
            # LO на micro: ARM на чужой частоте = ретрансляция не туда.
            micro = self._board() == "bladerf2"
            park_mhz = msg.get("park_mhz")
            park_mhz = float(park_mhz) if isinstance(park_mhz, (int, float)) else None
            if mode in (lf.MODE_LB_GATED, lf.MODE_LB_ALWAYS):
                if micro:
                    ok, why = self._rfic_air_enable(True, True, park_mhz)
                    if not ok:
                        return {"ok": False, "reason": f"RFIC: {why}"}
                elif not self._lms_enable(rx=True, tx=True):
                    return {"ok": False, "reason": "CONTROL: не включить RX+TX (lms_*_enable)"}
                self._rx_by_us = True
                self._tx_by_us = True
            elif mode in (lf.MODE_NCO, lf.MODE_PLAYER):
                if micro:
                    ok, why = self._rfic_air_enable(False, True)
                    if not ok:
                        return {"ok": False, "reason": f"RFIC: {why}"}
                elif not self._lms_enable(tx=True):
                    return {"ok": False, "reason": "CONTROL: не включить TX (lms_tx_enable)"}
                self._tx_by_us = True
            ok = self.fpga.arm(mode, bool(msg.get("wd", True)))
            if not ok and (self._rx_by_us or self._tx_by_us):
                # CTRL не записался — включённый нами эфир не оставляем сиротой.
                self._analog_disable_ours()
            return {"ok": ok, "reason": f"ARM {mode_name}" if ok else "запись CTRL не удалась — эфир откачен"}
        if op == "disarm":
            ok = self.fpga.disarm()
            if ok and (self._rx_by_us or self._tx_by_us):
                self._analog_disable_ours()
            return {"ok": ok, "reason": "DISARM"}
        if op == "status":
            st = self.fpga.read_status()
            st["kick_age_ms"] = int((time.monotonic() - self.last_kick) * 1000) if self.last_kick else None
            return st
        if op == "kick":
            self.last_kick = time.monotonic()
            return {"ok": self.fpga.heartbeat()}
        if op == "rx":
            # Включить/выключить RX (для мониторинга детектора без lb_*:
            # NCO-тон с кабеля и т.п.). x40 — CONTROL bit1, micro — RFIC ENABLE.
            on = bool(msg.get("on"))
            ok = self._rx_enable(on)
            self._rx_by_us = bool(on) if ok else self._rx_by_us
            via = "RFIC ENABLE" if self._board() == "bladerf2" else "CONTROL bit1"
            return {"ok": ok, "reason": f"RX {'on' if on else 'off'} ({via})"}
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
        mode = "FAKE (не эфир)" if FAKE else f"USB {gw.fpga._t.board}"
        print(f"legion-gateway: порт {port}, транспорт: {mode}", flush=True)
        srv.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
