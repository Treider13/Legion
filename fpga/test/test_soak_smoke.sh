#!/bin/bash
# LEGION — smoke soak_bench.py против FAKE-шлюза (без железа):
# подъём lb_gated → внешний DISARM (молчаливая потеря ARM: armed_s=0 без
# wd_fired) → soak обязан засечь arm_lost и сделать re-ARM (иначе он часами
# опрашивал бы разоружённую плату — найдено перепроверкой).
set -u
cd "$(dirname "$0")/../.."
PORT=5597
export LEGION_FPGA_FAKE=1 LEGION_FPGA_PORT=$PORT
python3 fpga/host/legion_gateway.py & GW=$!
trap 'kill $GW 2>/dev/null; wait $GW 2>/dev/null' EXIT
sleep 1

# Внешний DISARM через 2 с после старта soak.
( sleep 2; python3 - "$PORT" <<'EOF'
import json, socket, sys
with socket.create_connection(("127.0.0.1", int(sys.argv[1])), timeout=3) as s:
    s.sendall(b'{"op":"disarm"}\n')
    s.makefile("rb").readline()
EOF
) &

# 0.0025 ч = 9 с; опрос 0.5 с. Грейс детекта 5 с → потеря ловится ~на 5–6 с.
python3 fpga/test/soak_bench.py --gw 127.0.0.1 --port $PORT --hours 0.0025 --poll-s 0.5 --board x40
RC=$?

LOG=$(ls -t fpga/test/results/soak-*.jsonl | head -1)
if ! grep -q '"event": "arm_lost"' "$LOG" || ! grep -q '"event": "rearm"' "$LOG"; then
  echo "SOAK SMOKE: FAIL — нет arm_lost/rearm в $LOG (код soak: $RC)"
  exit 1
fi
echo "SOAK SMOKE: PASS-1 (потеря ARM обнаружена, re-ARM выполнен)"
# Вердикт первого прогона FAIL по дизайну (был перезапуск) — не ошибка теста.

# Второй прогон: операторская остановка на 3-й секунде при запрошенных 8 ч.
# Чистый, но ранний прогон — вердикт НЕПОЛНЫЙ (код 2), не PASS: артефакт
# не должен выглядеть приёмкой.
python3 fpga/test/soak_bench.py --gw 127.0.0.1 --port $PORT --hours 8 --poll-s 0.5 --board x40 &
SOAK=$!
sleep 3
kill -INT $SOAK
wait $SOAK
RC2=$?
MD=$(ls -t fpga/test/results/soak-*.md | head -1)
if [ "$RC2" = "2" ] && grep -q "НЕПОЛНЫЙ" "$MD"; then
  echo "SOAK SMOKE: PASS-2 (ранняя чистая остановка → НЕПОЛНЫЙ, не PASS)"
  exit 0
fi
echo "SOAK SMOKE: FAIL — ранняя остановка: код $RC2, вердикт: $(grep -A2 '## Вердикт' "$MD" | tail -1)"
exit 1
