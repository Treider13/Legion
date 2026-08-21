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
3. Применить интеграцию:
   ```bash
   cd bladeRF
   patch -p0 < $LEGION/fpga/integration/bladerf-hosted-legion.diff   # → новая архитектура legion
   patch -p0 < $LEGION/fpga/integration/bladerf_p-legion.diff        # порты nios_system
   patch -p0 < $LEGION/fpga/integration/pkt_8x32-legion.diff         # target 0x80 в NIOS
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

## Эксплуатация

1. На шлюзе: `python3 legion_gateway.py` (порт 5531; `LEGION_FPGA_FAKE=1` —
   проверка протокола без железа).
2. LEGION на ноутбуке: вкладка ТИП СИГНАЛА → блок FPGA — ARM/СТОП/статус.
   Режимы: `player` (волна из RAM), `nco` (тон), `lb_gated` (RX→TX по
   детектору), `lb_always` (RX→TX постоянно), `pass` (обычный стрим).
3. Загрузка волны в RAM: capture_arm=1 → обычный TX-стрим волной
   (существующая ЗАШИТЬ) → capture_done=1 → режим `player`.

## Этапы приёмки на железе (runbook)

| Этап | Критерий |
|---|---|
| E1 hosted из исходников | плата работает со штатными функциями LEGION |
| E2 NCO из FPGA | линия на заданной частоте в RX-скане; START/STOP по Ethernet |
| E3 плеер | спектр/созвездие = превью LEGION; ноутбук отключён — играет |
| E4 детектор+гейт | инжект тона → TX за ≤10 мкс (по таймстемпам) |
| E5 watchdog | обрыв Ethernet/смерть хоста → TX off ≤ 1 с |
| E6 autoload | питание off/on → наш образ; откат на официальный |
