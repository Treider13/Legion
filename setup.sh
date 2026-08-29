#!/bin/bash
# LEGION — проверка окружения стенда (Ubuntu 22.04/24.04).
# Без аргументов: только проверка с понятными подсказками.
# С --install: попытка доустановить недостающее (apt/pip/npm, с sudo).
# Код возврата: 0 — всё обязательное на месте; 1 — есть пробелы.
set -u
cd "$(dirname "$0")"

INSTALL=0
[ "${1:-}" = "--install" ] && INSTALL=1
FAIL=0

ok()   { echo "  OK: $1"; }
miss() { echo "  FAIL: $1"; FAIL=1; }
warn() { echo "  ВНИМАНИЕ: $1"; }

maybe() { # maybe <описание> <команда...>
  if [ "$INSTALL" = "1" ]; then
    echo "  … ставлю: $1"
    shift
    "$@" || true
  fi
}

echo "== Python =="
if command -v python3 >/dev/null; then
  ok "python3 $(python3 --version 2>&1 | awk '{print $2}')"
else
  miss "python3 — sudo apt install python3 python3-venv python3-pip"
  maybe "python3" sudo apt install -y python3 python3-venv python3-pip
fi

# venv проекта: если есть — проверяем пакеты в нём, иначе предлагаем создать.
PY=python3
if [ -f .venv/bin/activate ]; then
  # shellcheck disable=SC1091
  . .venv/bin/activate
  PY=python
  ok "venv .venv активирован"
else
  warn "venv не создан — python3 -m venv .venv && source .venv/bin/activate && pip install -r tools/requirements.txt -r fpga/requirements.txt"
  if [ "$INSTALL" = "1" ]; then
    python3 -m venv .venv && . .venv/bin/activate && PY=python && ok "venv .venv создан"
  fi
fi

$PY -c "import numpy" 2>/dev/null && ok "numpy (сканер эфира)" \
  || { miss "numpy — pip install -r tools/requirements.txt"; maybe "numpy" $PY -m pip install -r tools/requirements.txt; }
$PY -c "import serial" 2>/dev/null && ok "pyserial (CLI/эмулятор ESP32)" \
  || { miss "pyserial — pip install -r tools/requirements.txt"; maybe "pyserial" $PY -m pip install -r tools/requirements.txt; }
$PY -c "import usb" 2>/dev/null && ok "pyusb (агент шлюза FPGA)" \
  || { miss "pyusb — pip install -r fpga/requirements.txt"; maybe "pyusb" $PY -m pip install -r fpga/requirements.txt; }

echo "== bladeRF =="
if command -v bladeRF-cli >/dev/null; then
  ok "bladeRF-cli $(bladeRF-cli --version 2>/dev/null | head -1 | awk '{print $2}')"
else
  miss "bladeRF-cli — sudo apt install bladerf (или сборка Nuand/bladeRF, host)"
  maybe "bladerf" sudo apt install -y bladerf libbladerf-dev
fi

echo "== SoapySDR (сканер/стримы; pip не подходит — только системный биндинг) =="
if $PY -c "import SoapySDR" 2>/dev/null; then
  ok "python3-soapysdr"
else
  miss "python3-soapysdr — sudo apt install python3-soapysdr soapysdr-tools"
  maybe "soapysdr" sudo apt install -y python3-soapysdr soapysdr-tools
fi
# Модуль bladerf: --info перечисляет фабрики (модули) без железа; --find без
# подключённой платы показал бы пусто даже при установленном модуле.
if command -v SoapySDRUtil >/dev/null && SoapySDRUtil --info 2>/dev/null | grep -qi bladerf; then
  ok "soapysdr-module-bladerf"
else
  miss "soapysdr-module-bladerf — sudo apt install soapysdr-module-bladerf"
  maybe "soapysdr-module-bladerf" sudo apt install -y soapysdr-module-bladerf
fi

echo "== Node.js (приложение LEGION Control) =="
if command -v node >/dev/null; then
  NV=$(node --version | sed 's/v//;s/\..*//')
  if [ "$NV" -ge 20 ]; then ok "node $(node --version)"; else
    miss "node $(node --version) — нужен ≥ 20 (NodeSource/nvm, см. INSTALL.md)"
  fi
else
  miss "node — sudo apt install nodejs npm (≥ 20; иначе NodeSource/nvm)"
  maybe "nodejs" sudo apt install -y nodejs npm
fi
if [ -d app/node_modules ]; then
  ok "app/node_modules (npm ci уже сделан)"
else
  warn "app/node_modules нет — cd app && npm ci"
  if [ "$INSTALL" = "1" ] && command -v npm >/dev/null; then
    (cd app && npm ci) && ok "app: npm ci"
  fi
fi

echo "== Rust (только для desktop-сборки Tauri; браузерная работает без него) =="
if command -v cargo >/dev/null 2>&1; then
  ok "cargo $(cargo --version 2>/dev/null | awk '{print $2}')"
else
  warn "cargo не найден — нужен только для npm run tauri dev/build (rustup.rs, INSTALL.md §3)"
fi

echo "== Тракт ESP32 (опционально, режим 2) =="
if $PY -m platformio --version >/dev/null 2>&1; then
  ok "platformio $($PY -m platformio --version 2>/dev/null)"
else
  warn "platformio не найден (нужен только для ESP32) — pip install platformio"
  maybe "platformio" $PY -m pip install platformio
fi

echo "== Quartus (только для сборки образа FPGA legion) =="
if command -v quartus_sh >/dev/null 2>&1; then
  ok "quartus $(quartus_sh --version 2>/dev/null | grep -oE 'Version [0-9.]+' | head -1)"
else
  warn "Quartus Prime Lite 23.1.1 не найден — нужен только для сборки legionxA4.rbf (INSTALL.md §5)"
fi

echo
if [ "$FAIL" = "0" ]; then
  echo "ОКРУЖЕНИЕ: OK — дальше: шлюз (INSTALL.md §4), образ legion (§5), приёмка (§6)"
else
  echo "ОКРУЖЕНИЕ: пробелы выше. Подробности — INSTALL.md; автодоустановка: ./setup.sh --install"
  exit 1
fi
