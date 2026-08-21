# LEGION FPGA — ревизия `legion` для bladeRF 1 x40

Автономный тракт в FPGA: плеер волны из RAM, DDS-тон, loopback RX→TX
(по детектору энергии или постоянный), watchdog-deadman. Управление и
мониторинг — с ноутбука по Ethernet через шлюз (мини-ПК с USB3 к x40).

**Правовая/безопасная рамка:** выход TX — только в нагрузку 50 Ом
(см. `docs/compliance.md`). Watchdog включён по умолчанию: пропал heartbeat
от хоста (~1 с) → TX гаснет сам, без участия ноутбука.

## Состав

| Каталог | Содержимое |
|---|---|
| `hdl/` | Модули VHDL-2008: `legion_pkg`, `legion_detector`, `legion_player`, `legion_nco`, `legion_dcfifo`, `legion_watchdog`, `legion_tx_mux`, `legion_regs` |
| `tb/` | GHDL-тестбенчи + `run_ghdl.sh` (8/8 PASS) |
| `nios/` | `legion_cmds.c/h` — обработчик регистров на NIOS II (target 0x80) |
| `host/` | `legion_fpga.py` (регистровый API), `legion_gateway.py` (TCP↔USB агент шлюза), `gen_sine_lut.py` |
| `integration/` | Патчи к дереву Nuand: топ-левел, `bladerf_p.vhd`, `pkt_8x32.c`, сниппет `nios_system.tcl` |
| `test/` | `test_legion_fpga.py` — золотой тест упаковщика против реального C-заголовка Nuand (gcc), зеркало карты регистров, протокол шлюза |

## Проверено без железа (факты этой ревизии)

1. **GHDL-симуляция всех модулей: 8/8 PASS** (`fpga/tb/run_ghdl.sh`):
   детектор (порог/окно/счётчик/кламп shift), плеер (capture→play по кругу,
   каденс valid каждый 2-й такт — контракт LMS6002D, тишина-с-каденсом до
   capture), NCO (частота по нулям Q, амплитуда), watchdog (expiry/heartbeat),
   dcfifo (CDC, порядок), мультиплексор (PASS/тишина-с-каденсом/гейтинг/
   watchdog/голодание FIFO), регистры (CDC, heartbeat-toggle, кламп WD_LIMIT,
   статус), интеграция dcfifo+mux (два домена, порядок 16/16).
2. **Топ-левели обеих платформ проанализированы GHDL**: bladeRF 1
   (`bladerf-legion.vhd`) и micro (`platforms/bladerf-micro/vhdl/bladerf-legion.vhd`)
   — все legion-юниты привязались, порты инстансов сверены с сущностями;
   остаются только ожидаемые «unit not found» для vendor-IP (pll, fifo,
   nios_system, ad9361) — они существуют только в Quartus. (Для micro пакет
   `bladerf_p.vhd` Nuand использует deferred-константы в теле — GHDL mcode их
   не принимает, Quartus принимает; проверка шла с check-only шимом пакета,
   поставляемый файл не тронут.)
3. **Упаковщик пакетов байт-в-байт совпал с настоящим
   `nios_pkt_8x32_pack()` Nuand** (90 векторов, gcc против
   `fpga_common/include/nios_pkt_8x32.h`).
4. **NIOS C** (`pkt_8x32.c` + `legion_cmds.c`) компилируется синтаксически
   против реальных заголовков дерева Nuand.

Не проверено здесь (нужен стенд): компиляция Quartus и работа на плате —
см. этапы приёмки ниже.

## Сборка (всё в репозитории — сеть не нужна)

Вендоренное дерево Nuand лежит в `fpga/vendor/bladerf/` (подмножество,
commit и лицензия — в `fpga/vendor/UPSTREAM.txt`, FPGA HDL = MIT).
Интеграция legion **уже применена** к дереву (обе платформы: bladeRF 1 x40
и bladeRF 2.0 micro). Внешний инструмент ровно один — Quartus.

