# LEGION — зависимости: единый манифест

Карта всех библиотек и инструментов с минимальными версиями и источниками.
Источник истины для точных пинов — файлы манифестов (`tools/requirements.txt`,
`fpga/requirements.txt`, `app/package-lock.json`, `firmware/platformio.ini`);
этот документ — обзор и ссылки. Пошаговая установка — `INSTALL.md`,
проверка — `./setup.sh`.

## 1. Системные пакеты (Ubuntu 22.04/24.04, apt)

| Пакет | Мин. версия | Назначение | Источник |
|---|---|---|---|
| `bladerf`, `libbladerf-dev` | без пина (архив Ubuntu) | bladeRF-cli, драйвер платы | [packages.ubuntu.com](https://packages.ubuntu.com/search?keywords=bladerf) · [Nuand/bladeRF](https://github.com/Nuand/bladeRF) |
| `bladerf-firmware-fx3` | без пина | прошивка FX3 (USB) | архив Ubuntu |
| `bladerf-fpga-hostedxA4` | без пина | стоковый hosted-образ (откат) | архив Ubuntu |
| `python3-soapysdr`, `soapysdr-tools` | без пина | сканер/стримы; **pip не подходит** — нужен системный биндинг | [packages.ubuntu.com](https://packages.ubuntu.com/search?keywords=soapysdr) · [pothosware/SoapySDR](https://github.com/pothosware/SoapySDR) |
| `soapysdr-module-bladerf` | без пина | модуль Soapy для bladeRF | [Nuand/SoapyBladeRF](https://github.com/Nuand/SoapyBladeRF) |
| `python3-usb` (pyusb системный) | ≥ 1.2 | шлюз FPGA под systemd (`/usr/bin/python3`) | архив Ubuntu · [pyusb](https://github.com/pyusb/pyusb) |
| `python3-numpy` | ≥ 1.26 | сканер эфира (системный, для Soapy-биндинга) | архив Ubuntu |
| `nodejs`, `npm` | **Node ≥ 20** (лучше 22 LTS) | приложение LEGION Control | [NodeSource](https://github.com/nodesource/distributions) или nvm — в Ubuntu < 20 |
| `git`, `python3` ≥ 3.10, `python3-venv`, `python3-pip` | без пина | базовый инструментарий | архив Ubuntu |

## 2. Python (venv проекта, `pip install -r …`)

| Пакет | Мин. версия | Назначение | Источник |
|---|---|---|---|
| `pyserial` | ≥ 3.5 | CLI/эмулятор ESP32 (`tools/requirements.txt`) | [PyPI](https://pypi.org/project/pyserial/) |
| `numpy` | ≥ 1.26 | сканер: Welch/PSD, кольцо IQ (`tools/requirements.txt`) | [PyPI](https://pypi.org/project/numpy/) |
| `pyusb` | ≥ 1.2 | агент шлюза FPGA (`fpga/requirements.txt`) | [PyPI](https://pypi.org/project/pyusb/) |
| `platformio` | ≥ 6.1 | тракт ESP32 (опционально, INSTALL.md §7) | [PyPI](https://pypi.org/project/platformio/) |
| `pytest` | ≥ 8 | запуск хостовых наборов через pytest (разработка/CI) | [PyPI](https://pypi.org/project/pytest/) |

## 3. Приложение (`app/`, Node ≥ 20, `npm ci`)

Точные версии — в `app/package-lock.json` (репродуцируемая установка).
Ключевые (`app/package.json`):

| Пакет | Версия | Назначение |
|---|---|---|
| `react` | ^19.2.8 | UI |
| `zustand` | ^5.0.14 | стор/оркестрация |
| `@tauri-apps/api` | ^2.11.1 | desktop-мост (Tauri v2) |
| `vite` | ^8.2.0 | сборка |
| `typescript` | ~6.0.2 | типы |
| `tsx` | ^4.23.12 | тест-раннеры (`npm test`) |

Desktop-сборка Tauri дополнительно требует Rust (stable, [rustup](https://rustup.rs/))
и системные `libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libudev-dev`
(INSTALL.md §3).

## 4. FPGA (ревизия legion)

| Инструмент | Точная версия | Назначение | Источник |
|---|---|---|---|
| Quartus Prime Lite | **23.1.1** (ровно) | сборка `legionx*.rbf`; Cyclone V (micro) и/или Cyclone IV E (x40), NIOS II EDS в комплекте | [intel.com](https://www.intel.com/content/www/us/en/products/details/fpga/development-tools/quartus-prime.html) |
| GHDL | из архива Ubuntu | симуляция HDL (`fpga/tb/run_ghdl.sh`), CI | [packages.ubuntu.com](https://packages.ubuntu.com/search?keywords=ghdl) · [ghdl](https://github.com/ghdl/ghdl) |
| `shellcheck` | из архива Ubuntu | статический контроль shell-скриптов, CI | [shellcheck](https://www.shellcheck.net/) |

## 5. ESP32 (`firmware/platformio.ini`)

| Зависимость | Версия | Назначение |
|---|---|---|
| platform-espressif32 (pioarduino) | **55.03.311** (пин URL) | Arduino core 3.x / ESP-IDF 5.x для всех 6 плат |
| `gilmaimon/ArduinoWebsockets` | ^0.5.4 | WebSocket-сервер (WiFi-платы) |
| `h2zero/NimBLE-Arduino` | ^2.5.1 | BLE NUS |
