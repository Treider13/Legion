#!/usr/bin/env python3
"""
LEGION — эмулятор прошивки ESP32 на виртуальном PTY.
Фаза 3: + SWEEP/HOP/STOP с телеметрией 10 Гц (JSON с полем "t").

Запуск:  python3 esp32_emulator.py
Печатает путь к PTY (напр. /dev/pts/0) — его передаём в legion_cli.py
или выбираем в Tauri-приложении (поле порта, ручной ввод).
"""
import json
import os
import pty
import select
import sys
import termios
import threading
import time

VERSION = "0.1.0"
BOARD = "emu"


class Corridor:
    """Состояние коридора + поток телеметрии/перестройки."""

    def __init__(self) -> None:
        self.active = False
        self.mode = "SWEEP"
        self.f1 = 2400.0
        self.f2 = 2500.0
        self.step_khz = 1000.0
        self.dwell_ms = 10.0
        self.seed = 1
        self.cur = self.f1
        self._hop = 1
        self.lock = threading.Lock()

    def hop_next(self) -> None:
        # xorshift32 — как в прошивке
        self._hop ^= (self._hop << 13) & 0xFFFFFFFF
        self._hop ^= self._hop >> 17
        self._hop ^= (self._hop << 5) & 0xFFFFFFFF
        self._hop &= 0xFFFFFFFF
        steps = int((self.f2 - self.f1) * 1000 / self.step_khz)
        self.cur = self.f1 + (self._hop % (steps + 1)) * self.step_khz / 1000.0

    def tick(self) -> None:
        with self.lock:
            if self.mode == "SWEEP":
                self.cur += self.step_khz / 1000.0
                if self.cur > self.f2:
                    self.cur = self.f1
            else:
                self.hop_next()


class Emu:
    def __init__(self) -> None:
        self.freq = 2475.0
        self.power = 5
        self.rf = False
        self.corridor = Corridor()

    def handle(self, line: str) -> str:
        t = line.strip()
        u = t.upper()
        parts = t.split()

        if u == "HELLO":
            return f"OK LEGION {VERSION} {BOARD}"
        if u.startswith("SET FREQ"):
            self.corridor.active = False  # ручная команда стопит коридор
            try:
                mhz = float(parts[2])
            except (IndexError, ValueError):
                return "ERR SYNTAX bad freq"
            if not 34.375 <= mhz <= 4400:
                return "ERR RANGE 35-4400 MHz"
            self.freq = mhz
            return f"OK FREQ={mhz:.6f} LOCK=1 ERR_HZ=0.0"
        if u.startswith("SET POWER"):
            try:
                p = int(parts[2])
            except (IndexError, ValueError):
                return "ERR SYNTAX bad power"
            if p not in (-4, -1, 2, 5):
                return "ERR RANGE power -4|-1|+2|+5"
            self.power = p
            return f"OK POWER={p}"
        if u == "RF ON":
            self.rf = True
            return "OK RF ON"
        if u == "RF OFF":
            self.rf = False
            return "OK RF OFF"
        if u.startswith(("SWEEP", "HOP")):
            return self._corridor_cmd(parts, u.startswith("SWEEP"))
        if u == "STOP":
            self.corridor.active = False
            return "OK IDLE"
        if u == "STATUS?":
            mode = self.corridor.mode if self.corridor.active else "MANUAL"
            return json.dumps({
                "freq": self.corridor.cur if self.corridor.active else self.freq,
                "mode": mode, "lock": 1,
                "rf": 1 if self.rf else 0, "power": self.power,
                "version": VERSION, "board": BOARD,
            })
        if u == "REGS?":
            return '{"regs":["0x00318000","0x00008011","0x18004fc2","0x00e0000b","0x0083203c","0x00580005"]}'
        if u == "SELFTEST":
            return '{"selftest":{"mux_gnd":1,"mux_dvdd":1,"lock":1,"pass":1}}'
        if u.startswith("CAL REF"):
            return f"OK CAL REF {parts[2]} ppm"
        return f"ERR SYNTAX unknown command: {parts[0] if parts else ''}"

    def _corridor_cmd(self, parts: list, is_sweep: bool) -> str:
        if len(parts) < 2:
            return "ERR SYNTAX START|STOP expected"
        if parts[1].upper() == "STOP":
            self.corridor.active = False
            return "OK IDLE"
        if parts[1].upper() != "START":
            return "ERR SYNTAX START|STOP expected"
        try:
            f1 = float(parts[2])
            f2 = float(parts[3])
        except (IndexError, ValueError):
            return "ERR SYNTAX f1 f2 required"
        if not (34.375 <= f1 < f2 <= 4400):
            return "ERR RANGE corridor"

        c = self.corridor
        c.mode = "SWEEP" if is_sweep else "HOP"
        c.f1, c.f2 = f1, f2
        c.step_khz = 1000.0
        c.dwell_ms = 10.0
        c.seed = 1
        # именованные параметры STEP/DWELL/RATE/SEED
        kv = parts[4:]
        for i in range(0, len(kv) - 1, 2):
            key, val = kv[i].upper(), kv[i + 1]
            if key == "STEP":
                c.step_khz = float(val)
            elif key in ("DWELL", "RATE"):
                c.dwell_ms = float(val)
            elif key == "SEED":
                c.seed = int(val)
        if c.dwell_ms < 1:
            return "ERR DWELL min 1 ms"
        c.cur = f1
        c._hop = c.seed or 0x9E3779B9
        c.active = True
        return f"OK {c.mode} RUNNING"


def telemetry_loop(emu: Emu, master: int) -> None:
    """10 Гц телеметрия, пока коридор активен; перестройка по dwell."""
    last_step = time.monotonic()
    while True:
        time.sleep(0.01)
        c = emu.corridor
        if not c.active:
            last_step = time.monotonic()
            continue
        now = time.monotonic()
        if (now - last_step) * 1000.0 >= c.dwell_ms:
            c.tick()
            last_step = now
        msg = json.dumps({
            "t": int(now * 1000) & 0xFFFFFFFF,
            "freq": round(c.cur, 6),
            "lock": 1,
            "mode": c.mode,
        })
        try:
            os.write(master, (msg + "\n").encode("ascii"))
        except OSError:
            return
        time.sleep(0.09)


def main() -> int:
    master, slave = pty.openpty()
    # RAW-режим на slave: иначе line discipline эхом возвращает команды
    # и ломает протокол (проверено: ECHO порождал фантомную команду "ERR")
    attrs = termios.tcgetattr(slave)
    attrs[0] = 0  # iflag
    attrs[1] = 0  # oflag
    attrs[3] = 0  # lflag: без ECHO/ICANON
    termios.tcsetattr(slave, termios.TCSANOW, attrs)
    slave_name = os.ttyname(slave)
    print(f"LEGION EMULATOR on {slave_name}", flush=True)

    emu = Emu()
    threading.Thread(target=telemetry_loop, args=(emu, master), daemon=True).start()

    buf = b""
    os.write(master, b"LEGION READY\n")
    while True:
        r, _, _ = select.select([master], [], [], 1.0)
        if not r:
            continue
        try:
            chunk = os.read(master, 1024)
        except OSError:
            break
        if not chunk:
            break
        buf += chunk
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            cmd = line.decode("ascii", errors="replace").strip("\r")
            if cmd:
                resp = emu.handle(cmd)
                os.write(master, (resp + "\n").encode("ascii"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
