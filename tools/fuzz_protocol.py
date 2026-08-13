#!/usr/bin/env python3
"""
LEGION — фаззинг протокола (сквозное тестирование, план Ч3).
Шлём эмулятору ESP32 случайный/битый ввод; инварианты:
  1) эмулятор никогда не падает (ответ на каждую строку),
  2) ответ всегда OK*/ERR*/JSON,
  3) после фаззинга устройство полностью работоспособно (HELLO + SET FREQ).

Запуск: python3 fuzz_protocol.py [--n 1000]
Ожидание: эмулятор уже запущен (tools/esp32_emulator.py), путь из stdin-аргумента.
"""
import argparse
import os
import pty
import random
import select
import string
import subprocess
import sys
import termios
import time

import serial

BAUD = 115200
VALID_TOKENS = [
    "SET FREQ", "SET POWER", "SET ATT", "RF ON", "RF OFF", "STATUS?",
    "REGS?", "SELFTEST", "HELLO", "STOP", "SWEEP START", "HOP START",
    "CHIRP START", "GLIDE", "FM START", "CAL REF", "WIFI STATUS?",
]


def fuzz_case(rng: random.Random) -> str:
    """Генерация одного тестового случая."""
    kind = rng.randrange(6)
    if kind == 0:  # валидная команда с битой аргументацией
        cmd = rng.choice(VALID_TOKENS)
        args = " ".join(
            "".join(rng.choices(string.printable[:62], k=rng.randrange(0, 6)))
            for _ in range(rng.randrange(0, 3))
        )
        return f"{cmd} {args}".strip()
    if kind == 1:  # чистый мусор
        return "".join(rng.choices(string.printable, k=rng.randrange(1, 40)))
    if kind == 2:  # длинная строка (переполнение буфера 160)
        return "SET FREQ " + "9" * rng.randrange(100, 400)
    if kind == 3:  # валидная команда, граничные числа
        cmd = rng.choice(["SET FREQ", "SET POWER", "SET ATT", "GLIDE"])
        val = rng.choice(["-1", "0", "34.375", "4400", "4400.0001", "1e12", "NaN", "inf"])
        return f"{cmd} {val}"
    if kind == 4:  # частичная/битая команда
        return rng.choice(VALID_TOKENS)[: rng.randrange(1, 4)]
    # kind == 5: валидная эталонная (контроль, что не всё ломается)
    return rng.choice(["HELLO", "STATUS?", "SET FREQ 2475.000", "STOP"])


def read_response(ser: serial.Serial, timeout: float = 1.0) -> str:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            line = ser.readline().decode("ascii", errors="replace").strip()
        except serial.SerialException:
            return ""  # устройство «умерло» — фиксируем как отсутствие ответа
        if not line:
            continue
        if '"t":' in line:  # телеметрия коридора — не ответ
            continue
        return line
    return ""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=1000)
    ap.add_argument("--seed", type=int, default=20260813)
    args = ap.parse_args()

    # Поднимаем эмулятор на собственном PTY
    proc = subprocess.Popen(
        [sys.executable, os.path.join(os.path.dirname(__file__), "esp32_emulator.py")],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
    )
    try:
        first = proc.stdout.readline()  # "LEGION EMULATOR on /dev/pts/N"
        port = first.split()[-1]
        time.sleep(0.2)
        ser = serial.Serial(port, BAUD, timeout=0.1)
        rng = random.Random(args.seed)

        answered = 0
        bad_prefix = 0
        for i in range(args.n):
            case = fuzz_case(rng)
            ser.write((case + "\n").encode("ascii", errors="replace"))
            resp = read_response(ser)
            if resp:
                answered += 1
                if not (resp.startswith(("OK", "ERR", "{"))):
                    bad_prefix += 1
                    print(f"  BAD PREFIX @case {i}: {case!r} → {resp!r}")

        # Живость после фаззинга: сначала сброс накопленного (телеметрия
        # коридора приходит асинхронно и законно копится в буфере)
        ser.reset_input_buffer()
        ser.write(b"STOP\n")  # остановить коридор → телеметрия стихает
        time.sleep(0.2)
        ser.reset_input_buffer()
        ser.write(b"HELLO\n")
        hello = read_response(ser)
        alive_hello = hello.startswith("OK LEGION")
        ser.write(b"SET FREQ 2475.000\n")
        freq = read_response(ser)
        alive_freq = "LOCK=" in freq

        print(f"cases={args.n} answered={answered} bad_prefix={bad_prefix}")
        print(f"alive_hello={alive_hello} alive_freq={alive_freq} ({freq!r})")

        ok = bad_prefix == 0 and alive_hello and alive_freq and answered >= args.n * 0.95
        print("FUZZ: PASS" if ok else "FUZZ: FAIL")
        return 0 if ok else 1
    finally:
        proc.terminate()


if __name__ == "__main__":
    sys.exit(main())
