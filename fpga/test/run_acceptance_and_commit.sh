#!/bin/bash
# LEGION — приёмка E1–E6 на реальной плате с коммитом зелёного отчёта.
#
#   fpga/test/run_acceptance_and_commit.sh --gw <IP шлюза> [--board micro] [--ssh user@host] ...
#   fpga/test/run_acceptance_and_commit.sh --commit-only fpga/test/results/acceptance-<время>.json
#   fpga/test/run_acceptance_and_commit.sh --no-commit --gw <IP> ...   (только прогон)
#
# Зачем: система считается стабильной только после зелёного прогона E1–E6 на
# целевой плате, а доказательство — артефакты в fpga/test/results/. Каталог
# намеренно под .gitignore (локальные логи стендов), поэтому коммит идёт через
# git add -f — и ТОЛЬКО при ALL PASS. Красный прогон не коммитится никогда.
#
# Коды возврата: 0 — ALL PASS и отчёт закоммичен (или --no-commit);
# 1 — приёмка FAIL (ничего не закоммичено); 2 — ошибка вызова/отказ коммита.
set -u
cd "$(dirname "$0")/../.." || { echo "FAIL: не удалось перейти в корень репозитория" >&2; exit 2; }

COMMIT=1
ONLY_JSON=""
ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --no-commit) COMMIT=0; shift ;;
    --commit-only)
      [ $# -ge 2 ] || { echo "FAIL: --commit-only требует путь к acceptance-*.json" >&2; exit 2; }
      ONLY_JSON="$2"; shift 2 ;;
    *) ARGS+=("$1"); shift ;;
  esac
done

# --- commit_report <json> [log]: коммит зелёного отчёта, и ничего больше ----
commit_report() {
  local json="$1" log="${2:-}"
  [ -f "$json" ] || { echo "FAIL: отчёт не найден: $json" >&2; return 2; }
  git rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    || { echo "FAIL: не git-репозиторий — коммитить некуда" >&2; return 2; }
  # Коммитим только ЗЕЛЁНЫЙ отчёт: ok=true в JSON (а не по коду возврата
  # чужого скрипта — файл читаем сами, доверия по слову нет).
  python3 - "$json" <<'PYEOF'
import json, sys
try:
    rep = json.load(open(sys.argv[1]))
except Exception as e:
    print(f"FAIL: отчёт не читается как JSON: {e}", file=sys.stderr)
    sys.exit(2)
if rep.get("ok") is not True:
    print(f"FAIL: отчёт НЕ зелёный (ok={rep.get('ok')}, fails={rep.get('fails')}) — не коммитим", file=sys.stderr)
    sys.exit(1)
board = rep.get("board") or "?"
ts = rep.get("ts") or "?"
print(f"ОТЧЁТ ЗЕЛЁНЫЙ: плата {board}, время {ts}, проверок {len(rep.get('checks', []))}")
PYEOF
  local pyrc=$?
  [ "$pyrc" = "0" ] || return "$pyrc"
  # Чужие staged-изменения не подхватываем: коммит должен содержать ровно
  # артефакты приёмки. Индекс не свой — разбираться оператору.
  if ! git diff --cached --quiet; then
    echo "FAIL: в индексе уже есть staged-изменения — сначала разберите их" >&2
    echo "      (коммит приёмки обязан содержать только отчёт)" >&2
    return 2
  fi
  # results/ под .gitignore осознанно (локальные логи стендов) — нужен -f.
  git add -f "$json" ${log:+"$log"} || { echo "FAIL: git add не удался" >&2; return 2; }
  local board ts
  board=$(python3 -c "import json; print(json.load(open('$json')).get('board') or 'board?')" 2>/dev/null)
  ts=$(basename "$json" .json | sed 's/^acceptance-//')
  git commit -m "test(acceptance): E1–E6 ALL PASS на стенде ($board, $ts)

Стендовый прогон fpga/test/run_acceptance.sh; отчёт и лог — в
fpga/test/results/. По правилу репозитория только с этого момента система
на этой плате считается стабильной." || { echo "FAIL: git commit не удался" >&2; return 2; }
  echo "ОТЧЁТ ЗАКОММИЧЕН: $json${log:+ $log}"
  return 0
}

# --- Режим --commit-only: закоммитить уже существующий зелёный отчёт --------
if [ -n "$ONLY_JSON" ]; then
  # Лог — рядом с JSON тем же именем (если есть); отсутствие лога не блокирует.
  ONLY_LOG="${ONLY_JSON%.json}.log"
  [ -f "$ONLY_LOG" ] || ONLY_LOG=""
  commit_report "$ONLY_JSON" "$ONLY_LOG"
  exit $?
fi

# --- Режим прогона: run_acceptance.sh, затем коммит при ALL PASS ------------
RUN_LOG=$(mktemp)
fpga/test/run_acceptance.sh "${ARGS[@]}" 2>&1 | tee "$RUN_LOG"
RC=${PIPESTATUS[0]}

if [ "$RC" != "0" ]; then
  echo
  if [ "$RC" = "2" ]; then
    echo "Приёмка не запускалась (ошибка вызова/предусловия) — коммитить нечего." >&2
  else
    echo "Приёмка НЕ пройдена (код $RC) — отчёт НЕ коммитим." >&2
    echo "Красный прогон = блокирующий дефект: сначала исправление, потом эксплуатация." >&2
  fi
  rm -f "$RUN_LOG"
  exit "$RC"
fi

if [ "$COMMIT" = "0" ]; then
  echo "Прогон зелёный; --no-commit — коммит не делаем."
  rm -f "$RUN_LOG"
  exit 0
fi

# Пути артефактов — из строки run_acceptance.sh «артефакты: <log>, <json>».
ARTS=$(grep -oE 'артефакты: [^,]+, [^ ]+' "$RUN_LOG" | tail -1 | sed 's/артефакты: //')
rm -f "$RUN_LOG"
LOG=$(echo "$ARTS" | cut -d',' -f1 | tr -d ' ')
JSON=$(echo "$ARTS" | cut -d',' -f2 | tr -d ' ')
if [ -z "${JSON:-}" ] || [ ! -f "$JSON" ]; then
  echo "FAIL: не нашёл JSON-отчёт в выводе run_acceptance.sh — коммит отменён" >&2
  exit 2
fi
commit_report "$JSON" "$LOG"
exit $?
