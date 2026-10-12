#!/bin/bash
# Сборка образа legion и ярлык меню. Иконка появляется только после успешной сборки.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
BOARD="${1:-bladeRF-micro}"
SIZE="${2:-A4}"
cd "$ROOT"
"$ROOT/fpga/check_toolchain.sh"
SHELL_NIOS=""
for p in "$HOME"/intelFPGA_lite/*/nios2eds/nios2_command_shell.sh; do
  [ -f "$p" ] || continue
  case "$p" in
    *intelFPGA_lite/23.1*) SHELL_NIOS="$p"; break ;;
  esac
  SHELL_NIOS="$p"
done
if [ -z "$SHELL_NIOS" ]; then
  echo "FAIL: nios2_command_shell.sh не найден (Quartus Prime Lite 23.1.1)" >&2
  exit 2
fi
WRAP=$(mktemp /tmp/legion-build-XXXXXX.sh)
cat > "$WRAP" << EOF
#!/bin/bash
set -euo pipefail
cd "$ROOT/fpga/vendor/bladerf/hdl/quartus"
exec ./build_bladerf.sh -b $BOARD -s $SIZE -r legion
EOF
chmod +x "$WRAP"
"$SHELL_NIOS" "$WRAP"
rm -f "$WRAP"
"$ROOT/tools/install_operator_icon.sh"
