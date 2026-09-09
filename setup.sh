#!/bin/bash
# LEGION — проверка окружения стенда (Ubuntu 22.04/24.04).
# Без аргументов: только проверка с понятными подсказками.
# С --install: попытка доустановить недостающее (apt/pip/npm, с sudo).
# С --info: та же проверка, но справочно — ничего не «фейлится», код всегда 0
# (для отчётов о проблемах: «пришлите вывод setup.sh --info»).
# Код возврата: 0 — всё обязательное на месте (или --info); 1 — есть пробелы.
set -u
cd "$(dirname "$0")" || { echo "FAIL: не удалось перейти в каталог скрипта" >&2; exit 2; }

INSTALL=0
INFO=0
[ "${1:-}" = "--install" ] && INSTALL=1
[ "${1:-}" = "--info" ] && INFO=1
FAIL=0

ok()   { echo "  OK: $1"; }
miss() { if [ "$INFO" = "1" ]; then echo "  нет: $1"; else echo "  FAIL: $1"; FAIL=1; fi; }
warn() { echo "  ВНИМАНИЕ: $1"; }

maybe() { # maybe <описание> <команда...>
  if [ "$INSTALL" = "1" ]; then
    echo "  … ставлю: $1"
    shift
    "$@" || true
  fi
}

