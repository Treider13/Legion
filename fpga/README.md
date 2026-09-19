# LEGION FPGA — ревизия `legion` для bladeRF 1 x40 и bladeRF 2.0 micro xA4/xA9

Автономный тракт в FPGA: плеер волны из RAM, DDS-тон, loopback RX→TX
(по детектору энергии или постоянный), watchdog-deadman. Управление и
мониторинг — с ноутбука по Ethernet через шлюз (мини-ПК с USB3 к плате).

**Онбордовый перехват (режим «Автоматический перехват»):** после Старта
хозяин один — SDR. Ноутбук задаёт коридор, выдержку усилителя на найденной
частоте (можно 0.4 мс), Старт/Стоп и наблюдение.
Антенна SMA → RX. Плата сама смотрит эфир в аналоговом окне взгляда
(шаг сетки = фильтр; потолок x40 ≤28 МГц, micro ≤56 МГц, каталог Nuand)
и сама открывает TX на усилитель по SMA. USB в круге «увидел → усилитель»
не участвует: IQ на компьютер не гоняется, хозяин кабеля на каждый пик
не меняется.

Два времени, их нельзя смешивать:

- Частота уже в окне платы → гейт I²+Q² как раньше, микросекунды
  (16 сэмплов; при 2 MSPS = 8 µs, при 28/56 MSPS — доли микросекунды).
- Надо обежать коридор шире взгляда → плата шагает LO. Пустой взгляд —
  hop после ~5 мс тишины. Нашёл энергию (TURN) — держит выдержку от
  первого det, затем следующий взгляд; PRIORITY остаётся, пока энергия есть.
  Две частоты ближе взгляда — одно TX-окно.

Порог детектора задаёт оператор (дефолт регистра 5000). Полка USB-IQ
в этом круге не меряется. Watchdog (kick 500 мс / FPGA ~1 с) и Стоп
работают как раньше. Режим «Эфир + FPGA» (хост шлёт `tune` на каждый
dwell) не тронут.

Регистр выдержки — микросекунды (`SCAN_DWELL_US`). Смена единицы и логики
TURN (якорь от детекта, не от входа во взгляд) — в образе NIOS: после
обновления исходников нужна сборка Quartus и прошивка `legionx*.rbf`.

На micro LO/fs/BW ставит NIOS (`rfic_command_write_immed`). На x40
sample-rate — Si5338: один park Soapy при Старт, дальше NIOS шагает
LMS (`lms_set_precalculated_frequency` + `band_select`). На время PLL
глушится CONTROL bit2 (LMS TX); bit1 (RX) жив — tamer и детектор.

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
   ramp-down на спаде det_active/отмена рампы/watchdog посреди рампы/
   голодание FIFO), регистры (CDC, heartbeat-toggle, кламп WD_LIMIT,
   статус), интеграция dcfifo+mux (два домена, порядок 16/16).
2. **NIOS C — синтаксис и поведение на ПК** (`fpga/test/check_nios_syntax.sh`
   + `fpga/test/run_nios_work_test.sh`, оба в CI): `legion_cmds.c` (мастер и
   вендоренная копия) и main-loop обеих платформ компилируются gcc против
   реальных заголовков Nuand в трёх конфигах (x40 / micro без libad936x /
   micro+RFIC); зонд `nios_probe_rfic.c` доказывает, что RFIC-ветка активна
   ровно в micro-rfic (без `#include "devices.h"` она была мёртва и в
   реальной сборке — Makefile micro не задаёт `-DBLADERF_NIOS_LIBAD936X`).
   Поведенческий тест с записывающими стабами PIO/RFIC: deadman
   (`legion_work` по wd_fired → CTRL=0 + standby/CONTROL, однократность),
   порядок TXMUTE в AIR_PREP, readback GAINMODE≠MGC → отказ.
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

1. Установить **Quartus Prime Lite 23.1.1** (вендоренный
   `fpga/vendor/bladerf/hdl/README.md` фиксирует эту версию: «version 23.1.1,
   which the bladeRF project files are based upon»; пакеты Cyclone IV для
   bladeRF 1 / Cyclone V для micro ставятся отдельно, NIOS II там же —
   `~/intelFPGA_lite/23.1std/nios2eds/`).
2. Сборка (из nios2_command_shell):
   ```bash
   cd fpga/vendor/bladerf/hdl/quartus
   ./build_bladerf.sh -b bladeRF -s 40 -r legion        # bladeRF 1 x40
   ./build_bladerf.sh -b bladeRF-micro -s A4 -r legion  # bladeRF 2.0 micro xA4
   ```
