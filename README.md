# LEGION // RF SYNTH CONTROL

**LEGION** — система дистанционного управления широкополосным синтезатором
частоты **Analog Devices ADF4351** (34.375 МГц – 4.4 ГГц) через микроконтроллер
**ESP32** с программным обеспечением на ноутбуке/компьютере.

```
┌──────────────────────┐   USB-UART / WiFi / BLE   ┌─────────┐   SPI    ┌──────────┐
│  LEGION Control (ПК) │ ────────────────────────▶ │  ESP32  │ ───────▶ │ ADF4351  │ ─▶ RF out
│  Tauri desktop app   │ ◀──────────────────────── │ прошивка│ ◀── LD ─ │  модуль  │
└──────────────────────┘   телеметрия (LOCK, частота)└─────────┘          └──────────┘
```

**Это реальная система для реального железа.** ПО на компьютере посылает
команду (например, «2475.000 МГц» или «коридор 2400–2500 МГц, шаг 1 МГц»),
ESP32 принимает её и физически настраивает чип ADF4351 по SPI — на SMA-выходе
модуля появляется реальный радиочастотный сигнал.

> **Про эмулятор.** В репозитории есть `tools/esp32_emulator.py` — это НЕ часть
> рабочей системы, а инструмент разработки: он имитирует ответы ESP32 на
> виртуальном serial-порту, чтобы писать и тестировать ПО на ПК без железа под
> рукой. На реальном стенде эмулятор не нужен и не используется.

## Состав системы

| Компонент | Каталог | Назначение |
|---|---|---|
| Прошивка ESP32 | `firmware/` | PlatformIO; 6 плат: classic / S3 / S2 / C3 / C6 / H2 |
| ПО на ПК | `app/` | Tauri v2 desktop (React 19 + TS); та же сборка работает в браузере (Web Serial) и на ESP32 (lite-UI) |
| CLI и эмулятор | `tools/` | `legion_cli.py` (автоматизация), `esp32_emulator.py` (разработка без железа), `fuzz_protocol.py` (фаззинг) |
| Документация | `docs/` | архитектура, протокол, распиновка, грабли модулей, compliance, реестр заимствований, факты даташита |
| Локальные референсы | `third_party/` | см. [docs/REFERENCES.md](docs/REFERENCES.md) |

## Возможности

- **MANUAL** — точная частота 34.375–4400 МГц, подтверждение захвата ФАПЧ (LOCK),
  4 уровня мощности (−4/−1/+2/+5 дБм)
- **SWEEP** — линейный коридор (напр. 2400→2500 МГц, шаг, темп), бесконечный цикл
- **HOP** — псевдослучайный хоппинг по сетке с воспроизводимым seed
- **CHIRP** — FMCW-рампа с мелким шагом (от 1 Гц)
- **GLIDE / FM** — плавный переход и частотная модуляция (SIN/TRI/RAND)
- **Транспорты**: USB-UART (desktop/CLI/браузер), WiFi (WebSocket + встроенный
  веб-UI на самом ESP32), BLE (Nordic UART Service — со смартфона)
- **Автономность**: последний режим восстанавливается после перезагрузки (NVS)
- **SELFTEST** — диагностика SPI-связи с модулем без приборов (в т.ч. ловит
  перепутанные пины — известная болезнь дешёвых модулей)
- **PE43702** (опция) — цифровой аттенюатор 0–31.75 дБ шагом 0.25 дБ
- **OTA** — обновление прошивки ESP32 по WiFi
- **Два режима (не смешивать):**
  1. **SDR (Ethernet)** — каталог bladeRF / HackRF / Lime / Pluto / USRP /
     RTL-SDR, официальные образы FPGA, SCAN RX, TX LO на RF out → усилитель.
     ESP32 в этом тракте нет.
  2. **ESP32 (USB)** — синтезатор ADF4351, коридор, ток PA, интерлок 50 Ом.

## Быстрый старт (реальное железо)

Нужно: ESP32 (любая из 6 плат), модуль ADF4351, кабель micro-USB/USB-C.
Полный список (минимум / стенд / приборы / апгрейд) — [docs/hardware.md](docs/hardware.md).

1. **Собрать по [docs/wiring.md](docs/wiring.md)** (5 проводов, логика 3.3 В —
   напрямую, без делителей).
2. **Прошить ESP32** (PlatformIO ставим в venv — на современных Ubuntu/Debian
   системный pip блокирован PEP 668):
   ```bash
   python3 -m venv .venv && source .venv/bin/activate
   pip install platformio
   cd firmware
   pio run -e esp32-s3 --target upload        # env под вашу плату
   ```
3. **Запустить ПО на ПК:**
   ```bash
   cd app && npm install && npm run tauri dev
   ```
   Выбрать порт (напр. `/dev/ttyUSB0` или `COM5`) → CONNECT → ввести частоту.
4. **CLI (опционально, в том же venv):**
   ```bash
   pip install -r tools/requirements.txt
   python3 tools/legion_cli.py --port /dev/ttyUSB0 --cmd "SET FREQ 2475.000"
   python3 tools/legion_cli.py --port /dev/ttyUSB0 --cmd "SWEEP START 2400 2500 STEP 1000 DWELL 10"
   ```
5. **Без проводов:** ESP32 поднимает WiFi AP `LEGION` (пароль `legion4351`) —
   открыть `http://192.168.4.1/` (lite-UI) или подключиться по WebSocket :81.

## Разработка без железа

```bash
python3 tools/esp32_emulator.py   # печатает /dev/pts/N — виртуальный ESP32
# В приложении LEGION: транспорт «USB (Tauri)», порт /dev/pts/N (ручной ввод)
```

## Тесты

| Слой | Команда | Что проверяет |
|---|---|---|
| Математика регистров | `cd firmware && pio test -e native` | 23 юнит-теста против эталонов даташита/pyadf435x (сетка 34.375–4400 МГц, «проклятая» 2175 МГц) |
| Парсер прошивки | `pio test -e native_fuzz` | 10 000 фазз-кейсов в production-парсер (host-сборка с shim'ами) |
| Протокол (PTY) | `python3 tools/fuzz_protocol.py` | 1000 случайных/битых команд против эмулятора |
| ПК-протокол | `cd app && npx tsx scripts/smoke_mock.ts` | 21 проверка команд/ошибок |
| WebSocket | `npx tsx scripts/smoke_ws.ts` | транспорт WiFi |
| GUI | `npx tsx scripts/gui_test.ts` | e2e в Chrome: connect → 2475 МГц → LOCK → коридор |

CI (GitHub Actions) гоняет всё это + сборку прошивки под 6 плат + сборку
Tauri на каждый пуш; релизы (win/mac/linux бандлы) — по тегу `v*`.

## Документация

[architecture](docs/architecture.md) · [protocol](docs/protocol.md) ·
[wiring](docs/wiring.md) · [hardware](docs/hardware.md) ·
[module-quirks](docs/module-quirks.md) · [compliance](docs/compliance.md) ·
[REFERENCES](docs/REFERENCES.md) · [datasheet-facts](docs/datasheet-facts.md) ·
[analysis-upgrade](docs/analysis-upgrade.md)

## Правовая заметка

Устройство — лабораторный генератор сигналов (макс. +5 дБм ≈ 3 мВт). Разработка
и тесты — на эквивалент антенны 50 Ом / в экранированной среде. Излучение в
эфир регулируется законодательством — см. [docs/compliance.md](docs/compliance.md).
