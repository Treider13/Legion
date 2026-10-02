#!/usr/bin/env bash
# LEGION — пересборка desktop Tauri и установка ярлыка в меню Ubuntu.
#
# `npm run tauri dev` иконку не обновляет: поднимает Vite + debug-бинарь из
# дерева исходников и не пишет /usr/share/applications. Frontend (в т.ч. CSS
# LoRa SF/BW) вшивается в бандл только на `tauri build`.
#
# Бандл — факты Tauri 2 (tauri-bundler debian.rs + freedesktop/mod.rs):
#   npm run tauri build -- --bundles deb
#   → src-tauri/target/release/bundle/deb/{product}_{version}_{arch}.deb
#   пакет: /usr/bin/{binary}  /usr/lib/{product}/
#          /usr/share/applications/{product}.desktop
#
# Использование (из корня репозитория, на ПК):
#   ./tools/install_desktop.sh
#   ./tools/install_desktop.sh --build-only
#   ./tools/install_desktop.sh --install-only
#   ./tools/install_desktop.sh --replace-user-launchers
set -euo pipefail
cd "$(dirname "$0")/.." || { echo "FAIL: не удалось перейти в корень репозитория" >&2; exit 2; }

# shellcheck disable=SC1091
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"

BUILD=1
INSTALL=1
REPLACE_USER=0
for arg in "$@"; do
  case "$arg" in
    --build-only) INSTALL=0 ;;
    --install-only) BUILD=0 ;;
    --replace-user-launchers) REPLACE_USER=1 ;;
    -h|--help)
      sed -n '2,18p' "$0"
      exit 0
      ;;
    *)
      echo "FAIL: неизвестный аргумент: $arg (см. --help)" >&2
      exit 2
      ;;
  esac
done

if [ "$(uname -s)" != "Linux" ]; then
  echo "FAIL: только Linux (INSTALL.md). $(uname -s) не поддерживается." >&2
  exit 2
fi

CONF=app/src-tauri/tauri.conf.json
if [ ! -f "$CONF" ]; then
  echo "FAIL: нет $CONF" >&2
  exit 2
fi

PRODUCT=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["productName"])' "$CONF")
VERSION=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$CONF")
# debian.rs: X86_64→amd64, AArch64→arm64 (не invent: только uname -m → те же ключи).
case "$(uname -m)" in
  x86_64|amd64) DEB_ARCH=amd64 ;;
  aarch64|arm64) DEB_ARCH=arm64 ;;
  armv7l|armhf) DEB_ARCH=armhf ;;
  riscv64) DEB_ARCH=riscv64 ;;
  i686|i386) DEB_ARCH=i386 ;;
  *) DEB_ARCH="" ;;
esac

bundle_dir() {
  if [ -n "${CARGO_TARGET_DIR:-}" ]; then
    echo "${CARGO_TARGET_DIR}/release/bundle/deb"
  else
    echo "app/src-tauri/target/release/bundle/deb"
  fi
}

find_deb() {
  local dir base
  dir=$(bundle_dir)
  if [ -n "$DEB_ARCH" ]; then
    base="${dir}/${PRODUCT}_${VERSION}_${DEB_ARCH}.deb"
    if [ -f "$base" ]; then
      echo "$base"
      return 0
    fi
  fi
  # fallback: самый новый .deb в каталоге бандлера (если arch не совпал)
  local newest=""
  shopt -s nullglob
  local f
  for f in "${dir}"/*.deb; do
    if [ -z "$newest" ] || [ "$f" -nt "$newest" ]; then
      newest=$f
    fi
  done
  shopt -u nullglob
  if [ -n "$newest" ]; then
    echo "$newest"
    return 0
  fi
  return 1
}

need_node() {
  if ! command -v node >/dev/null; then
    echo "FAIL: node ≥ 20 — INSTALL.md §1 / ./setup.sh --install" >&2
    exit 1
  fi
  local nv
  nv=$(node --version | sed 's/v//;s/\..*//')
  if [ "$nv" -lt 20 ]; then
    echo "FAIL: node $(node --version) — нужен ≥ 20" >&2
    exit 1
  fi
}

