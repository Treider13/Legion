#!/bin/bash
# LEGION FPGA — прогон GHDL-симуляции всех модулей.
# Использование: fpga/tb/run_ghdl.sh   (нужен ghdl ≥ 1.0, VHDL-2008)
set -e
cd "$(dirname "$0")"
WORK=work-obj08.cf
rm -f "$WORK"

HDL=../hdl
GHDL_STD="--std=08"

echo "== Анализ =="
ghdl -a $GHDL_STD --workdir=. "$HDL/legion_pkg.vhd"
ghdl -a $GHDL_STD --workdir=. "$HDL/legion_detector.vhd"
ghdl -a $GHDL_STD --workdir=. "$HDL/legion_player.vhd"
ghdl -a $GHDL_STD --workdir=. "$HDL/legion_nco.vhd"
ghdl -a $GHDL_STD --workdir=. "$HDL/legion_dcfifo.vhd"
ghdl -a $GHDL_STD --workdir=. "$HDL/legion_watchdog.vhd"
ghdl -a $GHDL_STD --workdir=. "$HDL/legion_tx_mux.vhd"
ghdl -a $GHDL_STD --workdir=. "$HDL/legion_regs.vhd"

echo "== Тестбенчи =="
FAIL=0
for tb in legion_detector_tb legion_player_tb legion_nco_tb legion_watchdog_tb legion_dcfifo_tb legion_tx_mux_tb legion_regs_tb legion_integration_tb; do
    ghdl -a $GHDL_STD --workdir=. "$tb.vhd"
    ghdl -e $GHDL_STD --workdir=. "$tb"
    # --stop-time: страховка от зависания (зависший wait = FAIL, а не вечный цикл)
    if timeout 120 ghdl run $GHDL_STD --workdir=. "$tb" --stop-time=20ms --assert-level=error | tee /tmp/legion_ghdl_$tb.log; then
        if grep -q "PASS" /tmp/legion_ghdl_$tb.log; then
            echo "  OK  $tb"
        else
            echo "  FAIL(нет PASS)  $tb"; FAIL=1
        fi
    else
        echo "  FAIL(assert/timeout)  $tb"; FAIL=1
    fi
done
rm -f "$WORK"
[ "$FAIL" = "0" ] && echo "GHDL: ALL PASS" || { echo "GHDL: FAILURES"; exit 1; }
