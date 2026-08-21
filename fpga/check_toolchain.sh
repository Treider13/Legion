#!/bin/bash
# LEGION FPGA — проверка тулчейна сборки перед build_bladerf.sh.
# Факты-пины: Quartus Prime Lite 20.1.1 (README Nuand для bladeRF 1/NIOS II),
# bladeRF-cli (прошивка), nios2_command_shell (сборка NIOS BSP).
set -u
FAIL=0

echo "== Quartus =="
if command -v quartus_sh >/dev/null 2>&1; then
  V=$(quartus_sh --version 2>/dev/null | grep -oE "Version [0-9]+\.[0-9]+(\.[0-9]+)?" | head -1 | grep -oE "[0-9.]+")
  echo "  найден: $V"
  if [ "$V" = "20.1.1" ] || [ "$V" = "20.1" ]; then
    echo "  OK: версия совпадает с пином Nuand (20.1.1)"
  else
    echo "  ВНИМАНИЕ: пин Nuand — 20.1.1 (новее/старше — на свой риск: README bladeRF)"
    FAIL=1
  fi
else
  echo "  FAIL: quartus_sh не найден (поставьте Quartus Prime Lite 20.1.1, Intel)"
  FAIL=1
fi

echo "== NIOS II shell =="
NS=$(ls "$HOME"/intelFPGA_lite/*/nios2eds/nios2_command_shell.sh 2>/dev/null | head -1)
if [ -n "$NS" ]; then
  echo "  OK: $NS"
else
  echo "  FAIL: nios2_command_shell.sh не найден (~/intelFPGA_lite/*/nios2eds/)"
  FAIL=1
fi

echo "== bladeRF-cli =="
if command -v bladeRF-cli >/dev/null 2>&1; then
  echo "  OK: $(bladeRF-cli --version 2>/dev/null | head -1)"
else
  echo "  FAIL: bladeRF-cli не найден (host/tools Nuand)"
  FAIL=1
fi

echo "== Python (шлюз/приёмка) =="
python3 -c "import usb" 2>/dev/null && echo "  OK: pyusb" || { echo "  FAIL: pyusb (pip install -r fpga/requirements.txt)"; FAIL=1; }

[ "$FAIL" = "0" ] && echo "TOOLCHAIN: OK" || { echo "TOOLCHAIN: пробелы выше"; exit 1; }
