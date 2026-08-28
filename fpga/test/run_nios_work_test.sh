#!/bin/bash
# LEGION — поведенческий тест NIOS-логики (legion_work / AIR_PREP) на ПК.
# Собирает мастер fpga/nios/legion_cmds.c + nios_work_test.c в двух конфигах
# (x40 и micro+RFIC) с записывающими стабами и запускает. Сигнатуры
# RFIC-стабов проверяются компилятором против реального devices_rfic.h.
set -e
cd "$(dirname "$0")"

VENDOR=../vendor/bladerf
NIOS_SRC=$VENDOR/hdl/fpga/platforms/common/bladerf/software/bladeRF_nios/src
MICRO_SRC=$VENDOR/hdl/fpga/platforms/bladerf-micro/software/bladeRF_nios/src

INCS="-I nios_work_stubs -I nios_stubs \
      -I $NIOS_SRC \
      -I $MICRO_SRC \
      -I $VENDOR/fpga_common/include \
      -I $VENDOR/host/libraries/libbladeRF/include \
      -I $VENDOR/hdl/fpga/ip/analogdevicesinc/no_OS/include"

CFLAGS="-std=gnu99 -Wall -DBLADERF_NIOS_BUILD"
FAIL=0

run_cfg() { # $1=имя, остальное — дефайны
    local name=$1; shift
    local bin
    bin=$(mktemp /tmp/legion_work_XXXX)
    if gcc $CFLAGS $INCS "$@" ../nios/legion_cmds.c nios_work_test.c -o "$bin" 2> /tmp/legion_work_cc.log; then
        if "$bin"; then
            echo "  OK    $name"
        else
            echo "  FAIL  $name (сценарии)"; FAIL=1
        fi
    else
        echo "  FAIL  $name (сборка)"; cat /tmp/legion_work_cc.log; FAIL=1
    fi
    rm -f "$bin"
}

run_cfg "x40       " -DBOARD_BLADERF -DRAM_SPAN=65536
run_cfg "micro-rfic" -DBOARD_BLADERF_MICRO -DRAM_SPAN=131072

[ "$FAIL" = "0" ] && echo "NIOS WORK: ALL PASS" || { echo "NIOS WORK: FAILURES"; exit 1; }
