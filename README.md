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

# ПО на ПК
cd app && npm install && npm run tauri dev

# CLI
python3 tools/legion_cli.py --list
python3 tools/legion_cli.py --port /dev/ttyUSB0 --cmd "SET FREQ 2475.000"
```

## Правовая заметка

Устройство — лабораторный генератор. Тесты — на нагрузку 50 Ом / в экранировке.
Излучение в эфир регулируется законом — см. [docs/compliance.md](docs/compliance.md).
