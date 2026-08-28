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
    check_cfg "x40        " "$src" -DRAM_SPAN=65536
    check_cfg "micro-nolib" "$src" -DBOARD_BLADERF_MICRO -DRAM_SPAN=65536
    check_cfg "micro-rfic " "$src" -DBOARD_BLADERF_MICRO -DRAM_SPAN=131072
done

[ "$FAIL" = "0" ] && echo "NIOS SYNTAX: ALL PASS" || { echo "NIOS SYNTAX: FAILURES"; exit 1; }
