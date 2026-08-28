#!/bin/bash
# LEGION FPGA — проверка тулчейна сборки перед build_bladerf.sh.
# Факты-пины: Quartus Prime Lite 23.1.1 (вендоренный README Nuand в
# fpga/vendor/bladerf/hdl/README.md: «version 23.1.1, which the bladeRF
# project files are based upon», путь nios2eds ~/intelFPGA_lite/23.1std),
# bladeRF-cli (прошивка), nios2_command_shell (сборка NIOS BSP).
set -u
FAIL=0

echo "== Quartus =="
if command -v quartus_sh >/dev/null 2>&1; then
  V=$(quartus_sh --version 2>/dev/null | grep -oE "Version [0-9]+\.[0-9]+(\.[0-9]+)?" | head -1 | grep -oE "[0-9.]+")
  echo "  найден: $V"
  if [ "$V" = "23.1.1" ] || [ "$V" = "23.1" ]; then
    echo "  OK: версия совпадает с пином Nuand (23.1.1, README вендоренного дерева)"
  else
    echo "  ВНИМАНИЕ: пин Nuand — 23.1.1 (новее/старше — на свой риск: hdl/README.md bladeRF)"
    FAIL=1
  fi
else
  echo "  FAIL: quartus_sh не найден (поставьте Quartus Prime Lite 23.1.1, Intel)"
  FAIL=1
fi

echo "== NIOS II shell =="
# Тот же выбор, что у сборки (legion_build.rs pick_nios_shell): сначала пин
# 23.1, иначе первая найденная — иначе preflight показывал бы не ту версию.
NS=$(ls -d "$HOME"/intelFPGA_lite/23.1*/nios2eds/nios2_command_shell.sh 2>/dev/null | head -1)
[ -z "$NS" ] && NS=$(ls "$HOME"/intelFPGA_lite/*/nios2eds/nios2_command_shell.sh 2>/dev/null | head -1)
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
