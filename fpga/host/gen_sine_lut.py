#!/usr/bin/env python3
"""Генератор quarter-sine LUT для legion_nco.vhd (256×12).

Печатает VHDL-агрегат. Значения: round(2047 * sin(pi*k/512)), k=0..255.
Тестбенч legion_nco_tb.vhd проверяет форму независимо (math_real).
"""
import math

def main() -> None:
    vals = [round(2047 * math.sin(math.pi * k / 512)) for k in range(256)]
    lines = []
    for row in range(32):
        chunk = ", ".join(f'12x"{v:03X}"' for v in vals[row * 8:(row + 1) * 8])
        lines.append(f"        {chunk},")
    print("\n".join(lines))

if __name__ == "__main__":
    main()
