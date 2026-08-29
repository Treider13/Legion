# LEGION — установка (Ubuntu 22.04 / 24.04)

Пошаговый сценарий «чистая Ubuntu → рабочий стенд с bladeRF 2.0 micro xA4».
Тракт ESP32 (режим 2) — в конце, он независим.

Быстрая проверка окружения после установки:

```bash
./setup.sh            # проверка всех зависимостей с понятными подсказками
./setup.sh --install  # попытаться доустановить недостающее (apt/pip/npm)
```

## 1. Системные пакеты

```bash
sudo apt update
sudo apt install -y git python3 python3-venv python3-pip nodejs npm \
  bladerf libbladerf-dev bladerf-firmware-fx3 bladerf-fpga-hostedxA4 \
  python3-soapysdr soapysdr-tools soapysdr-module-bladerf python3-numpy
```

- **bladeRF-cli / libbladeRF** — прошивка FPGA/FX3 и драйвер платы.
  Если пакета нет в вашей сборке Ubuntu — соберите из
  [Nuand/bladeRF](https://github.com/Nuand/bladeRF) (host).
- **SoapySDR + модуль bladeRF** — сканер и стримы. SoapySDR **не ставится
  через pip**: нужен системный биндинг (`python3-soapysdr`).
- **Node.js** — нужен ≥ 20 (лучше 22 LTS). Если в репозитории Ubuntu старая
  версия: [NodeSource](https://github.com/nodesource/distributions) или nvm.

Проверка:

```bash
bladeRF-cli --version        # драйвер платы
SoapySDRUtil --find          # видит модуль bladerf
python3 -c "import SoapySDR" # python-биндинг
node --version               # ≥ 20
```

## 2. Python-зависимости проекта (venv)

На современных Ubuntu системный pip блокирован (PEP 668) — ставим в venv:

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r tools/requirements.txt -r fpga/requirements.txt
```

`numpy` обязателен для сканера эфира; `pyusb` — для агента шлюза FPGA.

## 3. Приложение LEGION Control

Браузерная сборка (достаточно Node.js, без Rust):

```bash
cd app
npm ci
npm run dev
```

Desktop (Tauri) — дополнительно нужны Rust и системные библиотеки WebKit
(те же, что в CI):

```bash
sudo apt install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libudev-dev
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # rustup, stable
source "$HOME/.cargo/env"
cd app
npm ci
npm run tauri dev
```

## 4. Шлюз FPGA (мини-ПК с USB3 к bladeRF)

На шлюзе (может быть тот же ноутбук, если плата локальная):

```bash
pip install -r fpga/requirements.txt   # pyusb
export LEGION_FPGA_TOKEN=<секрет>      # рекомендуется
python3 fpga/host/legion_gateway.py    # порт 5531
```

Автозапуск — `fpga/systemd/legion-gateway.service`. Если FPGA пустая после
подачи питания (xA4 питается от USB) — `LEGION_FPGA_RBF=/путь/legionxA4.rbf`
для автозагрузки.

## 5. Образ FPGA ревизии legion

Пребилда нет — сборка из вендоренного дерева репозитория. Внешний инструмент
ровно один: **Quartus Prime Lite 23.1.1** (бесплатный, регистрация Intel):
страница загрузки — [intel.com → Quartus Prime Lite](https://www.intel.com/content/www/us/en/products/details/fpga/development-tools/quartus-prime.html)
— нужны пакеты Cyclone V (micro xA4/xA9) и/или Cyclone IV E (bladeRF 1 x40),
NIOS II EDS входит в установку.

```bash
fpga/check_toolchain.sh   # проверка тулчейна до сборки
cd fpga/vendor/bladerf/hdl/quartus
./build_bladerf.sh -b bladeRF-micro -s A4 -r legion   # → legionxA4.rbf
```

Запись в плату — из приложения, вкладка **КАСТОМ FPGA** (СОБРАТЬ → ПРОШИТЬ),
или вручную: `bladeRF-cli -l legionxA4.rbf` (RAM, откат — power cycle),
`bladeRF-cli -L legionxA4.rbf` (flash autoload).

## 6. Приёмка на железе (обязательна)

**Без зелёного прогона E1–E6 на целевой плате система стабильной не
считается.** Кабель TX→RX через аттенюатор 20–30 дБ, на шлюзе запущен
`legion_gateway.py`:

```bash
fpga/test/run_acceptance.sh --gw <IP шлюза> --board micro --ssh user@<IP шлюза>
```

Лог и JSON-отчёт — `fpga/test/results/`. Этапы и критерии — `fpga/README.md`.

## 7. Тракт ESP32 (режим 2, опционально)

```bash
source .venv/bin/activate
pip install platformio
cd firmware
pio run -e esp32-s3 --target upload    # env под вашу плату (см. platformio.ini)
```

Распиновка — `docs/wiring.md`, оборудование — `docs/hardware.md`.

## Что где задокументировано

| Тема | Файл |
|---|---|
| Архитектура | `docs/architecture.md` |
| Протокол ESP32 | `docs/protocol.md` |
| Прошивки SDR / Ethernet | `docs/sdr-firmware.md` |
| FPGA legion: сборка, эксплуатация, приёмка | `fpga/README.md` |
| Железо и стенд | `docs/hardware.md` |
| Правовая рамка | `docs/compliance.md` |
