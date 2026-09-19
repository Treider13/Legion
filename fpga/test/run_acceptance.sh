#!/bin/bash
# LEGION — прогон приёмки E1–E6 на реальной плате с сохранением артефактов.
#
#   fpga/test/run_acceptance.sh --gw <IP шлюза> [--board micro] [--ssh user@host] [--skip-e6]
#
# Лог и JSON-отчёт складываются в fpga/test/results/acceptance-<время>.log/.json
# (плата — внутри JSON, поле board; в имя не входит).
# Коды: 0 = ALL PASS, 1 = FAIL, 2 = ошибка запуска, 3 = INCOMPLETE.
# Без успешного прогона на целевой плате система стабильной НЕ считается
# (см. README.md, раздел «Приёмка на железе»).
set -u
cd "$(dirname "$0")/../.." || { echo "FAIL: не удалось перейти в корень репозитория" >&2; exit 2; }

GW=""
EXTRA=()
while [ $# -gt 0 ]; do
  case "$1" in
    --gw)
      if [ $# -lt 2 ] || [ -z "${2:-}" ] || [[ "${2:-}" == --* ]]; then
        echo "FAIL: --gw требует адрес шлюза" >&2
        exit 2
      fi
      GW="$2"; shift 2 ;;
    *) EXTRA+=("$1"); shift ;;
  esac
done

if [ -z "$GW" ]; then
  echo "FAIL: нужен --gw <IP шлюза с платой> (на шлюзе: python3 fpga/host/legion_gateway.py)" >&2
  exit 2
fi

echo "== предусловия (этот ПК) =="
# Зависимости Python ставятся в .venv (INSTALL.md §2) — проверяем его, иначе
# системный python3 без пакетов дал бы ложные FAIL.
PY=python3
if [ -f .venv/bin/python ]; then
  PY=.venv/bin/python
  echo "  OK: venv .venv ($($PY --version 2>&1))"
fi
FAIL=0
command -v python3 >/dev/null && echo "  OK: python3 $(python3 --version 2>&1 | awk '{print $2}')" \
  || { echo "  FAIL: python3 не найден"; FAIL=1; }
$PY -c "import usb" 2>/dev/null && echo "  OK: pyusb" \
  || { echo "  FAIL: pyusb — pip install -r fpga/requirements.txt"; FAIL=1; }
$PY -c "import numpy" 2>/dev/null && echo "  OK: numpy (стрим-стимул E3/E4)" \
  || { echo "  FAIL: numpy — pip install -r tools/requirements.txt"; FAIL=1; }
$PY -c "import SoapySDR" 2>/dev/null && echo "  OK: SoapySDR python (воркер E3/E4)" \
  || { echo "  FAIL: python3-soapysdr — sudo apt install python3-soapysdr soapysdr-module-bladerf"; FAIL=1; }
[ "$FAIL" = "0" ] || { echo "Предусловия не выполнены — приёмка не запускалась."; exit 1; }

OUT_DIR="fpga/test/results"
mkdir -p "$OUT_DIR" || exit 2
# Одновременные запуски не перезаписывают журнал и JSON друг друга.
LOG=$(mktemp "$OUT_DIR/acceptance-$(date +%Y%m%d-%H%M%S)-XXXXXX.log") || exit 2
JSON="${LOG%.log}.json"

echo "== приёмка E1–E6: лог $LOG =="
$PY fpga/test/acceptance_bench.py --gw "$GW" --out "$JSON" "${EXTRA[@]}" 2>&1 | tee "$LOG"
PIPE_RC=("${PIPESTATUS[@]}")
RC=${PIPE_RC[0]}
if [ "${PIPE_RC[1]}" != "0" ]; then
  echo "FAIL: журнал не удалось сохранить" >&2
  RC=1
fi

echo
if [ "$RC" = "0" ]; then
  echo "ПРИЁМКА: ALL PASS — артефакты: $LOG, $JSON"
elif [ "$RC" = "3" ]; then
  echo "ПРИЁМКА: INCOMPLETE — обязательные проверки не подтверждены; лог: $LOG; отчёт: $JSON"
else
  echo "ПРИЁМКА: FAIL (код $RC) — лог: $LOG; отчёт: $JSON"
  echo "Система НЕ считается стабильной до зелёного прогона E1–E6 на целевой плате."
fi
exit "$RC"