udev_rules_present() { # правила Nuand в любом из двух каталогов (без ls|grep)
  local f
  for f in /etc/udev/rules.d/*[Nn]uand* /lib/udev/rules.d/*[Nn]uand*; do
    [ -e "$f" ] && return 0
  done
  return 1
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
  warn "venv не создан — python3 -m venv --system-site-packages .venv && source .venv/bin/activate && pip install -r tools/requirements.txt -r fpga/requirements.txt"
  if [ "$INSTALL" = "1" ]; then
    python3 -m venv --system-site-packages .venv && . .venv/bin/activate && PY=python && ok "venv .venv создан"
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

# udev-правила Nuand: без них плата видна только под root (INSTALL.md §1).
if udev_rules_present; then
  ok "udev-правила Nuand (USB без root)"
else
  miss "udev-правила Nuand — без них плата только под root (INSTALL.md §1, udev)"
  if [ "$INSTALL" = "1" ]; then
    # Правила приезжают с пакетом bladerf/libbladerf2 — переустановка + trigger.
    sudo apt install -y --reinstall bladerf 2>/dev/null || true
    sudo udevadm control --reload 2>/dev/null && sudo udevadm trigger 2>/dev/null || true
    if udev_rules_present; then
      ok "udev-правила Nuand появились после переустановки пакета"
    else
      warn "udev-правил всё ещё нет — возьмите шаблоны из дерева Nuand (INSTALL.md §1)"
    fi
  fi
fi

echo "== SoapySDR (сканер/стримы; pip не подходит — только системный биндинг) =="
if $PY -c "import SoapySDR" 2>/dev/null; then
  ok "python3-soapysdr"
elif /usr/bin/python3 -c "import SoapySDR" 2>/dev/null; then
  ok "python3-soapysdr в /usr/bin/python3 (этот venv/python его не видит)"
  warn "пересоздайте venv: python3 -m venv --system-site-packages .venv  или  LEGION_PYTHON=/usr/bin/python3"
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
NODE_OK=0
if command -v node >/dev/null; then
  NV=$(node --version | sed 's/v//;s/\..*//')
  if [ "$NV" -ge 20 ]; then
    ok "node $(node --version)"
    NODE_OK=1
  fi
fi
if [ "$NODE_OK" = "0" ]; then
  if command -v node >/dev/null; then
    miss "node $(node --version) — нужен ≥ 20 (NodeSource/nvm, см. INSTALL.md)"
  else
    miss "node — нужен ≥ 20 (apt в Ubuntu 22.04 даёт старый; NodeSource/nvm)"
  fi
  if [ "$INSTALL" = "1" ]; then
    maybe "nodejs из apt" sudo apt install -y nodejs npm
    if command -v node >/dev/null && [ "$(node --version | sed 's/v//;s/\..*//')" -ge 20 ]; then
      ok "node $(node --version) из apt"
    elif command -v curl >/dev/null; then
      # apt дал Node < 20 (Ubuntu 22.04: Node 12) — NodeSource 22 LTS.
      echo "  … apt дал Node < 20 — ставлю NodeSource (22 LTS)"
      if curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs; then
        ok "node $(node --version 2>/dev/null) (NodeSource)"
      else
        warn "NodeSource не удался — поставьте Node ≥ 20 вручную (nvm, INSTALL.md §1)"
      fi
    else
      warn "curl не найден — NodeSource недоступен; поставьте Node ≥ 20 вручную (nvm)"
    fi
  fi
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

# Системные библиотеки WebKit для Tauri (INSTALL.md §3) — без них сборка
# desktop падает на pkg-config. Браузерной сборке (npm run dev) не нужны.
if command -v pkg-config >/dev/null 2>&1 && pkg-config --exists webkit2gtk-4.1 2>/dev/null; then
  ok "webkit2gtk-4.1 ($(pkg-config --modversion webkit2gtk-4.1 2>/dev/null)) — desktop Tauri"
else
  warn "webkit2gtk-4.1 не найден — нужен только для desktop: sudo apt install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libudev-dev"
fi

echo "== Шлюз FPGA (systemd-автозапуск; опционально — можно вручную по INSTALL.md §4) =="
if [ -f /etc/systemd/system/legion-gateway.service ]; then
  ok "legion-gateway.service установлен"
else
  warn "legion-gateway.service не установлен — автозапуск агента шлюза (INSTALL.md §4)"
  if [ "$INSTALL" = "1" ]; then
    if sudo install -d /opt/legion \
      && sudo install -m644 fpga/host/legion_gateway.py fpga/host/legion_fpga.py /opt/legion/ \
      && sudo install -m644 fpga/systemd/legion-gateway.service /etc/systemd/system/ \
      && sudo systemctl daemon-reload; then
      # enable --now осознанно НЕ делаем: сначала LEGION_FPGA_TOKEN в юните
      # (строчки Environment=), иначе агент поднимется открытым в LAN.
      ok "юнит установлен; дальше вручную: токен в /etc/systemd/system/legion-gateway.service → systemctl enable --now legion-gateway"
    else
      warn "установка юнита не удалась — шаги вручную по INSTALL.md §4"
    fi
  fi
fi

echo "== Тракт ESP32 (опционально, режим 2) =="
if $PY -m platformio --version >/dev/null 2>&1; then
  ok "platformio $($PY -m platformio --version 2>/dev/null)"
else
  warn "platformio не найден (нужен только для ESP32) — pip install \"platformio>=6.1\""
  maybe "platformio" $PY -m pip install "platformio>=6.1"
fi

echo "== Quartus (только для сборки образа FPGA legion) =="
if command -v quartus_sh >/dev/null 2>&1; then
  ok "quartus $(quartus_sh --version 2>/dev/null | grep -oE 'Version [0-9.]+' | head -1)"
else
  warn "Quartus Prime Lite 23.1.1 не найден — нужен только для сборки legionxA4.rbf (INSTALL.md §5)"
fi

echo
if [ "$INFO" = "1" ]; then
  echo "СВОДКА (--info): справочно, код возврата всегда 0"
  exit 0
fi
if [ "$FAIL" = "0" ]; then
  echo "ОКРУЖЕНИЕ: OK — дальше: шлюз (INSTALL.md §4), образ legion (§5), приёмка (§6)"
else
  echo "ОКРУЖЕНИЕ: пробелы выше. Подробности — INSTALL.md; автодоустановка: ./setup.sh --install"
  exit 1
fi
