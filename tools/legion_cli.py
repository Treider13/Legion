#!/usr/bin/env python3
"""
LEGION CLI — управление генератором ПК → ESP32 → ADF4351 по USB-UART.

Фаза 0: каркас (подключение, отправка команд, чтение ответов).
Эталон расчёта регистров для кросс-проверки: pyadf435x (github.com/jhol/pyadf435x).

Использование:
    python3 legion_cli.py --port /dev/ttyUSB0 --cmd "SET FREQ 2475.000"
    python3 legion_cli.py --port /dev/ttyACM0 --cmd "STATUS?"
    python3 legion_cli.py --list
"""
import argparse
import sys
import time

try:
    import serial
    from serial.tools import list_ports
except ImportError:
    sys.exit("pyserial не установлен: pip3 install pyserial")

BAUD = 115200
CMD_TERMINATOR = "\n"
RESP_TIMEOUT_S = 2.0


def list_available_ports() -> None:
    for p in list_ports.comports():
        print(f"{p.device}\t{p.description}")


def send_command(port: str, cmd: str) -> int:
    with serial.Serial(port, BAUD, timeout=RESP_TIMEOUT_S) as ser:
        # Сбросить возможный мусор в буфере после открытия порта
        ser.reset_input_buffer()
        ser.write((cmd + CMD_TERMINATOR).encode("ascii"))
        deadline = time.monotonic() + RESP_TIMEOUT_S
        while time.monotonic() < deadline:
            line = ser.readline().decode("ascii", errors="replace").strip()
            if line:
                print(line)
                if line.startswith(("OK", "ERR", "{")):
                    return 0
        print("ERR TIMEOUT", file=sys.stderr)
        return 1


def main() -> int:
    ap = argparse.ArgumentParser(description="LEGION CLI (ПК → ESP32 → ADF4351)")
    ap.add_argument("--port", help="Serial-порт (напр. /dev/ttyUSB0, COM5)")
    ap.add_argument("--cmd", help="Команда протокола LEGION")
    ap.add_argument("--list", action="store_true", help="Список портов")
    args = ap.parse_args()

    if args.list:
        list_available_ports()
        return 0
    if not args.port or not args.cmd:
        ap.error("нужны --port и --cmd (или --list)")
    return send_command(args.port, args.cmd)


if __name__ == "__main__":
    sys.exit(main())
