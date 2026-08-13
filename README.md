# LEGION // RF SYNTH CONTROL

Дистанционное управление синтезатором частоты **ADF4351** (35 МГц – 4.4 ГГц):
**ПК (Tauri desktop) → ESP32 → ADF4351**.

- Задание точной частоты (напр. `2475.000 МГц`) с подтверждением захвата петли
- Автономный коридор: свип / псевдослучайный хоппинг (напр. 2400–2500 МГц)
- Телеметрия в реальном времени, SELFTEST диагностика модуля
- Дизайн-система LEGION: военная эстетика уровня Awwwards (Three.js + GSAP + кастомные GLSL)

## Структура

| Каталог | Содержимое |
|---|---|
| `firmware/` | Прошивка ESP32 (PlatformIO, 6 плат: classic/S3/S2/C3/C6/H2) |
| `app/` | ПО на ПК: Tauri v2 + React 19 + TypeScript |
| `tools/` | `legion_cli.py` — CLI для автоматизации и HIL-тестов |
| `docs/` | [architecture](docs/architecture.md) · [protocol](docs/protocol.md) · [wiring](docs/wiring.md) · [module-quirks](docs/module-quirks.md) · [compliance](docs/compliance.md) |

## Быстрый старт

```bash
# Прошивка (пример для ESP32-S3)
cd firmware && pio run -e esp32-s3 --target upload

# lite-UI на ESP32 (LittleFS): сборка + заливка ФС
../tools/build_lite_ui.sh && pio run -e esp32-s3 --target uploadfs

# ПО на ПК (Tauri desktop)
cd app && npm install && npm run tauri dev

# CLI
python3 tools/legion_cli.py --list
python3 tools/legion_cli.py --port /dev/ttyUSB0 --cmd "SET FREQ 2475.000"

# Эмулятор ESP32 на виртуальном PTY (разработка без железа)
python3 tools/esp32_emulator.py   # → печатает /dev/pts/N
```

## Возможности

- **MANUAL**: точная частота 35–4400 МГц, LOCK-индикация, 4 уровня мощности
- **SWEEP / HOP / CHIRP**: коридор (напр. 2400–2500 МГц) — линейный, псевдослучайный (seed), FMCW-рампа с шагом от 1 Гц
- **GLIDE / FM**: плавный переход и ЧМ-паттерны (SIN/TRI/RAND)
- **Транспорты**: USB-UART (Tauri desktop / Web Serial / CLI), WiFi (WebSocket :81 + lite-UI на :80), BLE (NUS)
- **Автономность**: NVS — режим восстанавливается после reboot
- **SELFTEST**: диагностика SPI модуля без приборов (перепутанные пины и пр.)
- **PE43702** (опция): аттенюатор 0–31.75 дБ шаг 0.25 дБ
- **OTA**: `curl -F "image=@firmware.bin" http://192.168.4.1/update`

## Платы

ESP32 classic / S3 / S2 / C3 / C6 / H2 (ограниченно) — см. [docs/architecture.md](docs/architecture.md).

## Правовая заметка

Устройство — лабораторный генератор. Тесты — на нагрузку 50 Ом / в экранировке.
Излучение в эфир регулируется законом — см. [docs/compliance.md](docs/compliance.md).
