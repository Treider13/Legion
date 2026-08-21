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
| FPGA-ревизия x40 | `fpga/` | ревизия `legion` для bladeRF 1 x40 и micro: автономный тракт в FPGA (плеер RAM / NCO / loopback по детектору), watchdog, агент шлюза; вендоренное дерево Nuand в `fpga/vendor/` — сборка из репозитория; см. `fpga/README.md` |
| Документация | `docs/` | архитектура, протокол, распиновка, грабли модулей, compliance, реестр заимствований, факты даташита |
| Локальные референсы | `third_party/` | см. [docs/REFERENCES.md](docs/REFERENCES.md) |

## Возможности

- **MANUAL** — точная частота 34.375–4400 МГц, подтверждение захвата ФАПЧ (LOCK),
  4 уровня мощности (−4/−1/+2/+5 дБм)
- **SWEEP** — линейный коридор (напр. 2400→2500 МГц, шаг, темп), бесконечный цикл
- **HOP** — псевдослучайный хоппинг по сетке с воспроизводимым seed
- **CHIRP** — FMCW-рампа с мелким шагом (от 1 Гц)
- **GLIDE / FM** — плавный переход и частотная модуляция (SIN/TRI/RAND)
- **ТИП СИГНАЛА** (режим SDR) — 31 baseband-волна: синус, тон Fj + случ. фаза,
  меандр, пила, треугольник, чирп, AWGN, BPSK/QPSK/8-PSK/16-QAM + RRC,
  2-FSK/4-FSK/8-FSK, GMSK (GSM), GFSK (BLE), OQPSK (802.15.4), π/4-DQPSK
  (TETRA), 16-APSK (DVB-S2), DSSS (m-seq Gp=31), CSS (LoRa), OFDM
  (802.11a-подобный), SC-FDMA (LTE UL), Zadoff-Chu (5G PRACH), OTFS / AFDM /
  OCDM (6G), P4 (радар), OOK, AM, FM. Предпросмотр спектра/созвездия в UI;
  «ЗАШИТЬ НА SDR» — непрерывный I/Q-стрим с хоста (fs 2 МГц, гетеродин +fs/8),
  только в нагрузку 50 Ом и полосу allowlist. Зашитая волна становится
  TX-контентом всех режимов: АВТО/ПРИОРИТЕТ (сканер → цель) и open-loop
  (качание/сплошная/случайная) идут с ней, пока оператор не сбросит на CW.
  Важно: SDR волну не хранит — синтез и петля на хосте; отключение
  ноутбука/программы останавливает TX (для автономной волны внутри x40 нужен
  свой FPGA-битстрим с плеером — вне политики «только офиц. образы»)
- **Транспорты**: USB-UART (desktop/CLI/браузер), WiFi (WebSocket + встроенный
  веб-UI на самом ESP32), BLE (Nordic UART Service — со смартфона)
- **Автономность**: последний режим восстанавливается после перезагрузки (NVS)
- **SELFTEST** — диагностика SPI-связи с модулем без приборов (в т.ч. ловит
  перепутанные пины — известная болезнь дешёвых модулей)
- **PE43702** (опция) — цифровой аттенюатор 0–31.75 дБ шагом 0.25 дБ
- **OTA** — обновление прошивки ESP32 по WiFi
- **Два режима (не смешивать):**
  1. **SDR (Ethernet)** — каталог bladeRF (x40, micro xA4/xA9) / HackRF /
     Lime / Pluto / USRP / RTL-SDR, официальные образы FPGA, SCAN RX,
     TX LO / baseband-волна на RF out → усилитель. ESP32 в этом тракте нет.
  2. **ESP32 (USB)** — синтезатор ADF4351, коридор, ток PA, интерлок 50 Ом.

## Быстрый старт (реальное железо)

Нужно: ESP32 (любая из 6 плат), модуль ADF4351, кабель micro-USB/USB-C.

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
| FPGA HDL | `fpga/tb/run_ghdl.sh` | GHDL-симуляция 8 тестбенчей ревизии legion (детектор/плеер/NCO/watchdog/CDC/мукс/регистры/интеграция) |
| FPGA хост | `python3 fpga/test/test_legion_fpga.py` | упаковщик байт-в-байт против C Nuand (вендоренное дерево), карта регистров, USB-константы, протокол шлюза |
| FPGA приёмка | `python3 fpga/test/acceptance_bench.py --gw <IP>` | E1–E6 на стенде с x40 (скрипт гоняет usb release/acquire вокруг стрим-фаз) |

CI (GitHub Actions) гоняет всё это + сборку прошивки под 6 плат + сборку
Tauri на каждый пуш; релизы (win/mac/linux бандлы) — по тегу `v*`.

## Документация

[architecture](docs/architecture.md) · [protocol](docs/protocol.md) ·
[wiring](docs/wiring.md) · [module-quirks](docs/module-quirks.md) ·
[compliance](docs/compliance.md) · [REFERENCES](docs/REFERENCES.md) ·
[datasheet-facts](docs/datasheet-facts.md) · [analysis-upgrade](docs/analysis-upgrade.md)

## Правовая заметка

Устройство — лабораторный генератор сигналов (макс. +5 дБм ≈ 3 мВт). Разработка
и тесты — на эквивалент антенны 50 Ом / в экранированной среде. Излучение в
эфир регулируется законодательством — см. [docs/compliance.md](docs/compliance.md).