1. Установить **Quartus Prime Lite 20.1.1** (README Nuand прямо фиксирует эту
   версию для bladeRF 1; более новые не гарантируют поддержку Cyclone IV/NIOS II).
2. Сборка (из nios2_command_shell):
   ```bash
   cd fpga/vendor/bladerf/hdl/quartus
   ./build_bladerf.sh -b bladeRF -s 40 -r legion        # bladeRF 1 x40
   ./build_bladerf.sh -b bladeRF-micro -s A4 -r legion  # bladeRF 2.0 micro xA4
   ```
3. Загрузка **в RAM** (разработка, ноль риска): `bladeRF-cli -l legion_x40.rbf`.
   После приёмки — во flash: `bladeRF-cli -L legion_x40.rbf` (autoload).
   Откат: питание off/on (при `-l`) или прошить официальный `hostedx40.rbf`.
   **Грабля из wiki Nuand:** `.sof` через JTAG (USB Blaster) работает только
   ПОСЛЕ инициализации платы штатным `.rbf` через bladeRF-cli — сначала `-l`,
   потом JTAG, не наоборот.

### Если обновляете апстрим Nuand (не обязательно)

`fpga/vendor/sync_vendor.sh <ref>` синхронизирует подмножество, после чего
интеграцию нужно применить заново: патчи `integration/*.diff` (git-диффы,
проверены `git apply --check`), топ-левели — `integration/bladerf-legion.vhd`
(bladeRF1) и вендоренный `platforms/bladerf-micro/vhdl/bladerf-legion.vhd`
(micro), сниппет `nios_system-legion.tcl.snippet`, регистрация ревизии в
`platform.conf`/`bladerf.tcl`, qip, NIOS Makefile (C_SRCS + -DLEGION_FPGA).
Мастера модулей — `fpga/hdl/` (GHDL-тесты); расхождение vendor↔hdl ловит CI.

## Эксплуатация

1. На шлюзе: `python3 legion_gateway.py` (порт 5531; `LEGION_FPGA_FAKE=1` —
   проверка протокола без железа). **Авторизация:** задайте
   `LEGION_FPGA_TOKEN=<секрет>` на агенте — тогда каждая команда (кроме ping)
   требует токен; в приложении — поле «ТОКЕН ШЛЮЗА» на вкладке ТИП СИГНАЛА.
   Без переменной — открытая доверенная LAN стенда (как WiFi AP прошивки).
2. LEGION на ноутбуке: вкладка ТИП СИГНАЛА → блок FPGA — ARM/СТОП/статус.
   Режимы: `player` (волна из RAM), `nco` (тон), `lb_gated` (RX→TX по
   детектору), `lb_always` (RX→TX постоянно), `pass` (обычный стрим).
3. Загрузка волны в RAM: capture_arm=1 → обычный TX-стрим волной
   (существующая ЗАШИТЬ) → capture_done=1 → режим `player`.
   Во время capture поток идёт и на LMS (слышно, что грузим — в нагрузку).

## Эксплуатационные факты (сверены с форумами/даташитами)

- **ОДИН владелец USB на шлюзе.** Факт из дескриптора FX3
  (`fx3_firmware/src/cyfxbladeRFusbdscr.c`): у x40 один интерфейс с
  alt-settings (0=idle, 1=RF, 2=FX3 fw, 3=FPGA load), peripheral-эндпоинт
  NIOS (0x02/0x82) живёт внутри RF alt-setting. Интерфейс захватывается
  эксклюзивно → **SoapySDRServer и legion_gateway одновременно на одном
  x40 не работают**. Порядок: стрим-режим = SoapySDRServer; FPGA-режим =
  наш агент (стрим-сервер остановить). Прошивка: стоп агент →
  `bladeRF-cli -l/-L` → старт агент.
- **RX в lb_*-режимах включается штатным CONTROL-регистром** (target 0x01,
  бит 1 = `lms_rx_enable` — факт из `pack()` в `bladerf_p.vhd`), RMW,
  без libbladeRF: агент делает это сам при ARM и снимает при DISARM.
  Сэмплы при этом не читает никто — FIFO переполняется (косметика),
  тап детектора стоит до FIFO и работает.

