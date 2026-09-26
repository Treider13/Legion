#!/bin/bash
# LEGION FPGA — проверка тулчейна сборки перед build_bladerf.sh.
# Факты-пины: Quartus Prime Lite 23.1.1 (вендоренный README Nuand в
# fpga/vendor/bladerf/hdl/README.md: «version 23.1.1, which the bladeRF
# project files are based upon», путь nios2eds ~/intelFPGA_lite/23.1std),
# bladeRF-cli (прошивка), nios2_command_shell (сборка NIOS BSP).
set -u
FAIL=0

# Тот же выбор, что у сборки (legion_build.rs pick_nios_shell): сначала пин
# 23.1, иначе первая найденная — иначе preflight показывал бы не ту версию.
# Считаем путь ДО проверки Quartus: бинарник лежит рядом с этим деревом,
# а не в PATH. source nios2_command_shell.sh здесь нельзя — скрипт Intel
# делает exec нового login-шелла и выкидывает из сессии, PATH при этом сбрасывается.
NS=$(ls -d "$HOME"/intelFPGA_lite/23.1*/nios2eds/nios2_command_shell.sh 2>/dev/null | head -1)
[ -z "$NS" ] && NS=$(ls "$HOME"/intelFPGA_lite/*/nios2eds/nios2_command_shell.sh 2>/dev/null | head -1)

QUARTUS_SH=""
if [ -n "$NS" ]; then
  QDIR=$(cd "$(dirname "$NS")/../quartus/bin" 2>/dev/null && pwd) || QDIR=""
  if [ -n "$QDIR" ] && [ -x "$QDIR/quartus_sh" ]; then
    QUARTUS_SH="$QDIR/quartus_sh"
  fi
fi
if [ -z "$QUARTUS_SH" ] && command -v quartus_sh >/dev/null 2>&1; then
  QUARTUS_SH=$(command -v quartus_sh)
fi

echo "== Quartus =="
if [ -n "$QUARTUS_SH" ]; then
  VOUT=$("$QUARTUS_SH" --version 2>&1 || true)
  V=$(printf '%s\n' "$VOUT" | grep -oE "Version [0-9]+\.[0-9]+(\.[0-9]+)?" | head -1 | grep -oE "[0-9.]+" || true)
  echo "  найден: $QUARTUS_SH"
  echo "  версия: ${V:-не прочитана}"
  if [ "$V" = "23.1.1" ] || [ "$V" = "23.1" ]; then
    echo "  OK: версия совпадает с пином Nuand (23.1.1, README вендоренного дерева)"
  elif [ -z "$V" ]; then
    echo "  FAIL: quartus_sh не сообщил версию"
    printf '%s\n' "$VOUT" | head -3 | sed 's/^/        /'
    FAIL=1
  else
    echo "  ВНИМАНИЕ: пин Nuand — 23.1.1 (новее/старше — на свой риск: hdl/README.md bladeRF)"
    FAIL=1
  fi
else
  if [ -n "$NS" ]; then
    echo "  FAIL: quartus/bin/quartus_sh нет рядом с $NS и нет в PATH"
    echo "        NIOS уже стоит. Доустановите Quartus Prime Lite 23.1.1 в этот же intelFPGA_lite."
    echo "        source nios2_command_shell.sh не нужен: он делает exec и закрывает сессию."
  else
    echo "  FAIL: quartus_sh не найден (поставьте Quartus Prime Lite 23.1.1, Intel)"
  fi
  FAIL=1
fi

echo "== NIOS II shell =="
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
# systemd зовёт /usr/bin/python3, не venv и не первый python3 в PATH.
# Системный pip на Ubuntu 22.04+ закрыт PEP 668, пакет ставится через apt.
if [ -x /usr/bin/python3 ] && /usr/bin/python3 -c "import usb" >/dev/null 2>&1; then
  echo "  OK: pyusb (/usr/bin/python3)"
elif [ ! -x /usr/bin/python3 ] && command -v python3 >/dev/null 2>&1 && python3 -c "import usb" >/dev/null 2>&1; then
  echo "  OK: pyusb ($(command -v python3))"
else
  USB_ERR=""
  if [ -x /usr/bin/python3 ]; then
    USB_ERR=$(/usr/bin/python3 -c "import usb" 2>&1 | tail -1 || true)
  fi
  if [ -n "$USB_ERR" ]; then
    echo "  FAIL: pyusb нет в /usr/bin/python3 ($USB_ERR)"
  else
    echo "  FAIL: pyusb нет в /usr/bin/python3"
  fi
  echo "        sudo apt install python3-usb"
  FAIL=1
fi

[ "$FAIL" = "0" ] && echo "TOOLCHAIN: OK" || { echo "TOOLCHAIN: пробелы выше"; exit 1; }