3. Загрузка **в RAM** (разработка, ноль риска): `bladeRF-cli -l legionx40.rbf`.
   После приёмки — во flash: `bladeRF-cli -L legionx40.rbf` (autoload).
   Откат: питание off/on (при `-l`) или прошить официальный `hostedx40.rbf`.
   Имя артефакта — из `build_bladerf.sh` (`$rev"x"$size.rbf`): `legionx40.rbf`,
   `legionxA4.rbf`, `legionxA9.rbf` в каталоге `legionx<size>-<дата>/`.
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

0. Прошивка ревизии в плату: вкладка **КАСТОМ FPGA** в приложении
   (СОБРАТЬ из `fpga/` — нужен Quartus 23.1.1 на этом ПК — затем ПРОШИТЬ:
   `bladeRF-cli -l` локально или `{"op":"flash","path":"/abs/legionxA4.rbf",
   "action":"load"}` на шлюзе, файл заранее на машине шлюза). Шлюз при
   acquire читает 0x80: hosted отвечает invalid id → `ping`/`status` несут
   `legion:false` и ARM отказывает с причиной (не молчаливый отказ).
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
- **Analog RX+TX в lb_*-режимах** включается штатным CONTROL-регистром
  (target 0x01, бит 1 = `lms_rx_enable`, бит 2 = `lms_tx_enable` — факт из
  `pack()` в `bladerf_p.vhd`), RMW, без libbladeRF. nco/player включают
  только TX. Снимается при DISARM. Без бита 2 LMS аналог на TX SMA молчит —
  mux может считать, а усилитель ничего не получит.
- **Цифровой IQ LMS не зависит от USB после ARM.** `lms6002d` гейтит сэмплы
  `rx_enable`/`tx_enable` с FX3 DMA. После `park` Soapy закрывается — DMA
  выключен. HDL держит цифровой RX, пока analog RX (CONTROL bit1) жив, и
  цифровой TX, пока FPGA ARM. `fifo_reader`/`fifo_writer` остаются на FX3:
  USB FIFO может overflow/underflow (косметика), тап детектора и mux — до них.
- **Эфир+FPGA — bladeRF 1 x40 и bladeRF 2.0 micro xA4/xA9.** Парковка везде
  через Soapy (RX/TX LO, fs = 2 MSPS, BW 2 МГц, readback с допусками).
  Разница — в подъёме аналога после ухода хоста с USB:
  - **x40 (LMS6002D):** шлюз пишет CONTROL bit1/2 (`bladerf_p.vhd`), RMW.
    Чип держит состояние сам — цифровой IQ не зависит от USB после ARM.
  - **micro (AD9361):** CONTROL-битов там нет, а хост при закрытии handle
    гасит RFIC (факт libbladeRF: `bladerf2_close` → `rfic->standby` →
    clear RFFE + `ad9361_deinit`; SoapyBladeRF `closeStream` →
    `bladerf_enable_module(false)`). Поэтому тракт поднимает NIOS-прошивка:
    шлюз пишет AIR_FREQ_KHZ (+AIR_GAIN_DB) и AIR_PREP → `legion_cmds.c`
    через штатный RFIC-интерфейс Nuand для FPGA-tuning
    (`rfic_command_write_immed`, devices_rfic.c) делает INIT(ON) →
    **TX mute** → LO/fs/BW → GAINMODE=MGC + **readback** + GAIN (ровно то
    усиление, при котором хост мерил полку) → ENABLE → **TX unmute
    последним**. Mute на всю перестройку — потому что RFIC-апдейты могут
    перезапускать TX-калибровку (апстрим позже ввёл guard TX_RECAL; в
    нашем дереве его нет). DISARM (CTRL=0) уводит RFIC в
    STANDBY сам. ARM lb_* без AIR_PREP на micro — отказ в NIOS.
    Первый AIR_PREP после питания — полный ad9361_init (сотни мс, длинный
    таймаут у шлюза); дальше — тёплый рестор из standby.
  FAKE park, FAKE шлюз (`LEGION_FPGA_FAKE`) и сбой park → ARM нет.
  Player ARM только при `capture_done` (HDL: иначе нули на DAC). sleep не считается.
  park читает getFrequency/getSampleRate; RX и TX fs должны совпасть
  (loopback FIFO). Локальный USB открывается `driver=bladerf`, не первая
  плата Soapy; после open `getHardwareKey` сверяется с платой каталога
  (`bladerf1` для x40, `bladerf2` для micro) — подмены нет.
  HackRF/Pluto не подменяются. NCO/player — 2 MSPS.
  Окно детектора = 16/fs: на 2 MSPS = 8 мкс.
  **Порог lb_gated из захвата:** после парковки (USB ещё у хоста) захват IQ
  на 2 MSPS с отстройкой LO на 3.2 МГц от пика, медиана нижних 60% энергий
  окон по 16 сэмплов (как estimate_noise_floor сканера), det_thr = медиана × K
  (K=4 по умолчанию). Единицы совпадают с детектором 1:1: SoapyBladeRF
  CF32 = SC16Q11/2048 (bladeRF_Streaming.cpp), а ядро ADI отдаёт ADC
  sign-extended LSB-justified (ad_datafmt.v) — тап детектора в тех же кодах.
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
  2 Гц → запас 2× к таймауту 1 с по умолчанию. На micro tx_clock =
  ad9361.clock (2R2T DDR → DATA_CLK = 2×fs = 4 МГц при 2 MSPS — тот же
  юнит; стенд E5 подтверждает: wd_fired ≤ ~1.5 с после потери kick).
