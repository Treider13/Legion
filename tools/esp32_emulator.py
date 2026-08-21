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
        self.fm_depth_khz = 100.0
        self._glide_start = 0.0
        self._fm_start = time.monotonic()
        self.lock = threading.Lock()

    def hop_next(self) -> None:
        # xorshift32 — как в прошивке
        self._hop ^= (self._hop << 13) & 0xFFFFFFFF
        self._hop ^= self._hop >> 17
        self._hop ^= (self._hop << 5) & 0xFFFFFFFF
        self._hop &= 0xFFFFFFFF
        steps = int((self.f2 - self.f1) * 1000 / self.step_khz)
        self.cur = self.f1 + (self._hop % (steps + 1)) * self.step_khz / 1000.0

    def tick(self) -> str | None:
        """Один шаг движка. Возвращает имя события (GLIDE DONE) или None."""
        import math
        import random
        with self.lock:
            if self.mode in ("SWEEP", "CHIRP"):
                self.cur += self.step_khz / 1000.0
                if self.cur > self.f2:
                    self.cur = self.f1
            elif self.mode == "HOP":
                self.hop_next()
            elif self.mode == "GLIDE":
                # линейная интерполяция за dwell_ms, авто-стоп в конце
                elapsed = time.monotonic() - self._glide_start
                k = min(1.0, elapsed * 1000.0 / self.dwell_ms)
                self.cur = self.f1 + (self.f2 - self.f1) * k
                if k >= 1.0:
                    self.active = False
                    return "GLIDE DONE"  # как прошивка: событие при завершении
            elif self.mode.startswith("FM_"):
                # Фаза от реального времени: прошивка крутит LFO с периодом
                # dwell_ms (тик 1 мс). Раньше фаза росла на dwell/100 за тик —
                # эмулятор был в ~100× медленнее железа (аудит №21).
                period = max(self.dwell_ms, 1.0)
                t_ms = (time.monotonic() - self._fm_start) * 1000.0
                phase = (t_ms % period) / period
                if self.mode == "FM_SIN":
                    dev = math.sin(2 * math.pi * phase)
                elif self.mode == "FM_TRI":
                    dev = phase * 4 - 1 if phase < 0.5 else 3 - phase * 4
                else:
                    dev = random.uniform(-1, 1)
                self.cur = self.f1 + dev * self.fm_depth_khz / 1000.0
        return None


