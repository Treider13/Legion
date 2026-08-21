#!/bin/bash
# LEGION — синхронизация вендоренного дерева Nuand bladeRF с апстримом.
# Источник: github.com/Nuand/bladeRF (MIT). Зафиксированный коммит — в UPSTREAM.txt.
# Использование: fpga/vendor/sync_vendor.sh [git-ref]   (по умолчанию — из UPSTREAM.txt)
set -euo pipefail
cd "$(dirname "$0")"

REF="${1:-$(grep -m1 '^commit ' UPSTREAM.txt | awk '{print $2}')}"
if [ -z "$REF" ]; then echo "UPSTREAM.txt: нет коммита"; exit 1; fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
git clone --depth 1 --filter=blob:none --sparse "https://github.com/Nuand/bladeRF.git" "$TMP/bladerf"
cd "$TMP/bladerf"
git fetch --depth 1 origin "$REF"
git checkout "$REF"
git sparse-checkout set \
  hdl/fpga/platforms/bladerf \
  hdl/fpga/platforms/bladerf-micro \
  hdl/fpga/platforms/common \
  hdl/fpga/ip \
  hdl/quartus \
  hdl/README.md \
  hdl/CHANGELOG \
  fpga_common \
  firmware_common \
  host/libraries/libbladeRF/include \
  host/libraries/libbladeRF/src/backend/usb \
  COPYING LICENSE

DEST="$(cd .. && pwd)/bladerf"
rm -rf "$DEST"
mkdir -p "$DEST"
for p in hdl fpga_common firmware_common host; do
  [ -e "$p" ] && cp -a "$p" "$DEST/"
done
for f in COPYING LICENSE COPYING.LESSER; do
  [ -e "$f" ] && cp -a "$f" "$DEST/"
done
echo "Синхронизировано на $REF → $DEST"
echo "Дальше: применить интеграцию legion — см. fpga/README.md (или уже применено в дереве)."