- **Deadman end-to-end, слои:** heartbeat генерирует ПРИЛОЖЕНИЕ на ноутбуке
  (500 мс, пока ARM), агент шлюза только релеит. Замерло любое звено
  (app/TCP/агент/USB) → kicks прекращаются → **FPGA** гасит цифру сам
  (~1 с, нули с каденсом) → **NIOS** (`legion_work` в main-loop) видит
  wd_fired при живом ARM и сам делает DISARM: CTRL=0 (на micro тот же
  CTRL=0 уводит RFIC в standby), на x40 снимает lms_rx/tx_enable в CONTROL
  (NIOS — хозяин этого PIO). HDL-бит wd_fired после CTRL=0 гаснет за
  микросекунды (enable=0 сбрасывает expired) — поэтому NIOS держит
  **липкий латч в STATUS bit4** до следующего ARM, иначе хост читал бы
  пульс никогда (E5 и fpgaPollStatus смотрят именно wd_fired) →
  **шлюз** по `kick_age` (`LEGION_KICK_TIMEOUT_S`, дефолт 2.5 с) делает
  DISARM → USB release (именно в этом порядке) — сканер/ожившая панель
  снова открывают Soapy.
  Агент НЕ генерирует heartbeat сам — иначе TX жил бы после смерти
  ноутбука. Тихий выход агента: SIGTERM/SIGINT/atexit → DISARM + release
  (wiki Nuand: kill без libusb_close роняет Intel XHCI); systemd unit —
  `fpga/systemd/legion-gateway.service` (Restart=on-failure).
  USB re-enumerate: acquire проверяет FPGA (`QUERY_FPGA_STATUS`, как
  `usb_is_fpga_configured` в libbladeRF) — пустая (питание xA4 от USB!) →
  автозагрузка `LEGION_FPGA_RBF` или честный отказ; сбой xfer → один
  ретрай с re-acquire.
- **lb_gated требует явного порога:** `arm` без `det_thr` в этой сессии →
  отказ (порог 0 = гейт открывается на шум). Явный `det_thr` ниже floor
  (`LEGION_DET_THR_FLOOR`, дефолт 1) → отказ; приложение считает свой пол
  из полки (`FPGA_DET_THR_FLOOR=64`: медиана 16 при K=4 — деградированный
  захват, ARM не даёт).
- **det_active — уровень, det_count — каждое окно с детектом** (не фронт!).
  Автовозврат хоста — по stagnation det_count: не растёт ~1.2 с
  (`FPGA_AIR_GONE_MS`, не «N тиков»: опрос 80 мс иначе сжёг бы окно в 240 мс)
  = ни одного окна с энергией = «пропала».
  Счётчик по фронту замер бы на непрерывной цели и сорвал живой ARM
  (ревью 2026-08-28, tb: два окна подряд → count=2).

## Этапы приёмки на железе (runbook)

Перед сборкой: `fpga/check_toolchain.sh` — проверит Quartus 23.1.1,
nios2_command_shell, bladeRF-cli, pyusb (честные FAIL с инструкциями).

Отличия micro (xA4/xA9) от x40 при приёмке скрипт закрывает сам
(`--board micro` или авто-детект по `ping.board`): вместо `{"op":"rx"}`
(CONTROL на micro не существует) RX для детектора поднимается записью
`air_prep=0x7` после ARM; ARM всегда с `freq_mhz` (LO для AD9361); первый
ARM после питания длиннее (полный ad9361_init в NIOS при AIR_PREP).
Остальные этапы те же.

