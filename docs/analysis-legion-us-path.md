# LEGION — путь «нашёл → SDR → усилитель за микросекунды»

Снимок: `c213041`. Код не менялся. Источники: исходники репозитория, GitHub Nuand,
форум Nuand, EngineerZone ADI, LMS FAQ (как их цитируют на форуме).

Запрос: кастомная прошивка **встала** и по замыслу **нашла сигнал, отдала его
на SDR и с SDR на усилитель за микросекунды**. Ниже это разобрано как
единственный физический путь, который вообще может быть микросекундным.
Что именно едет на усилитель, если «нашлась 2450»: аналоговый взгляд
2445…2455, не тон — [analysis-legion-look-window.md](analysis-legion-look-window.md).
Кабель: антенна RX1, PA на TX1 (не на RX1) —
[analysis-legion-rx1-tx1.md](analysis-legion-rx1-tx1.md).
Ничего не отложено: либо пункт обязателен для этого пути, либо замыслом
исключён и это доказано.

---

## 1. Что означает фраза «на SDR» — закрытое определение

BladeRF **и есть** SDR. Кастомная ревизия `legion` живёт **внутри FPGA этой
платы**, не на ноутбуке и не на втором приёмнике.

Микросекундный тракт в документах продукта записан так:

> «Честный бюджет: host USB3/Soapy retune — сотни µs…мс. […] Микросекунды
> detect→TX: FPGA `lb_gated` […] Плата […] сама открывает TX на усилитель.
> USB в круге «увидел → усилитель» нет.»
> (`docs/architecture.md` 94–104)

Цепочка, которая соответствует запросу:

```
антенна RX SMA
    → RFIC (AD9361 / LMS6002D) ADC
    → FPGA: детектор I²+Q² + dcfifo
    → FPGA mux lb_gated
    → dac_streams  →  тот же RFIC DAC
    → TX SMA  →  усилитель  →  50 Ом
```

«Передала на SDR» = сэмплы сели на **TX этого же bladeRF** (`dac_streams` →
AD9361/LMS). Не «на программу SDR на ноутбуке».

Это не толкование. Топ-левел micro так и связан:

```1246:1248:fpga/vendor/bladerf/hdl/fpga/platforms/bladerf-micro/vhdl/bladerf-legion.vhd
    dac_streams(0).data_i <= lg_mux_i;
    dac_streams(0).data_q <= lg_mux_q;
    dac_streams(0).data_v <= lg_mux_valid;
```

Детектор и FIFO питаются с `adc_streams(0)` (тот же файл, 1131–1206).

**Путь через ноутбук (Soapy / GNU Radio / «ПЕРЕДАТЬ» волной) микросекундным
не является.** Это написано в том же абзаце architecture.md. Форум Nuand
говорит то же самыми словами.

---

## 2. Что люди уже проверили на этом железе (форумы / GitHub)

### 2.1 Headless repeater на micro: adc→dac, USB обойти