- **Режим `lb_gated`/`lb_always` требует включённого RX** (rx_enable): детектор
  и loopback питаются от RX-потока. RX-стрим активирует и дочитывает воркер
  на ноутбуке (SoapyRemote, он же владелец устройства — агент шлюза устройство
  не делит): либо работает СКАН, либо drain-чтение. Если никто не читает —
  RX FIFO переполняется (флаг overflow — безвреден для тракта: тап детектора
  стоит до FIFO, но статус засоряется).
- **Усиление loopback** — грубый сдвиг `lb_shift` (0..8): переполнение 16 бит
  заворачивает знак (wrap), насыщения (saturation) в этой ревизии нет.
  Подбирать с осциллографом/сканом на стенде, начиная с 0.
- **Самовозбуд:** TX строго в нагрузку 50 Ом. С антенной на выходе loopback
  замкнётся сам на себя — это физика, не баг.
- **NCO FTW:** f = FTW·fs/2³², fs — частота сэмплов TX (у LEGION 2 МГц).
- **LED underflow TX** в автономных режимах может мигать: fifo_reader хоста
  видит пустой FIFO, когда мукс выбрал не хост. Косметика, на тракт не влияет.
- **FPGA ARM перекрывает хост-стрим** на мультиплексоре: режимы PLAYER/NCO/
  LB_* забирают TX у fifo_reader. Загрузка волны в RAM идёт в режиме PASS
  (стрим + capture_arm одновременно — слышно, что грузим, в нагрузку).
- **Watchdog-единица:** 2¹⁶ тактов tx_clock (≈16.4 мс при fs=2 МГц); heartbeat
  2 Гц → запас 2× к таймауту 1 с по умолчанию.
- **Deadman end-to-end:** heartbeat генерирует ПРИЛОЖЕНИЕ на ноутбуке
  (500 мс, пока ARM), агент шлюза только релеит. Замерло любое звено
  (app/TCP/агент/USB) → kicks прекращаются → watchdog в FPGA гасит TX сам.
  Агент НЕ генерирует heartbeat сам — иначе TX жил бы после смерти ноутбука.
- **lb_gated требует явного порога:** `arm` без `det_thr` в этой сессии →
  отказ (порог 0 = гейт открывается на шум).

## Этапы приёмки на железе (runbook)

Перед сборкой: `fpga/check_toolchain.sh` — проверит Quartus 20.1.1,
nios2_command_shell, bladeRF-cli, pyusb (честные FAIL с инструкциями).

Автоматическая приёмка на стенде (ноутбук → Ethernet → шлюз с x40,
на шлюзе `legion_gateway.py`; кабель TX→RX через аттенюатор для E2/E4):

```bash
pip install -r fpga/requirements.txt
python3 fpga/test/acceptance_bench.py --gw <IP шлюза> [--skip-e6]
```

| Этап | Что скрипт делает | Критерий |
|---|---|---|
| E1 | ping агента + запись регистров | канал/образ живы |
| E2 | NCO 250 кГц из FPGA; RX on (CONTROL bit1); det_count | растёт с кабелем (без кабеля — SKIP с подсказкой) |
| E3 | capture_arm → usb release → стрим QPSK (воркер/SoapyRemote) → acquire → capture_done → arm player | playing=1, волна в RAM FPGA |
| E4 | det_thr → стрим тона → det_count | вырос (гейт TX — по HDL-симуляции, на стенде вторым приёмником) |
| E5 | перестаём слать kick → ждём ~1.6 с | wd_fired=1 (TX погашен железом) |
| E6 | оператор: `bladeRF-cli -L`, power cycle | канал жив после перезагрузки (наш образ) |

Один владелец USB: скрипт сам гоняет `usb release/acquire` агента вокруг
стрим-фаз (SoapySDRServer на шлюзе поднимается вручную по подсказке).