Сборка micro: AIR_PREP живёт в NIOS и требует `BLADERF_NIOS_LIBAD936X`
(RAM_SPAN ≥ 128 KiB, devices.h — как у штатного FPGA-tuning; стоковая
nios_system micro его имеет). Без него AIR_PREP честно отказывает —
ARM lb_* на micro не взведётся (и это видно в ответе шлюза).

Автоматическая приёмка на стенде (ноутбук → Ethernet → шлюз с платой,
на шлюзе `legion_gateway.py`; кабель TX→RX через аттенюатор для E2/E4):

```bash
pip install -r fpga/requirements.txt
fpga/test/run_acceptance.sh --gw <IP шлюза> [--board micro] [--ssh user@шлюз] [--skip-e6]
# --board можно не давать: агент отвечает board в ping, скрипт сам определит.
# --ssh: SoapySDRServer на шлюзе поднимается/гасится автоматически (иначе —
# паузы Enter). Лог и JSON-отчёт — в fpga/test/results/.

# Зелёный прогон с автокоммитом доказательства в репозиторий:
fpga/test/run_acceptance_and_commit.sh --gw <IP шлюза> [--board micro] [--ssh user@шлюз]
# Коммитит ТОЛЬКО при ALL PASS (ok:true в JSON читается из файла, не по слову
# раннера); красный прогон не коммитится никогда. Уже существующий зелёный
# отчёт: --commit-only fpga/test/results/acceptance-<время>.json
```

**Без зелёного прогона E1–E6 на целевой плате система стабильной не
считается** — симуляция и хост-тесты не подменяют стенд. Образ Quartus
(STA WNS/TNS≥0, hash RBF) собирается на машине с Quartus 23.1.1; в этом
репозитории отчёт timing не подделывается. Нет кабеля TX1→RX1 на E2 = FAIL.

| Этап | Что скрипт делает | Критерий |
|---|---|---|
| E1 | ping агента + запись регистров | канал/образ живы |
| E2 | NCO 250 кГц из FPGA; RX on (x40: CONTROL bit1; micro: air_prep=0x7 после ARM); det_count | растёт с кабелем TX1→RX1. Нет кабеля = FAIL, не SKIP |
| E3 | capture_arm → usb release → стрим QPSK (воркер/SoapyRemote) → acquire → capture_done → arm player | playing=1, волна в RAM FPGA |
| E4 | det_thr → стрим тона → det_count | вырос (гейт TX — по HDL-симуляции, на стенде вторым приёмником) |
| E5 | перестаём слать kick → опрос до wd_fired (дедлайн 4 с) | wd_fired=1; латентность измеряется. WD_LIMIT всегда от fs (2e6 → micro 31 ≈1.0 с, x40 61 ≈1.0 с) |
| E6 | оператор: `bladeRF-cli -L`, power cycle | канал жив после перезагрузки (наш образ) |

Один владелец USB: скрипт сам гоняет `usb release/acquire` агента вокруг
стрим-фаз (SoapySDRServer на шлюзе поднимается вручную по подсказке).

## Soak-тест (длительная работа, 8–24 ч)

После зелёной приёмки — длительный прогон ретрансляции (lb_gated, нагрузка
50 Ом). Скрипт держит ARM, шлёт heartbeat как приложение, пишет JSONL-журнал
каждого опроса и считает перезапуски (watchdog), ошибки и предупреждения
шлюза об охлаждении:

```bash
python3 fpga/test/soak_bench.py --gw <IP шлюза> --hours 8 [--freq 2450] [--det-thr 1000]
# x40: LO шлюзом не паркуется (LMS6002D настраивает хост) — дайте --ssh
# user@<шлюз>: скрипт сам сделает release → bladeRF-cli set frequency → acquire.
# micro: LO уходит в ARM через freq_mhz, --ssh не нужен.
```

Отчёт — `fpga/test/results/soak-<время>.md` (вердикт PASS/FAIL), журнал —
рядом `.jsonl`. Артефакты реального стенда коммитятся осознанно
(`git add -f fpga/test/results/...`) — это и есть доказательство стабильности
платы. Температуры AD9361 в этой NIOS-сборке нет (командный набор RFIC без
неё) — вместо неё таймер длительной работы `LEGION_ARM_WARN_S` (дефолт 5 мин)
с предупреждением в status и в UI.
