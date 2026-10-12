#!/bin/bash
# Окно оператора: управление, мониторинг, живой водопад.
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT" || exit 1
if [ -x "$ROOT/.venv/bin/python" ]; then
  exec "$ROOT/.venv/bin/python" -m host.legion_rx.main_app
fi
exec python3 -m host.legion_rx.main_app
