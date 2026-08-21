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
| `tb/` | GHDL-тестбенчи + `run_ghdl.sh` (7/7 PASS) |
| `nios/` | `legion_cmds.c/h` — обработчик регистров на NIOS II (target 0x80) |
| `host/` | `legion_fpga.py` (регистровый API), `legion_gateway.py` (TCP↔USB агент шлюза), `gen_sine_lut.py` |
| `integration/` | Патчи к дереву Nuand: топ-левел, `bladerf_p.vhd`, `pkt_8x32.c`, сниппет `nios_system.tcl` |
| `test/` | `test_legion_fpga.py` — золотой тест упаковщика против реального C-заголовка Nuand (gcc), зеркало карты регистров, протокол шлюза |

## Проверено без железа (факты этой ревизии)

1. **GHDL-симуляция всех модулей: 7/7 PASS** (`fpga/tb/run_ghdl.sh`):
   детектор (порог/окно/счётчик), плеер (capture→play по кругу, каденс valid
   каждый 2-й такт — контракт LMS6002D), NCO (частота по нулям Q, амплитуда),
   watchdog (expiry/heartbeat), dcfifo (CDC, порядок), мультиплексор
   (PASS/тишина-с-каденсом/гейтинг/watchdog), регистры (CDC, heartbeat-toggle,
   статус).
2. **Топ-левел `bladerf-legion.vhd` проанализирован GHDL**: все legion-юниты
   привязались, порты инстансов сверены с сущностями; остаются только
   ожидаемые «unit not found» для vendor-IP (pll, fifo, nios_system) — они
   существуют только в Quartus.
3. **Упаковщик пакетов байт-в-байт совпал с настоящим
   `nios_pkt_8x32_pack()` Nuand** (90 векторов, gcc против
   `fpga_common/include/nios_pkt_8x32.h`).
4. **NIOS C** (`pkt_8x32.c` + `legion_cmds.c`) компилируется синтаксически
   против реальных заголовков дерева Nuand.

Не проверено здесь (нужен стенд): компиляция Quartus и работа на плате —
см. этапы приёмки ниже.

## Сборка (проверено по README/wiki Nuand)

1. Клонировать `https://github.com/Nuand/bladeRF` (зафиксировать коммит;
   патчи `integration/*.diff` сгенерированы против него).
2. Установить **Quartus Prime Lite 20.1.1** (README Nuand прямо фиксирует эту
   версию для bladeRF 1; более новые не гарантируют поддержку Cyclone IV/NIOS II).
3. Применить интеграцию (патчи — git-формат, проверены `git apply --check`
   на чистом дереве; топ-левел — НОВЫЙ файл, hosted не трогаем — ревизии
   сосуществуют, механизм Revisions из wiki Nuand):
   ```bash
   cd bladeRF
   cp $LEGION/fpga/integration/bladerf-legion.vhd hdl/fpga/platforms/bladerf/vhdl/
   git apply $LEGION/fpga/integration/bladerf_p-legion.diff          # порты nios_system
   git apply $LEGION/fpga/integration/pkt_8x32-legion.diff           # target 0x80 в NIOS
   cp $LEGION/fpga/hdl/*.vhd hdl/fpga/platforms/bladerf/vhdl/
   cp $LEGION/fpga/nios/legion_cmds.* hdl/fpga/platforms/common/bladerf/software/bladeRF_nios/src/
   cat $LEGION/fpga/integration/nios_system-legion.tcl.snippet >> hdl/fpga/platforms/bladerf/build/nios_system.tcl
   ```
   Затем зарегистрировать ревизию (wiki Nuand «FPGA Development»):
   - `hdl/fpga/platforms/bladerf/build/bladerf.tcl`: добавить `make_revision legion`;
   - `hdl/fpga/platforms/bladerf/vhdl/bladerf-legion.qip`: копия
     `bladerf-hosted.qip` + наши `hdl/*.vhd` (паттерн set_global_assignment
     из wiki); внутри сослаться на `bladerf-legion.vhd`;
   - `hdl/quartus/build_bladerf.sh`: добавить `legion` в список ревизий;
   - в `Makefile` NIOS-прошивки (`bladeRF_nios/Makefile`, C_SRCS) добавить
     `legion_cmds.c` и флаг `-DLEGION_FPGA`.
4. Сборка (из nios2_command_shell):
   ```bash
   cd hdl/quartus && ./build_bladerf.sh -b bladeRF -s 40 -r legion
   ```
5. Загрузка **в RAM** (разработка, ноль риска): `bladeRF-cli -l legion_x40.rbf`.
   После приёмки — во flash: `bladeRF-cli -L legion_x40.rbf` (autoload).
   Откат: питание off/on (при `-l`) или прошить официальный `hostedx40.rbf`.
   **Грабля из wiki Nuand:** `.sof` через JTAG (USB Blaster) работает только
   ПОСЛЕ инициализации платы штатным `.rbf` через bladeRF-cli — сначала `-l`,
   потом JTAG, не наоборот.

## Эксплуатация

1. На шлюзе: `python3 legion_gateway.py` (порт 5531; `LEGION_FPGA_FAKE=1` —
   проверка протокола без железа).
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

| Этап | Критерий |
|---|---|
| E1 hosted из исходников | плата работает со штатными функциями LEGION |
| E2 NCO из FPGA | линия на заданной частоте в RX-скане; START/STOP по Ethernet |
| E3 плеер | спектр/созвездие = превью LEGION; ноутбук отключён — играет |
| E4 детектор+гейт | инжект тона → TX за ≤10 мкс (по таймстемпам) |
| E5 watchdog | обрыв Ethernet/смерть хоста → TX off ≤ 1 с |
| E6 autoload | питание off/on → наш образ; откат на официальный |