[nuand.com/forums t=13120](https://nuand.com/forums/viewtopic.php?t=13120)
(уже в `docs/REFERENCES.md`):

- KeshinB: нужен репитер **без сэмплов с ПК**; пишет ли `dac_streams` в AD9361?
- MutluAYDIN: «If you need **low delay**, modify VHDL and connect
  `adc_streams` to `dac_streams`. If not, connect RX and TX **in the host/PC**
  with GNURadio or CLI.»
- KeshinB (после опыта): «Reading from the adc_stream and writing to the
  dac_stream **worked perfectly and allowed me to bypass the USB interface**.»

Legion — та же врезка, плюс гейт по энергии. Значит замысел «за микросекунды»
= именно этот класс решения, не хост.

Репозиторий сам ссылается на эту ветку как подтверждённый кейс.

### 2.2 Стокового RX→TX mux у Nuand нет — нужна кастомная FPGA

[nuand.com/forums t=3905](https://nuand.com/forums/viewtopic.php?t=3905),
ifrasch (автор bladeRF-shd, референс `legion_detector.vhd`):

> «There is currently no RX→TX loopback mode, only TX→RX. You'd need to add
> some custom logic to the FPGA.»

Это прямое обоснование, зачем ревизия `legion` вообще существует. Hosted
образ **не** делает «нашёл → на усилитель за микросекунды».

### 2.3 USB не даёт микросекунды на RF

[nuand.com/forums t=5197](https://nuand.com/forums/viewtopic.php?t=5197):
попытка мерить USB3 latency через FX3 firmware loopback в GNU Radio —
задержка хоста/буферов, не аналоговый тракт. Ответ: USB сам вносит
задержку.

[nuand.com/forums t=13047](https://nuand.com/forums/viewtopic.php?t=13047),
robert.ghilduta (Nuand): RX и TX на micro делят один sample clock AD9361;
если USB не тащит — «put a modulator in VHDL» (foxhunt / `tone_generator`),
а не гнать IQ на ПК.

### 2.4 Без FIR 4x sample-rate ниже ~2.1 MSPS не поддерживается

[GitHub Nuand/bladeRF#581](https://github.com/Nuand/bladeRF/issues/581),
закрыто PR [#593](https://github.com/Nuand/bladeRF/pull/593), автор rtucker
(Nuand):

> «Currently, we're limited to the minimum sample rate of the AD9361 library
> (**2083334** samples/sec). It should be possible to enable the **4x
> interp/decim on the FIR filters** to support sample rates down to
> **520834**.»

PR #593: «To support sample rates below ~2.1 Msps, interpolation/decimation
**must** be enabled on the RFIC's FIR filter.»

Вендоренный комментарий к DEC4-коэффициентам (`ad936x_params.c` 903–906):

> «This filter is intended to allow sample rates down to 520834 sps. It is a
> **128-tap, decimate-by-4** filter. Note that you **MUST** use an
> interpolate-by-4 filter on TX if you are using this filter.»

Диапазон 4x в нашем дереве: 520834…**2083334**
(`bladerf2_common.h` 534–538). Дефолт Legion 2 000 000 **внутри** этого
диапазона. Окно 0.2 МГц (520834) — нижняя граница того же правила.

### 2.5 Задержка самого AD9361 (не FPGA)

[EngineerZone: latency thru AD9361](https://ez.analog.com/fpga/f/q-a/165600/latency-thru-ad9361)
(уже в REFERENCES.md), FMCOMMS, 20 MSPS, кабель TX→RX:

| Путь | Такты RXCLK | При 20 MSPS |
|---|---|---|
| axi_ad9361 IP | 26, всегда | 1.3 мкс |
| AD9361 digital BIST loopback | 67, всегда | 3.35 мкс |
| AD9361 внешний RF loopback | **94–102**, плавает после POR | 4.7–5.1 мкс |

Это порядок **микросекунд** через чип. Не миллисекунды.

### 2.6 LMS (x40) — FAQ, как цитируют на форуме

[nuand.com/forums t=3764](https://nuand.com/forums/viewtopic.php?t=3764)
(DRFM/repeater): LMS6002DFN FAQ — ~300 нс на фильтр 5 МГц и **10 сэмплов**
латентности ADC и DAC. При 2 MSPS 10 сэмплов = 5 мкс на сторону, плюс
аналог. Снова микросекунды, если IQ не уходит на USB.

### 2.7 ADI: FIR не «бесплатный»

Wiki AD9361: 128-tap FIR + half-band задают group delay; коэффициенты
зависят от rate/BW; сменил rate без нового фильтра — «negatively affect
overall baseband performance».
[wiki.analog.com/ad9361](https://wiki.analog.com/resources/eval/user-guides/ad9361)

Линейная фаза 128 taps, DEC4: задержка ≈ (128−1)/2 тактов FIR-клока.
FIR-клок = 4·fs → ≈ **16 выходных сэмплов** на RX FIR. На TX INT4 — тот же
порядок. Это не отменяет микросекунды, но **входит в бюджет** и требует,
чтобы FILTER был включён, иначе rate 2e6/520834 по правилу Nuand не
настроен.

---

## 3. Бюджет «нашёл → усилитель» по коду Legion

Две разные задержки. Их нельзя складывать в одну цифру «0.4 мс».

### 3.1 Гейт (когда энергия уже в текущем взгляде) — микросекунды

| Ступень | Факт | 2 MSPS (дефолт) | 0.520834 MSPS |
|---|---|---|---|
| Окно детектора | `FPGA_US_DET_SHIFT=4` → 16 сэмплов (`fpgaFastpath.ts` 15, 179–182); первый `det_active` после полного окна (`legion_detector.vhd`) | **8.0 мкс** | **30.7 мкс** |
| CDC `det_active` | `synchronizer` rx→tx (`bladerf-legion.vhd` 1144–1147) | 2 такта tx_clock | то же |
| FIFO RX→TX | глубина 64, «только фазовый разнос» (`legion_dcfifo.vhd` 6–7) | единицы сэмплов (~1–3 мкс) | единицы сэмплов (~4–8 мкс) |
| Mux | гейт режет данные, каденс valid жив (`legion_tx_mux.vhd` 138–145) | 1 сэмпл | 1 сэмпл |
| AD9361 RX+TX аналог+HB | EZ 94–102 такта на 20 MSPS как ориентир порядка | ~5 мкс класс | растёт, всё ещё десятки мкс |
| RX FIR DEC4 128t + TX INT4 | обязательно при fs≤2083334 (§2.4) | ~8 + ~8 мкс | ~31 + ~31 мкс |

**Итог порядка (не замер SMA):** при 2 MSPS — **десятки микросекунд** от
появления энергии в уже выбранном взгляде до IQ на DAC и ещё столько же
через аналог. При 0.2 МГц — **порядка 0.1 мс**, всё ещё не USB-миллисекунды.

Ramp-down 31 ступень (`legion_tx_mux.vhd` 58–59) — на **закрытие** гейта
(~16 мкс @ 2 MSPS), не на открытие.

Это расчёт по коду и публикациям. **Доказательство на SMA — обязательный
пункт приёмки (§6), не «потом».**

### 3.2 Обзор коридора (сменить взгляд) — не микросекунды

Walker NIOS шагает LO (`legion_hop_lo`). PLL AD9361/LMS — сотни микросекунд
… миллисекунды (сам продукт это отделяет: «два времени», architecture.md
104–109). Выдержка 0.4 мс — **удержание стоянки после первого det**, не
скорость гейта.

Замысел «за микросекунды» относится к **гейту в уже стоящем взгляде**, не
к обходу 100 МГц коридора.

### 3.3 Что ломает микросекундный бюджет

| Если сделать так | Что получается | Источник |
|---|---|---|
| IQ на ноутбук и обратно | сотни µs…мс | architecture.md 94–95; форум t=5197, t=13120 |
| USB-handoff (`fpgaHandoff`) | смена хозяина USB на каждый пик | architecture.md 113–116; store.ts 1432 — убран из Старта, код жив |
| Hosted FPGA, не legion | нет mux 0x80, ARM отказ | `gateway.py` 709–713 |
| Нет FIR 4x при fs≤2.083e6 | rate по Nuand не поддержан, взгляд/fs не те | #581, #593, ad936x_params.c |
| AIR_PREP не поднял RX+TX | ADC/DAC молчат, гейт гейтит тишину | `legion_cmds.c` 642–650 |
| Отказной ARM оставил TX unmute | «нашло» врёт, усилитель уже под током | U1–U4 предыдущего разбора |

---

## 4. «Прошивка встала» — полный критерий, не ping

Кастомный образ должен быть **тем** `legionxA4/xA9/x40.rbf`, что собран из
этого дерева, с запасом timing, и NIOS с `BLADERF_NIOS_LIBAD936X` на micro.

| # | Факт | Обязанность | Приёмка |
|---|---|---|---|
| L1 | Имя `legionx{40\|A4\|A9}.rbf`; A4↔A9 / x40↔micro отказ (`gateway.py` 576–594). PID xA4 и xA9 один 0x5250 | Прошить только совпавший size; probe `-p` до записи | Отказ до `-l` при несовпадении; после `-l` `ping.legion===true` |
| L2 | Hosted: 0x80 invalid → ARM «нет ревизии legion» | Не считать hosted «прошивка встала» | `op arm` отказ с этой причиной |
| L3 | micro AIR без libad936x честно отказывает (`legion_cmds.c` 202–207; README FPGA 262–265) | Сборка NIOS с RAM_SPAN≥128 KiB и `-DBLADERF_NIOS_LIBAD936X` | Зонд `nios_probe_rfic` + на плате AIR_PREP up |
| L4 | В repo нет STA-отчёта | Quartus 23.1.1, WNS/TNS≥0, отчёт+hash = прошитый файл | Образ с отрицательным slack не принимается |
| L5 | micro: хост close гасит RFIC (`bladerf2_close` → standby, комментарий `legion_cmds.c` 16–18) | После acquire NIOS поднимает INIT→mute→FIR→fs/BW→ENABLE→unmute | Readback FILTER/SAMPLERATE/BANDWIDTH = запрос |
| L6 | x40: Si5338 fs — один park Soapy, дальше NIOS только LMS (`fpga/README.md` 34–37) | Park readback fs/BW; look &lt; 1.5 МГц — отказ | 0.2 МГц на x40 не ARM |

«Встала» = L1–L6 одновременно. Ping после питания (нынешний E6) этого не
доказывает.

---

## 5. Каждая рекомендация — снова фактом, уже против микросекундного пути

| Rec | Подтверждена для этого замысла? | Факт | Без неё микросекунды? |
|---|---|---|---|
| **U1** валидация ARM до эфира | Да | `_air_enable` до SCAN bounds | Нет: отказной Старт может оставить TX. «Нашло» не начиналось, усилитель уже может петь |
| **U2** частичный AIR → STANDBY | Да | `air_is_up` в конце | Нет: RX без TX или наоборот — не repeater |
| **U3** DISARM не врать | Да | игнор `air_down` | Нет: Стоп не доказал тишину на SMA |
| **U4** hop без unmute на разных LO | Да | unmute в ветке fail | Нет: усилитель на чужой частоте во время «поиска» |
| **U5** readback SCAN | Да | чтение = STATUS | Нет: выдержка/коридор на плате не те, гейт живёт в другом взгляде |
| **U6–U7** 0,4 мс → 400 мкс | Да | `int(0.4)`, `parseFloat("0,4")` | Выдержка (не гейт) врёт; для коридора n>1 ломает очередь. Гейт 8 мкс от этого не зависит |
| **R1–R5** FIR 4x + readback fs | **Да, жёстче** | #581/#593; 2e6 и 520834 в range_4x; INIT ставит FIR DEFAULT | Нет: без 4x Nuand не считает rate валидным. Взгляд и 16/fs считают от фальшивого fs |
| **T1** WD от фактического fs | Да | limit=round(tx_clk/65536) | Deadman на чужом fs сожжёт TX среди микросекундного гейта или не сожжёт никогда |
| **T3** CDC det_count на x40 | Да | многобит без синка | Ложный автовозврат (старый handoff) или ложный UI. Гейт mux смотрит `det_active` после synchronizer — для SMA это отдельный бит |
| **T5** убить USB-handoff | **Да, критично** | форум: host = не low delay; store 1413 включает автовозврат хоста | Этот путь **уничтожает** микросекунды |
| **V1** водопад = взгляд | Да | `applyLook` | Не ломает SMA, ломает оператора («спектр») |
| **V3** герц внутри окна | Не дефект | взгляд = TX-окно | Замысел — релей взгляда, не пеленгатор. Новый FFT на xA4 «тесен» (REFERENCES.md 53) |
| **n=1 ARM жив** | Не дефект | план хоста + NIOS | Гейт должен жить, пока энергия и нет Стоп |
| ADI `sync_event` вместо heartbeat | Нет | toggle+2FF есть | Не часть µs-пути |
| E1–E6 как сейчас | **Недостаточны** | E2 SKIP=ALL PASS; нет SMA; нет FIR; нет adc→dac замера | Нельзя принять «прошивка встала и работает» |
| Стенд с кабелем/2-м приёмником | Да | форум/EZ меряют так | Без замера бюджет §3 — расчёт |
| VUnit | Не обязателен | GHDL есть | Нет |
| Tone Nuand / foxhunt | Да как стимул | robert.ghilduta t=13047 | Стенд NCO/тон, не замена legion |

---

## 6. Приёмка рабочей системы по этому замыслу (всё обязано быть)

Ни SKIP, ни «потом». Это и есть определение «полноценно».

### A. Образ

1. Сборка `legionxA4.rbf` (и x40/xA9 по факту платы), Quartus 23.1.1.
2. STA WNS/TNS ≥ 0. Отчёт хранится. Hash отчёта = файл = прошитое.
3. `-l` в RAM для разработки; `-L` после зелёного SMA. Size совпал.

### B. Прошивка «встала»

4. `ping.legion===true`. Hosted → STOP.
5. micro: `AIR_PREP` up, readback FILTER=DEC4/INT4 при fs∈[520834,2083334],
   SAMPLERATE и BANDWIDTH = запрос (допуск как park).
6. x40: CONTROL RX+TX, park fs/BW прочитаны, look ≥ 1.5 МГц.

### C. Микросекунды на SMA (главный пункт запроса)

7. Кабель TX→RX с аттенюатором **или** второй приёмник. Нет кабеля = FAIL.
8. Одна стоянка, `lb_gated`, порог выше полки. Тон/энергия в взгляде.
9. Замер: от появления стимула на RX до появления того же взгляда на TX SMA.
   Ожидание порядка §3 (десятки мкс @ 2 MSPS, не сотни мс).
   Метод: осциллограф/второй SDR + маркер; либо корреляция, как в
   обсуждениях loopback на форуме.
10. Нет стимула → SMA тишина (нули с каденсом, не «последний сэмпл»).
11. Стоп / watchdog → SMA тишина за измеренный интервал (~1 с для wd).

### D. Управление не врёт (иначе «нашло» и «усилитель» расходятся)

12. ARM без границ SCAN: эфир не поднят (U1).
13. Частичный AIR и отказ DISARM не оставляют несущую (U2–U3).
14. Отказ hop: mute держится (U4).
15. `0.4` и `0,4` мс → 400 в `SCAN_DWELL_US` (U6–U7). Для n>1 hop LO
    измерен; это **не** замена пункта 9.

### E. Запрещено выдавать за этот замысел

16. Старт не вызывает `fpgaHandoff` / `fpgaAutoCycle`.
17. Водопад подписан «взгляд/гейт», не спектр.
18. Нагрузка 50 Ом, мощность на нагрузке записана.
19. ESP32 в этом круге нет.

Пункты 7–11 — единственное доказательство «за микросекунды». Расчёт §3
без них — не приёмка.

---

## 7. Прямой ответ

**Да, замысел «нашла → на SDR → на усилитель за микросекунды» существует
и однозначен:** кастомная FPGA на **самом** bladeRF гейтит RX IQ в TX DAC
той же платы; SMA TX идёт на усилитель; ноутбук не в круге.

**Нет, на `c213041` это не рабочая система:**

- образ/timing/факт FIR не доказаны;
- NIOS не ставит 4x FIR, хотя Nuand (#581/#593) требует это для 2 MSPS и
  0.52 MSPS;
- отказ управления может оставить усилитель под током;
- приёмка умеет ALL PASS без RF;
- мёртвый USB-handoff всё ещё может вернуть миллисекунды.

**Не путать:** «передать на программу SDR на ноутбуке» — это путь,
который форум Nuand прямо противопоставляет low delay, и который сам
LEGION вычеркнул из Старта. Если нужен он — микросекунды обещать нельзя.

Полный закрытый список работ = L1–L6 + U1–U7 + R1–R5 + T1/T3/T5 + §6.A–E.
Откладывать стенд, FIR на 2 МГц, честный DISARM или сверку образа нельзя:
без любого из них либо прошивка «не встала», либо сигнал не доходит до
усилителя за микросекунды, либо доходит вранье о состоянии тракта.
