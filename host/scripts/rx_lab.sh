#!/usr/bin/env bash
# Шаг 3 лаборатории: приём I/Q 20 MSPS через bladeRF-cli → /tmp/iq.
# Эквивалент шагов 3.1–3.6 ТЗ одной командой; overrun-опрос 3.9 и
# критерий 3.10 выполняет python-раннер (та же CLI-сессия, не второй
# процесс — USB на FX3 один владелец).
set -euo pipefail

DURATION="${1:-60}"
FREQ="${2:-2400M}"

cd "$(dirname "$0")/.."
export PYTHONPATH="$PWD:${PYTHONPATH:-}"

python3 - <<EOF
import os, sys, time
sys.path.insert(0, "$PWD")
from legion_rx.fifo_source import ensure_fifo
ensure_fifo("/tmp/iq")  # 3.1: mkfifo /tmp/iq
print("FIFO /tmp/iq готов; запуск: python3 -m legion_rx.pipeline rx-cli "
      f"--duration-s {int(float('$DURATION'))} --freq {int(float('$FREQ'.replace('M','e6').replace('K','e3'))) 
      if any(c in '$FREQ' for c in 'MK') else int(float('$FREQ'))}")
EOF

exec python3 -m legion_rx.pipeline rx-cli --duration-s "$DURATION" --publish
