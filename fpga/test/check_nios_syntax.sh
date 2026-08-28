#!/bin/bash
# LEGION — синтаксическая проверка NIOS C (legion_cmds.c) на ПК, без Quartus.
#
# Компилирует мастер fpga/nios/legion_cmds.c и вендоренную копию против
# РЕАЛЬНЫХ заголовков дерева Nuand (fpga_common/include, libbladeRF.h,
# devices*.h). Стабы в nios_stubs/ — только для genuinely отсутствующих
# листьев: system.h (генерирует BSP), altera_*.h / sys/alt_irq.h (Altera HAL
# из Quartus), range.h и ad9361_api.h (не вошли в вендоренное подмножество).
#
# Три конфигурации (ветки #if в legion_cmds.c):
#   x40          — bladeRF 1: эфир через CONTROL со шлюза, RFIC-путь выключен
#   micro-nolib  — BOARD_BLADERF_MICRO, RAM_SPAN 64 KiB: AIR честно отказывает
#   micro-rfic   — BOARD_BLADERF_MICRO, RAM_SPAN 128 KiB: полный RFIC-путь
#                  (BLADERF_NIOS_LIBAD936X по devices.h)
set -e
cd "$(dirname "$0")"

VENDOR=../vendor/bladerf
NIOS_SRC=$VENDOR/hdl/fpga/platforms/common/bladerf/software/bladeRF_nios/src
MICRO_SRC=$VENDOR/hdl/fpga/platforms/bladerf-micro/software/bladeRF_nios/src

INCS="-I nios_stubs \
      -I $NIOS_SRC \
      -I $MICRO_SRC \
      -I $VENDOR/fpga_common/include \
      -I $VENDOR/host/libraries/libbladeRF/include \
      -I $VENDOR/hdl/fpga/ip/analogdevicesinc/no_OS/include"

CFLAGS="-std=gnu99 -Wall -fsyntax-only -DBLADERF_NIOS_BUILD"
FAIL=0

check_cfg() { # $1=имя, $2=исходник, остальное — дефайны
    local name=$1; local src=$2; shift 2
    if gcc $CFLAGS $INCS "$@" -c "$src" -o /dev/null 2> /tmp/legion_nios_cc.log; then
        echo "  OK    $name ($(basename "$src"))"
    else
        echo "  FAIL  $name ($(basename "$src"))"; cat /tmp/legion_nios_cc.log; FAIL=1
    fi
}

for src in ../nios/legion_cmds.c "$NIOS_SRC/legion_cmds.c"; do
    check_cfg "x40        " "$src" -DBOARD_BLADERF -DRAM_SPAN=65536
    check_cfg "micro-nolib" "$src" -DBOARD_BLADERF_MICRO -DRAM_SPAN=65536
    check_cfg "micro-rfic " "$src" -DBOARD_BLADERF_MICRO -DRAM_SPAN=131072
done

# Main-loop обеих платформ с хуком legion_work() (под LEGION_FPGA, как в
# NIOS Makefile интеграции). Платформенный каталог — ради fpga_version.h.
# Дефайны платформы — как в реальных Makefile (x40: BOARD_BLADERF).
X40_SRC=$VENDOR/hdl/fpga/platforms/bladerf/software/bladeRF_nios/src
check_cfg "main x40   " "$X40_SRC/bladeRF_nios.c" -DBOARD_BLADERF \
    -DRAM_SPAN=65536 -DLEGION_FPGA -I "$X40_SRC"
check_cfg "main micro " "$MICRO_SRC/bladeRF_nios.c" -DBOARD_BLADERF_MICRO \
    -DRAM_SPAN=131072 -DLEGION_FPGA -I "$MICRO_SRC"

# Drift: мастер fpga/nios == вендоренная копия (CI ловит расхождение)
for f in legion_cmds.c legion_cmds.h; do
    if diff -q "../nios/$f" "$NIOS_SRC/$f" > /dev/null; then
        echo "  OK    drift $f (мастер == вендор)"
    else
        echo "  FAIL  drift $f: fpga/nios/ != вендоренная копия"; FAIL=1
    fi
done

# Зонд невакуумности: gate LEGION_HAVE_RFIC в legion_cmds.c обязан быть
# активен ровно в конфиге micro-rfic (без devices.h он был мёртв и в этой
# проверке, и в реальной сборке — Makefile micro не задаёт LIBAD936X).
if gcc $CFLAGS $INCS -DBOARD_BLADERF_MICRO -DRAM_SPAN=131072 \
        -DLEGION_PROBE_EXPECT_RFIC -c nios_probe_rfic.c -o /dev/null 2>/dev/null; then
    echo "  OK    зонд: RFIC-ветка активна в micro-rfic"
else
    echo "  FAIL  зонд: RFIC-ветка мертва в micro-rfic (gate!)"; FAIL=1
fi
if gcc $CFLAGS $INCS -DBOARD_BLADERF -DRAM_SPAN=65536 -c nios_probe_rfic.c -o /dev/null 2>/dev/null; then
    echo "  OK    зонд: RFIC-ветка выключена на x40"
else
    echo "  FAIL  зонд: RFIC-ветка протекла в x40"; FAIL=1
fi

[ "$FAIL" = "0" ] && echo "NIOS SYNTAX: ALL PASS" || { echo "NIOS SYNTAX: FAILURES"; exit 1; }
