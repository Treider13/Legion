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
  {"op":"usb", "action":"release"|"acquire"}  — один владелец USB
  {"op":"tune", "freq_mhz":float, ...}  — LO-hop на живом ARM (только micro)
  {"op":"flash", "path":"/abs/legionxA4.rbf", "action":"load"|"store"}
      — запись ревизии legion на ЭТОМ шлюзе: release USB → bladeRF-cli -l/-L
      → acquire обратно. Async (CLI дольше 12-с релея воркера): старт сразу,
      результат — {"op":"flash_status"}. Только legionx*.rbf, не hosted/FX3.
  {"op":"ping"}

Плата определяется по USB PID: 0x5246 = bladeRF 1 (эфир через CONTROL
bit1/2, bladerf_p.vhd), 0x5250 = micro (эфир через AIR-регистры NIOS:
AD9361 поднимает прошивка — хост при close гасит RFIC, факт из
libbladeRF rfic_host.c/bladerf2.c).

Deadman слои: FPGA гасит цифру (~1 с без kick) → NIOS (legion_work)
снимает ARM и эфир → сторож kick_age шлюза делает DISARM → USB release.
SIGTERM/SIGINT/atexit → DISARM + release (wiki Nuand: kill без
libusb_close роняет Intel XHCI).

Переменные: LEGION_FPGA_FAKE=1 — проверка протокола без железа (не эфир);
LEGION_FPGA_TOKEN — токен доступа; LEGION_FPGA_PORT (5531);
LEGION_KICK_TIMEOUT_S (2.5) — сторож kick_age; LEGION_DET_THR_FLOOR (1) —
пол порога lb_gated; LEGION_FPGA_RBF — образ для автозагрузки, если FPGA
пустая после re-enumerate (питание xA4 — от USB).
"""
from __future__ import annotations

import json
import os
import re
import signal
import socketserver
import subprocess
import sys
import threading
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


# Пол порога детектора: lb_gated с det_thr ниже floor = гейт на шум.
# Дефолт 1 — отказ только при явном 0 (задокументировано: «порог 0 = гейт
# на шум»); приложение считает свой floor из полки (fpgaFastpath.ts).
DET_THR_FLOOR = int(os.environ.get("LEGION_DET_THR_FLOOR", "1"))

# Артефакт ревизии legion из build_bladerf.sh (BUILD_NAME="$rev"x"$size"):
# legionx40.rbf / legionxA4.rbf / legionxA9.rbf (+ алиас с подчёркиванием
# из старых docs). hosted/FX3/чужие имена op flash не принимает.
LEGION_RBF_RE = re.compile(r"^legion_?x(40|a4|a9)\.rbf$", re.IGNORECASE)

# Сторож heartbeat шлюза: ARM жив, а kicks пропали дольше этого срока →
# сам DISARM → USB release (именно в этом порядке: release без DISARM
# отдал бы плату Soapy с живым ARM и поднятым аналогом). Дефолт 2.5 с:
# дольше FPGA-сторожа (~1 с, WD_LIMIT) — первичное гашение цифрой делает
# железо, затем NIOS (legion_work), шлюз убирает USB последним слоем.
# 0 = выключить (не рекомендуется). Kick приложения = 500 мс.
KICK_TIMEOUT_S = float(os.environ.get("LEGION_KICK_TIMEOUT_S", "2.5"))


class UsbTransport:
    """pyusb bulk-передачи 16-байтных NIOS-пакетов."""

    # firmware_common/bladeRF.h: BLADE_USB_CMD_QUERY_FPGA_STATUS = 1,
    # BLADE_USB_TYPE_IN = 0xC0 (vendor, device-to-host). Ответ int32 LE:
    # 1 = FPGA сконфигурирована, 0 = пустая (usb_is_fpga_configured, usb.c).
    USB_CMD_QUERY_FPGA_STATUS = 1
    USB_TYPE_IN = 0xC0

    def __init__(self) -> None:
        import usb.core  # pyusb

        self._usb = usb
        self._dev = None
        self.board = ""  # bladerf1 | bladerf2 — по PID при acquire
        self._acquire()

    def _find(self) -> None:
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

    def _fpga_configured(self) -> bool:
        raw = self._dev.ctrl_transfer(self.USB_TYPE_IN,
                                      self.USB_CMD_QUERY_FPGA_STATUS,
                                      0, 0, 4, timeout=TIMEOUT_MS)
        val = int.from_bytes(bytes(raw[:4]), "little", signed=True)
        if val not in (0, 1):
            raise RuntimeError(f"FPGA status query: неожиданный ответ {val}")
        return val == 1

    def _load_fpga(self) -> None:
        """FPGA пустая (питание xA4 — от USB: выдёргивание = образ потерян,
        если нет autoload из flash). Грузим в RAM как bladeRF-cli -l."""
        rbf = os.environ.get("LEGION_FPGA_RBF", "").strip()
        if not rbf:
            raise RuntimeError(
                "FPGA не загружена (пустая после re-enumerate?): задайте "
                "LEGION_FPGA_RBF для автозагрузки или bladeRF-cli -l/-L вручную")
        if not os.path.isfile(rbf):
            raise RuntimeError(f"LEGION_FPGA_RBF: файл не найден: {rbf}")
        try:
            cp = subprocess.run(["bladeRF-cli", "-l", rbf],
                                capture_output=True, text=True, timeout=60)
        except FileNotFoundError:
            raise RuntimeError("bladeRF-cli не найден — FPGA загрузить нечем")
        if cp.returncode != 0:
            raise RuntimeError(
                f"bladeRF-cli -l: {(cp.stderr or cp.stdout).strip()[:200]}")

    def _acquire(self) -> None:
        self._find()
        if not self._fpga_configured():
            self._load_fpga()
            time.sleep(0.5)  # конфигурация FPGA и возможная re-enumeration
            self._find()
            if not self._fpga_configured():
                raise RuntimeError("FPGA не поднялась после bladeRF-cli -l")

    def release(self) -> None:
        """Отпустить USB (передать владение стрим-серверу — один владелец!)."""
        if self._dev is not None:
            self._usb.util.dispose_resources(self._dev)
            self._dev = None

    def acquire(self) -> None:
        if self._dev is None:
            self._acquire()

    def _reacquire(self) -> None:
        """Re-enumerate: старый handle мёртв, устройство возвращается не сразу."""
        try:
            if self._dev is not None:
                self._usb.util.dispose_resources(self._dev)
        except Exception:
            pass
        self._dev = None
        time.sleep(0.2)
        self._acquire()

    def xfer(self, req: bytes, timeout_ms: int | None = None) -> bytes:
        t = TIMEOUT_MS if timeout_ms is None else int(timeout_ms)
        try:
            self._dev.write(EP_OUT, req, timeout=t)
            resp = self._dev.read(EP_IN, lf.NIOS_PKT_LEN, timeout=t)
        except self._usb.core.USBError:
            # Краткий сбой шины / re-enumerate: переоткрыть и повторить
            # ОДИН раз. Дальше — честный отказ наверх (ретрай-шторм хуже).
            self._reacquire()
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
        self.fail_ctrl_write = False  # сбой записи REG_CTRL (откат эфира в ARM)
        self.board = board  # bladerf1 | bladerf2 — ветка эфира в ARM
        # Модель липкого латча NIOS (bit4 STATUS): deadman сработал —
        # после автономного DISARM HDL-бит wd_fired (bit3) гаснет за мкс.
        self.wd_latch = False

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
            # Сбой записи CTRL (откат эфира в ARM проверяется этим)
            if addr == lf.REG_CTRL and self.fail_ctrl_write:
                return bytes(16)
            # Новый ARM снимает латч deadman (как NIOS legion_cmds.c)
            if addr == lf.REG_CTRL and (data & lf.CTRL_ARM):
                self.wd_latch = False
            # Модель capture: player_ctl 1→0 = «захватили» (как липкий флаг в HDL)
            if addr == lf.REG_PLAYER_CTL:
                if data == 0 and self.regs.get(lf.REG_PLAYER_CTL, 0) == 1:
                    self.cap_done = True
            self.regs[addr] = data
        else:
            if addr == lf.REG_AIR_PREP:
                # Модель readback'а NIOS: bit0 = эфир поднят (по последней
                # записи AIR_PREP), bit1 = частота задана.
                air = int(bool(self.regs.get(lf.REG_AIR_PREP, 0) & 0x1))
                freq = int(self.regs.get(lf.REG_AIR_FREQ_KHZ, 0) != 0)
                resp[5:9] = (air | (freq << 1)).to_bytes(4, "little")
                return bytes(resp)
            ctrl = self.regs.get(lf.REG_CTRL, 0)
            armed = bool(ctrl & lf.CTRL_ARM)
            mode = (ctrl >> 1) & 0x7
            status = 0
            status |= int(armed and mode in (lf.MODE_PLAYER,)) << 0   # playing
            status |= int(self.cap_done) << 1                          # capture_done
            status |= 0 << 2  # det_active
            status |= 0 << 3  # wd_fired (HDL, живой)
            status |= int(self.wd_latch) << 4  # wd_latch (NIOS, липкий)
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
        self._armed = False       # CTRL.ARM записан и не снят (по нашим командам)
        self._armed_at = 0.0      # monotonic ARM (сторож: ARM без единого kick)
        self._wd_en = True        # ARM с wd=false — оператор отказался от deadman
        self._wd_attempts = 0     # попытки сторожа в этом ARM (троттлинг лога)
        # Async flash (op flash): bladeRF-cli -l/-L дольше 12-с релея воркера,
        # поэтому старт сразу, результат — op flash_status.
        self._flash: dict = {"running": False, "done": False, "ok": False,
                             "log": "", "action": "", "path": ""}
        # Ревизия legion в FPGA? True — 0x80 отвечает, False — hosted
        # (NIOS: invalid id, нет SUCCESS), None — неизвестно (USB отпущен).
        self._legion: bool | None = None
        if fake:
            self._legion = True
        else:
            self._detect_legion()
        # Операции и сторож сериализуются: ThreadingTCPServer гоняет handle()
        # в потоках, а xfer — это пара write/read 16-байтных пакетов, которую
        # нельзя перемежать с DISARM сторожа (иначе ответ уедет не тому).
        self._op_lock = threading.Lock()
        threading.Thread(target=self._kick_watchdog, daemon=True).start()

    def _kick_watchdog(self) -> None:
        """Heartbeat пропал при живом ARM → сам DISARM → USB release.

        Последний софт-слой deadman: FPGA гасит цифру (~1 с), NIOS
        (legion_work) снимает ARM и эфир, шлюз отпускает USB, чтобы сканер
        или ожившая панель снова открыли Soapy. wd=false при ARM — отказ
        оператора от deadman, сторож молчит. Опорная точка — ПОЗДНЯЯ из
        (последний kick, момент ARM): last_kick переживает DISARM, и без
        max() устаревший kick прошлой сессии сжёг бы свежий ARM до первого
        kick (регресс-тест в test_legion_fpga.py)."""
        while True:
            time.sleep(0.5)
            if KICK_TIMEOUT_S <= 0:
                continue
            with self._op_lock:
                if not self._armed or not self._wd_en:
                    continue
                ref = max(self.last_kick, self._armed_at)
                if not ref or time.monotonic() - ref < KICK_TIMEOUT_S:
                    continue
                self._wd_attempts += 1
                # USB мог умереть вместе с линком — DISARM будет падать;
                # ретраим каждый тик, но в лог — первый раз и дальше раз в 5 с.
                if self._wd_attempts == 1 or self._wd_attempts % 10 == 0:
                    print("legion-gateway: heartbeat пропал при ARM — "
                          "DISARM + USB release (сторож kick_age, "
                          f"попытка {self._wd_attempts})", flush=True)
                try:
                    self.handle({"op": "disarm"})
                except Exception as e:
                    print(f"legion-gateway: сторож DISARM: {e}", flush=True)
                try:
                    t = self.fpga._t
                    if hasattr(t, "release"):
                        t.release()
                except Exception as e:
                    print(f"legion-gateway: сторож USB release: {e}", flush=True)

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
            # fs/BW до AIR_PREP: NIOS читает статики в legion_air_up.
            # Нет полей → статики 0 → дефолт 2 МГц (эфир lb_gated).
            fs = msg.get("fs_hz")
            if fs is not None and not self.fpga.set_air_fs_hz(int(fs)):
                return False, "micro: запись AIR_FS_HZ не удалась"
            bw = msg.get("bw_mhz")
            if bw is not None:
                bw_hz = int(round(float(bw) * 1e6))
                if not self.fpga.set_air_bw_hz(bw_hz):
                    return False, "micro: запись AIR_BW_HZ не удалась"
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

    def _detect_legion(self) -> None:
        """Ревизия legion? Чтение target 0x80: на hosted NIOS отвечает
        invalid id (perform_read default → нет SUCCESS, pkt_8x32.c стока),
        на legion — STATUS (legion_reg_read). None = неизвестно (шина/USB)."""
        try:
            ok, _ = self.fpga.read_reg(lf.REG_CTRL)
            self._legion = bool(ok)
        except Exception:
            self._legion = None
        if self._legion is False:
            print("legion-gateway: FPGA отвечает, но 0x80 нет — это hosted, "
                  "не legion (ARM откажет; прошивка — op flash / КАСТОМ FPGA)",
                  flush=True)

    def _flash_validate(self, path: str, action: str) -> tuple[bool, str]:
        """op flash: только артефакт legion этой платы, без ARM, по одному."""
        if action not in ("load", "store"):
            return False, f"flash: неизвестный action {action} (load|store)"
        path = path.strip()
        if not os.path.isabs(path):
            return False, "flash: нужен абсолютный путь на шлюзе — CLI ищет файл от cwd"
        base = os.path.basename(path)
        m = LEGION_RBF_RE.match(base)
        if not m:
            return False, ("flash: имя не артефакт legion (legionx40/xA4/xA9.rbf) — "
                           "hosted/FX3/чужое сюда не шьём")
        size = m.group(1).lower()
        if self.board == "bladerf1" and size != "40":
            return False, "flash: плата bladeRF 1 — нужен legionx40.rbf"
        if self.board == "bladerf2" and size == "40":
            return False, "flash: плата micro — нужен legionxA4/xA9.rbf"
        # A4/A9 по USB PID не различить (оба 0x5250) — size на операторе,
        # как и в docs Nuand («образ A9 на A4 не ставить»).
        if self._armed:
            return False, "flash: сначала DISARM — CLI и агент не делят USB"
        if self._flash.get("running"):
            return False, "flash: уже идёт"
        if not self.fake and not os.path.isfile(path):
            return False, f"flash: файл не найден на шлюзе: {path}"
        return True, ""

    def _flash_run(self, path: str, action: str) -> None:
        """Поток flash: release USB → bladeRF-cli → acquire обратно.
        _op_lock на время CLI не держим: ping живёт, регистровые операции
        при отпущенном USB честно падают (устройство не наше)."""
        log = ""
        ok = False
        try:
            if self.fake:
                time.sleep(0.2)  # протокол без железа: имитация длительности
                ok, log = True, "FAKE flash (не железо)"
                return
            t = self.fpga._t
            if hasattr(t, "release"):
                t.release()
            flag = "-l" if action == "load" else "-L"
            try:
                cp = subprocess.run(["bladeRF-cli", flag, path],
                                    capture_output=True, text=True, timeout=180)
                log = (cp.stdout + cp.stderr).strip()[-800:]
                ok = cp.returncode == 0
            except FileNotFoundError:
                log = "bladeRF-cli не найден на шлюзе"
            except subprocess.TimeoutExpired:
                log = "bladeRF-cli: timeout 180 с"
            time.sleep(0.5)  # re-enumerate после -l (как в _load_fpga)
            try:
                if hasattr(t, "acquire"):
                    t.acquire()
                self._detect_legion()  # после -l в FPGA новая ревизия
            except Exception as e:
                # Неверный size (A9 на A4): FPGA не конфигурируется, acquire
                # честно падает — откат hostedx*.rbf с ноутбука.
                log = f"{log} · re-acquire: {e}".strip(" ·")
                ok = False
        finally:
            self._flash.update({"running": False, "done": True, "ok": ok, "log": log})

    def handle(self, msg: dict) -> dict:
        op = msg.get("op")
        if op == "ping":
            return {"ok": True, "fake": self.fake, "legion": self._legion}
        if op == "flash":
            path = str(msg.get("path") or "")
            action = str(msg.get("action") or "")
            ok, why = self._flash_validate(path, action)
            if not ok:
                return {"ok": False, "reason": why}
            self._flash = {"running": True, "done": False, "ok": False,
                           "log": "", "action": action, "path": path}
            threading.Thread(target=self._flash_run, args=(path, action), daemon=True).start()
            return {"ok": True, "started": True, "reason": f"flash {action}: {path}"}
        if op == "flash_status":
            f = self._flash
            if not f.get("action"):
                return {"ok": False, "reason": "flash не запускался"}
            if f["running"]:
                return {"ok": True, "running": True, "action": f["action"]}
            return {"ok": bool(f["ok"]), "running": False, "done": True,
                    "action": f["action"],
                    "reason": ("bladeRF-cli ok" if f["ok"] else "bladeRF-cli отказ"),
                    "log": f["log"]}
        if op == "arm":
            if self._legion is False:
                # hosted в FPGA: 0x80 не обслуживается — ARM ушёл бы в пустоту.
                return {"ok": False,
                        "reason": "в FPGA нет ревизии legion (0x80 не отвечает, прошит hosted?) — "
                                  "прошивка: op flash или вкладка КАСТОМ FPGA"}
            mode_name = str(msg.get("mode") or "player")
            mode = {"player": lf.MODE_PLAYER, "nco": lf.MODE_NCO,
                    "lb_gated": lf.MODE_LB_GATED, "lb_always": lf.MODE_LB_ALWAYS}.get(mode_name)
            if mode is None:
                return {"ok": False, "reason": f"неизвестный mode {mode_name}"}
            # lb_gated без явного порога = гейт на шум (порог 0). Отказ честно.
            if mode == lf.MODE_LB_GATED and msg.get("det_thr") is None and not self.det_thr_set:
                return {"ok": False, "reason": "lb_gated: сначала det_thr (порог детектора)"}
            if msg.get("det_thr") is not None:
                # Явный порог ниже floor (в т.ч. 0) = гейт на шум. Раньше 0
                # проходил — документация («0 шлюз отвергает») расходилась
                # с кодом; floor по умолчанию 1, поднимается LEGION_DET_THR_FLOOR.
                if mode == lf.MODE_LB_GATED and int(msg["det_thr"]) < DET_THR_FLOOR:
                    return {"ok": False,
                            "reason": f"lb_gated: det_thr {msg['det_thr']} < floor {DET_THR_FLOOR} (гейт на шум)"}
                if not self.fpga.set_detector(int(msg["det_thr"]), int(msg.get("det_shift", 8))):
                    return {"ok": False, "reason": "запись DET_THR не удалась"}
                self.det_thr_set = True
            # Solo fs > 2 МГц: дефолт WD_LIMIT=61 короче kick 500 мс
            # (61×65536/10e6 ≈ 0.40 с на micro). Эфир без fs_hz — не трогаем.
            fs_wd = msg.get("fs_hz")
            if fs_wd is not None:
                limit = lf.watchdog_limit_for_fs(int(fs_wd), self.board)
                if not self.fpga.set_watchdog(limit):
                    return {"ok": False, "reason": "запись WD_LIMIT не удалась"}
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
            if ok:
                self._armed = True
                self._armed_at = time.monotonic()
                self._wd_en = bool(msg.get("wd", True))
                self._wd_attempts = 0
            elif (self._rx_by_us or self._tx_by_us) and not self._armed:
                # Откат ТОЛЬКО если до этого ничего не было армировано: эфир
                # подняли, а ARM не взвёлся — тракт под током не оставляем
                # (на micro PASS-мукс отдал бы DAC статику = несущая LO на
                # усилитель, на x40 — LMS TX под CONTROL битом). При живом
                # предыдущем ARM откат снял бы эфир у него — нельзя.
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
            if ok:
                self._armed = False
                self._armed_at = 0.0
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
            st["legion"] = self._legion
            if st.get("ok") and self.board == "bladerf2":
                # Readback эфира из NIOS (не из HDL-статуса): air_up/freq_set.
                ok2, air = self.fpga.read_reg(lf.REG_AIR_PREP)
                if ok2:
                    st["air_up"] = bool(air & 0x1)
                    st["air_freq_set"] = bool(air & 0x2)
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
                self._legion = None  # пока USB у хоста, ревизия неизвестна
                return {"ok": True, "reason": "USB отпущен (стрим-сервер может занять)"}
            if action == "acquire":
                if hasattr(t, "acquire"):
                    try:
                        t.acquire()
                    except Exception as e:
                        return {"ok": False, "reason": f"USB занять не удалось: {e}"}
                    self._detect_legion()
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
                "air_fs_hz": lf.REG_AIR_FS_HZ, "air_bw_hz": lf.REG_AIR_BW_HZ,
            }
            if reg not in regmap:
                return {"ok": False, "reason": f"неизвестный reg {reg}"}
            # Тот же floor, что в ARM: иначе «set det_thr 0» взводил бы
            # det_thr_set, и lb_gated без det_thr армировался с гейтом на шум.
            if reg == "det_thr" and val < DET_THR_FLOOR:
                return {"ok": False,
                        "reason": f"det_thr {val} < floor {DET_THR_FLOOR} (гейт на шум)"}
            ok = self.fpga.write_reg(regmap[reg], val)
            if ok and reg == "det_thr":
                self.det_thr_set = True
            return {"ok": ok}
        if op == "tune":
            # Прыжок LO на уже поднятом эфире. USB не отпускаем, DISARM нет —
            # player RAM и CTRL.ARM остаются. Только micro (AIR-регистры).
            if self.board != "bladerf2":
                return {"ok": False, "reason": "tune: только bladeRF 2.0 micro (AD9361)"}
            # Без ARM — отказ: иначе hop после watchdog снова жжёт AIR_PREP/TX.
            if not self._armed:
                return {"ok": False, "reason": "tune: нет ARM"}
            freq = msg.get("freq_mhz")
            if freq is None:
                return {"ok": False, "reason": "tune: нужен freq_mhz"}
            if not self.fpga.set_air_freq_mhz(float(freq)):
                return {"ok": False, "reason": "tune: запись AIR_FREQ_KHZ не удалась"}
            fs = msg.get("fs_hz")
            if fs is not None and not self.fpga.set_air_fs_hz(int(fs)):
                return {"ok": False, "reason": "tune: запись AIR_FS_HZ не удалась"}
            bw = msg.get("bw_mhz")
            if bw is not None:
                bw_hz = int(round(float(bw) * 1e6))
                if not self.fpga.set_air_bw_hz(bw_hz):
                    return {"ok": False, "reason": "tune: запись AIR_BW_HZ не удалась"}
            if not self.fpga.air_prepare(True, rx=self._rx_by_us, tx=True):
                return {"ok": False, "reason": "tune: AIR_PREP отказ"}
            return {"ok": True, "reason": f"tune {float(freq):.3f} МГц"}
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
                elif msg.get("op") == "ping":
                    # ping без лока: длинный ARM/сторож не задерживают liveness
                    resp = gw.handle(msg)
                else:
                    # Сериализация операций: xfer — пара write/read 16-байтных
                    # пакетов, её нельзя перемежать с другой командой или
                    # DISARM сторожа (ответ уехал бы не тому).
                    with gw._op_lock:
                        resp = gw.handle(msg)
            except Exception as e:
                resp = {"ok": False, "reason": str(e)}
            self.wfile.write((json.dumps(resp, ensure_ascii=False) + "\n").encode())


class _Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def gateway_cleanup(gw: LegionGateway) -> None:
    """Тихий выход агента (SIGTERM/SIGINT/atexit): DISARM если ARM, затем
    USB release. Факт из wiki Nuand (Troubleshooting): завершение процесса
    без libusb_close на Intel XHCI роняет контроллер («not enough bandwidth
    for altsetting», нужен power-on reset) — поэтому закрываемся явно,
    а не полагаемся на ОС. Идемпотентно: atexit после сигнала повторит. """
    try:
        got = gw._op_lock.acquire(timeout=2.0)
        try:
            if got and gw._armed:
                gw.handle({"op": "disarm"})
        finally:
            if got:
                gw._op_lock.release()
    except Exception as e:
        print(f"legion-gateway: cleanup DISARM: {e}", flush=True)
    try:
        t = gw.fpga._t
        if hasattr(t, "release"):
            t.release()
    except Exception as e:
        print(f"legion-gateway: cleanup USB release: {e}", flush=True)


def main() -> int:
    port = int(os.environ.get("LEGION_FPGA_PORT", "5531"))
    gw = LegionGateway(FAKE)

    def _on_signal(signum, frame) -> None:
        print(f"legion-gateway: сигнал {signum} — DISARM + USB release", flush=True)
        gateway_cleanup(gw)
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, _on_signal)
    signal.signal(signal.SIGINT, _on_signal)
    import atexit
    atexit.register(gateway_cleanup, gw)

    with _Server(("0.0.0.0", port), _Handler) as srv:
        srv.gw = gw  # type: ignore[attr-defined]
        mode = "FAKE (не эфир)" if FAKE else f"USB {gw.board}"
        print(f"legion-gateway: порт {port}, транспорт: {mode}", flush=True)
        srv.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
