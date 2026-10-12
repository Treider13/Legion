#!/bin/bash
# Ярлык меню LEGION → окно оператора. Ставится в конце сборки образа FPGA.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
LAUNCH="$ROOT/tools/legion-window.sh"
ICON_SRC="$ROOT/app/src-tauri/icons/128x128.png"
APP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
ICON_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/128x128/apps"
chmod +x "$LAUNCH"
mkdir -p "$APP_DIR" "$ICON_DIR"
if [ -f "$ICON_SRC" ]; then
  cp "$ICON_SRC" "$ICON_DIR/legion.png"
fi
cat > "$APP_DIR/legion.desktop" << EOF
[Desktop Entry]
Type=Application
Name=LEGION
Comment=Управление, мониторинг и живой водопад
Exec=$LAUNCH
Icon=legion
Terminal=false
Categories=Science;
StartupNotify=true
EOF
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$APP_DIR" >/dev/null 2>&1 || true
fi
echo "иконка LEGION в меню: $APP_DIR/legion.desktop"
