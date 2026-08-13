#!/usr/bin/env bash
# ============================================================================
# LEGION — сборка lite-UI и упаковка в LittleFS-образ данных прошивки.
# Использование: tools/build_lite_ui.sh
# Результат: firmware/data/* (gzip), далее: pio run --target uploadfs
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== build web =="
(cd app && npm run build)

echo "== copy + gzip to firmware/data =="
rm -rf firmware/data
mkdir -p firmware/data
cp -r app/dist/* firmware/data/
# gzip все текстовые ассеты (WebServer core 3.x отдаёт .gz с Content-Encoding)
find firmware/data -type f \( -name "*.html" -o -name "*.js" -o -name "*.css" -o -name "*.svg" \) -print0 |
  while IFS= read -r -d '' f; do gzip -9 -k "$f"; done

echo "== size =="
du -sh firmware/data
find firmware/data -type f | sort
