#!/usr/bin/env python3
"""
LEGION — эмулятор прошивки ESP32 (фаза 1) на виртуальном PTY.
Даёт E2E-проверку цепочки ПК → реальный serial → протокол без железа.

Запуск:  python3 esp32_emulator.py
Печатает путь к PTY (напр. /dev/pts/5) — его передаём в legion_cli.py
или выбираем в Tauri-приложении.
"""
import os
import pty
import select
import sys
import termios

VERSION = "0.1.0"
BOARD = "emu"


class Emu:
    def __init__(self) -> None:
        self.freq = 2475.0
        self.power = 5
        self.rf = False

    def handle(self, line: str) -> str:
        t = line.strip()
        u = t.upper()
        if u == "HELLO":
            return f"OK LEGION {VERSION} {BOARD}"
        if u.startswith("SET FREQ"):
            try:
                mhz = float(t.split()[2])
            except (IndexError, ValueError):
                return "ERR SYNTAX bad freq"
            if not 34.375 <= mhz <= 4400:
                return "ERR RANGE 35-4400 MHz"
            self.freq = mhz
            return f"OK FREQ={mhz:.6f} LOCK=1 ERR_HZ=0.0"
        if u.startswith("SET POWER"):
            try:
                p = int(t.split()[2])
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
        if u == "STATUS?":
            import json
            return json.dumps({
                "freq": self.freq, "mode": "MANUAL", "lock": 1,
                "rf": 1 if self.rf else 0, "power": self.power,
                "version": VERSION, "board": BOARD,
            })
        if u == "REGS?":
            return '{"regs":["0x00318000","0x00008011","0x18004fc2","0x00e0000b","0x0083203c","0x00580005"]}'
        if u == "SELFTEST":
            return '{"selftest":{"mux_gnd":1,"mux_dvdd":1,"lock":1,"pass":1}}'
        if u.startswith("CAL REF"):
            return f"OK CAL REF {t.split()[2]} ppm"
        return f"ERR SYNTAX unknown command: {t.split()[0] if t else ''}"


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