class Emu:
    def __init__(self) -> None:
        self.freq = 2475.0
        self.power = 5
        self.rf = False
        self.corridor = Corridor()
        self.allow: list[tuple[float, float]] = []
        self.load_ok = True
        self.pa_ma = 0
        self.pa_on = False
        # Выравнивание уровня (фаза 10) — как в прошивке/моке
        self.level_pts: list[tuple[float, float]] = []
        self.level_on = False
        self.level_target = 0.0

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
                return "ERR RANGE 34.375-4400 MHz"
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
        if u.startswith("SET ATT"):
            try:
                db = float(parts[2])
            except (IndexError, ValueError):
                return "ERR SYNTAX bad att"
            if not 0.0 <= db <= 31.75:
                return "ERR RANGE att 0-31.75"
            actual = round(db / 0.25) * 0.25
            return f"OK ATT={actual:.2f} dB"
        if u == "RF ON":
            if not self.load_ok:
                return "ERR LOAD dummy load required"
            if self.allow and not any(a <= self.freq <= b for a, b in self.allow):
                return "ERR ALLOW frequency not in allowlist"
            self.rf = True
            return "OK RF ON"
        if u == "RF OFF":
            self.rf = False
            return "OK RF OFF"
        if u.startswith(("SWEEP", "HOP", "CHIRP")):
            mode = "SWEEP" if u.startswith("SWEEP") else ("HOP" if u.startswith("HOP") else "CHIRP")
            return self._corridor_cmd(parts, mode)
        if u.startswith("GLIDE"):
            return self._glide_cmd(parts)
        if u.startswith("FM"):
            return self._fm_cmd(parts)
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
                "load": 1 if self.load_ok else 0,
                "pa": 1 if self.pa_on else 0,
                "pa_ma": self.pa_ma,
                "allow_n": len(self.allow),
            })
        if u == "REGS?":
            return '{"regs":["0x00318000","0x00008011","0x18004fc2","0x00e0000b","0x0083203c","0x00580005"]}'
        if u == "SELFTEST":
            return '{"selftest":{"mux_gnd":1,"mux_dvdd":1,"lock":1,"pass":1}}'
        if u.startswith("CAL REF"):
            if len(parts) < 3:
                return "ERR SYNTAX cal ppm required"
            try:
                float(parts[2])
            except ValueError:
                return "ERR SYNTAX bad ppm"
            return f"OK CAL REF {parts[2]} ppm"
        if u.startswith("SET LEVEL"):
            # SET LEVEL <dBm> | OFF — авто-выравнивание через PE43702 (фаза 10)
            if len(parts) < 3:
                return "ERR SYNTAX SET LEVEL <dBm>|OFF"
            if parts[2].upper() == "OFF":
                self.level_on = False
                return "OK LEVEL OFF"
            try:
                self.level_target = float(parts[2])
            except ValueError:
                return "ERR SYNTAX bad level dBm"
            self.level_on = True
            if self.level_pts:
                return f"OK LEVEL={self.level_target:.2f} ATT=0.00 dB"
            return f"OK LEVEL={self.level_target:.2f} (no cal - add points via CAL LEVEL)"
        if u.startswith("CAL LEVEL"):
            # CAL LEVEL <freqMHz> <dBm> | CLEAR
            if len(parts) >= 3 and parts[2].upper() == "CLEAR":
                self.level_pts = []
                return "OK CAL LEVEL CLEAR n=0"
            try:
                f = float(parts[2])
                dbm = float(parts[3])
            except (IndexError, ValueError):
                return "ERR SYNTAX CAL LEVEL <freqMHz> <dBm>|CLEAR"
            if f <= 0:
                return "ERR SYNTAX CAL LEVEL <freqMHz> <dBm>|CLEAR"
            self.level_pts = [(pf, pd) for pf, pd in self.level_pts if abs(pf - f) > 1e-6]
            self.level_pts.append((f, dbm))
            self.level_pts.sort()
            return f"OK CAL LEVEL {f:.3f} {dbm:.2f} n={len(self.level_pts)}"
        if u == "LEVEL?":
            return json.dumps({
                "enabled": 1 if self.level_on else 0,
                "target": self.level_target,
                "points": [[f, d] for f, d in self.level_pts],
            })
        if u.startswith("REGS DIFF"):
            # REGS DIFF <r0..r5 hex> — xor против статических регистров REGS?
            words = parts[2:]
            if len(words) < 6:
                return "ERR SYNTAX regs diff needs 6 hex words"
            try:
                mine = [int(r, 16) for r in
                        ("0x00318000", "0x00008011", "0x18004fc2",
                         "0x00e0000b", "0x0083203c", "0x00580005")]
                theirs = [int(w, 16) for w in words[:6]]
            except ValueError:
                return "ERR SYNTAX regs diff needs 6 hex words"
            return json.dumps({"diff": [
                {"r": i, "xor": f"0x{m ^ t:08X}"} for i, (m, t) in enumerate(zip(mine, theirs))
            ]})
        if u.startswith("WIFI"):
            if u == "WIFI STATUS?":
                return '{"wifi":{"mode":"AP","ip":"192.168.4.1","ssid":"LEGION"}}'
            if u.startswith("WIFI AP"):
                return "OK WIFI AP ip=192.168.4.1"
            if u.startswith("WIFI STA"):
                return "OK WIFI STA connecting"
            return "ERR SYNTAX WIFI AP|STA|STATUS?"
        if u.startswith("ALLOW") or u == "ALLOW?":
            return self._allow_cmd(parts, u)
        if u.startswith("LOAD") or u == "LOAD?":
            return self._load_cmd(u)
        if u.startswith("PA") or u == "PA?":
            return self._pa_cmd(parts, u)
        if u.startswith("CUE"):
            return self._cue_cmd(parts)
        return f"ERR SYNTAX unknown command: {parts[0] if parts else ''}"

    def _corridor_cmd(self, parts: list, mode: str) -> str:
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
        if self.allow and not any(a <= f1 and f2 <= b for a, b in self.allow):
            return "ERR ALLOW corridor outside allowlist"

        c = self.corridor
        c.mode = mode
        c.f1, c.f2 = f1, f2
        # SWEEP/HOP: STEP в кГц; CHIRP: STEP в Гц (как прошивка)
        c.step_khz = 100.0 if mode == "CHIRP" else 1000.0
        c.dwell_ms = 10.0
        c.seed = 1
        kv = parts[4:]
        for i in range(0, len(kv) - 1, 2):
            key, val = kv[i].upper(), kv[i + 1]
            try:  # фаззинг-устойчивость: битые значения игнорируем
                if key == "STEP":
                    # CHIRP: val в Гц → кГц; SWEEP/HOP: val уже в кГц
                    c.step_khz = float(val) / 1000.0 if mode == "CHIRP" else float(val)
                elif key in ("DWELL", "RATE"):
                    c.dwell_ms = float(val)
                elif key == "SEED":
                    c.seed = int(val)
            except (ValueError, OverflowError):
                continue
        if c.dwell_ms < 1:
            return "ERR DWELL min 1 ms"
        c.cur = f1
        c._hop = c.seed or 0x9E3779B9
        c.active = True
        return f"OK {c.mode} RUNNING"

    def _glide_cmd(self, parts: list) -> str:
        try:
            target = float(parts[1])
            duration = float(parts[2])
        except (IndexError, ValueError):
            return "ERR SYNTAX GLIDE <targetMHz> <durationMs>"
        if not 34.375 <= target <= 4400:
            return "ERR RANGE f2"
        c = self.corridor
        c.mode = "GLIDE"
        c.f1 = c.cur if c.active else self.freq
        c.f2 = target
        c.dwell_ms = max(1.0, duration)
        c._glide_start = time.monotonic()
        c.active = True
        return f"OK GLIDE RUNNING {c.f1:.6f} -> {target:.6f}"

    def _fm_cmd(self, parts: list) -> str:
        if len(parts) >= 2 and parts[1].upper() == "STOP":
            self.corridor.active = False
            return "OK IDLE"
        if len(parts) < 3 or parts[1].upper() != "START":
            return "ERR SYNTAX FM START|STOP"
        shape = parts[2].upper()
        if shape not in ("SIN", "TRI", "RAND"):
            shape = "SIN"
        c = self.corridor
        c.mode = f"FM_{shape}"
        c.f1 = self.freq
        c.fm_depth_khz = 100.0
        c.dwell_ms = 100.0
        c._fm_start = time.monotonic()
        kv = parts[3:]
        for i in range(0, len(kv) - 1, 2):
            key, val = kv[i].upper(), kv[i + 1]
            try:  # фаззинг-устойчивость
                if key == "CENTER":
                    c.f1 = float(val)
                elif key == "DEPTH":
                    c.fm_depth_khz = float(val)
                elif key == "RATE":
                    c.dwell_ms = float(val)
            except (ValueError, OverflowError):
                continue
        c.active = True
        return f"OK FM RUNNING {shape}"

    def _allow_cmd(self, parts: list, u: str) -> str:
        sub = (parts[1].upper() if len(parts) > 1 else "?") if u != "ALLOW?" else "?"
        if u == "ALLOW?" or sub == "?":
            return json.dumps({"n": len(self.allow), "allow": [list(x) for x in self.allow]})
        if sub == "CLEAR":
            self.allow = []
            return "OK ALLOW n=0"
        if sub != "ADD" or len(parts) < 4:
            return "ERR SYNTAX ALLOW ADD|CLEAR|?"
        try:
            f1, f2 = float(parts[2]), float(parts[3])
        except ValueError:
            return "ERR SYNTAX ALLOW ADD <f1MHz> <f2MHz>"
        if not (34.375 <= f1 <= f2 <= 4400):
            return "ERR RANGE allow 34.375-4400 MHz"
        if len(self.allow) >= 8:
            return "ERR RANGE allow table full"
        self.allow.append((f1, f2))
        return f"OK ALLOW n={len(self.allow)}"

    def _load_cmd(self, u: str) -> str:
        if u == "LOAD?" or u.endswith(" ?"):
            return json.dumps({"load": 1 if self.load_ok else 0})
        if u == "LOAD OK":
            self.load_ok = True
            return "OK LOAD OK"
        if u == "LOAD FAULT":
            self.load_ok = False
            self.pa_on = False
            self.rf = False
            return "OK LOAD FAULT"
        return "ERR SYNTAX LOAD OK|FAULT|?"

    def _pa_cmd(self, parts: list, u: str) -> str:
        sub = (parts[1].upper() if len(parts) > 1 else "?") if u != "PA?" else "?"
        if u == "PA?" or sub == "?":
            return json.dumps({"pa": 1 if self.pa_on else 0, "ma": self.pa_ma})
        if sub == "ON":
            if not self.load_ok:
                return "ERR LOAD dummy load required"
            if self.pa_ma == 0:
                return "ERR RANGE PA current"
            self.pa_on = True
            return f"OK PA ON I={self.pa_ma}"
        if sub == "OFF":
            self.pa_on = False
            return "OK PA OFF"
        if sub == "SET" and len(parts) >= 4 and parts[2].upper() == "I":
            try:
                ma = int(parts[3])
            except ValueError:
                return "ERR SYNTAX PA SET I <mA>"
            if not 0 <= ma <= 1500:
                return "ERR RANGE PA current 0-1500 mA"
            self.pa_ma = ma
            if ma == 0:
                self.pa_on = False
            return f"OK PA I={ma}"
        return "ERR SYNTAX PA SET|ON|OFF|?"

    def _cue_cmd(self, parts: list) -> str:
        try:
            mhz = float(parts[1])
        except (IndexError, ValueError):
            return "ERR SYNTAX bad freq"
        if not self.allow or not any(a <= mhz <= b for a, b in self.allow):
            return "ERR ALLOW cue requires allowlist hit"
        if not 34.375 <= mhz <= 4400:
            return "ERR RANGE 34.375-4400 MHz"
        self.corridor.active = False
        self.freq = mhz
        return f"OK CUE FREQ={mhz:.6f} LOCK=1"


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
        # FM: dwell_ms — период LFO, а не темп шага; прошивка тикает FM каждые
        # 1 мс. Тикать раз в период = алиасинг (фаза застынет на телеметрии).
        step_ms = 10.0 if c.mode.startswith("FM_") else c.dwell_ms
        if (now - last_step) * 1000.0 >= step_ms:
            ev = c.tick()
            if ev:  # GLIDE DONE и т.п. — как прошивка: событие отдельной строкой
                try:
                    os.write(master, (json.dumps({"t": 0, "event": ev}) + "\n").encode("ascii"))
                except OSError:
                    return
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