need_rust_webkit() {
  if ! command -v cargo >/dev/null; then
    echo "FAIL: cargo не найден — rustup.rs, затем: source \"\$HOME/.cargo/env\" (INSTALL.md §3)" >&2
    exit 1
  fi
  if ! command -v pkg-config >/dev/null || ! pkg-config --exists webkit2gtk-4.1; then
    echo "FAIL: webkit2gtk-4.1 — sudo apt install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libudev-dev" >&2
    exit 1
  fi
}

list_user_desktop_files() {
  shopt -s nullglob
  local f
  for f in \
    "$HOME/.local/share/applications/"*.desktop \
    "$HOME/Desktop/"*.desktop \
    "$HOME/Рабочий стол/"*.desktop
  do
    [ -f "$f" ] || continue
    if grep -qiE 'legion|tauri' "$f"; then
      printf '%s\n' "$f"
    fi
  done
  shopt -u nullglob
}

report_launchers() {
  echo "== ярлыки, которые могут запускать старую сборку =="
  local f exec_line sys
  sys=/usr/share/applications/${PRODUCT}.desktop
  if [ -f "$sys" ]; then
    exec_line=$(grep -i '^Exec=' "$sys" | head -n1 || true)
    echo "  система: $sys  ${exec_line:-}"
  else
    echo "  системы нет: $sys (ещё не ставили .deb)"
  fi
  local found=0
  while IFS= read -r f; do
    found=1
    exec_line=$(grep -i '^Exec=' "$f" | head -n1 || true)
    echo "  пользователь: $f  ${exec_line:-}"
  done < <(list_user_desktop_files)
  if [ "$found" = "0" ]; then
    echo "  пользовательских ярлыков legion/tauri не найдено"
  fi
}

replace_user_launchers() {
  local f bak
  while IFS= read -r f; do
    bak="${f}.bak"
    cp -a "$f" "$bak"
    rm -f "$f"
    echo "  убран $f (копия $bak) — меню возьмёт /usr/share/applications/${PRODUCT}.desktop"
  done < <(list_user_desktop_files)
}

if [ "$BUILD" = "1" ]; then
  echo "== проверка toolchain =="
  need_node
  need_rust_webkit
  if [ ! -d app/node_modules ]; then
    echo "== app: npm ci =="
    (cd app && npm ci)
  fi
  echo "== tauri build --bundles deb (product=${PRODUCT} ${VERSION}) =="
  echo "   git $(git rev-parse --short HEAD 2>/dev/null || echo '?')"
  (cd app && npm run tauri build -- --bundles deb)
fi

DEB=$(find_deb || true)
if [ -z "$DEB" ]; then
  echo "FAIL: .deb не найден в $(bundle_dir)" >&2
  echo "      ждали ${PRODUCT}_${VERSION}_${DEB_ARCH:-<arch>}.deb — сначала без --install-only" >&2
  exit 1
fi
DEB_ABS=$(readlink -f "$DEB")
echo "== пакет: $DEB_ABS =="

if [ "$INSTALL" = "1" ]; then
  if pgrep -x "$PRODUCT" >/dev/null 2>&1; then
    echo "ВНИМАНИЕ: процесс $PRODUCT ещё запущен. Закройте окно, иначе по иконке можете увидеть старую сессию."
  fi
  echo "== apt --reinstall (та же версия ${VERSION} иначе apt скажет newest и не заменит файлы) =="
  if ! sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --reinstall "$DEB_ABS"; then
    echo "FAIL: не удалось установить $DEB_ABS" >&2
    echo "      вручную: sudo apt-get install -y --reinstall \"$DEB_ABS\"" >&2
    exit 1
  fi
  if command -v update-desktop-database >/dev/null; then
    sudo update-desktop-database /usr/share/applications >/dev/null 2>&1 || true
  fi
  if [ -x "/usr/bin/${PRODUCT}" ]; then
    echo "  OK: /usr/bin/${PRODUCT}  $(stat -c '%y' "/usr/bin/${PRODUCT}")"
  else
    echo "FAIL: после установки нет /usr/bin/${PRODUCT}" >&2
    exit 1
  fi
fi

report_launchers

if [ "$REPLACE_USER" = "1" ]; then
  echo "== --replace-user-launchers =="
  replace_user_launchers
fi

echo
echo "Дальше: закройте старое окно LEGION и запустите из меню / иконки"
echo "  (ярлык системы: /usr/share/applications/${PRODUCT}.desktop → /usr/bin/${PRODUCT})."
echo "  Не запускайте npm run tauri dev — это другая, не установленная сборка."
