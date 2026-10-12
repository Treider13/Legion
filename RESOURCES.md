# xA4 resources — 5CEBA4F23C8

Build: Quartus Prime Lite 23.1std.1. Device: bladeRF 2.0 micro xA4.

## Chip totals

| Resource | 29.09.2026 (fit OK) | 10.10.2026 00:24 (fit FAIL) | 10.10.2026 10:07 seed1 (fit OK) |
|---|---|---|---|
| ALM | 14 683 / 18 480 (79 %) | 14 943 / 18 480 (81 %) | 15 018 / 18 480 (81 %) |
| registers | 27 686 | 26 773 | 28 249 |
| RAM bits | 2 258 912 / 3 153 920 (72 %) | 2 258 912 (72 %) | 2 258 912 (72 %) |
| M10K | 285 / 308 (93 %) | 285 / 308 (93 %) | 285 / 308 (93 %) |
| DSP | 39 / 66 (59 %) | 40 / 66 (61 %) | 40 / 66 (61 %) |
| free ALM | 3 797 | 3 537 | 3 462 |
| free M10K | 23 | 23 | 23 |

Sources: `legionxA4-2026-09-29_15.50.11/`, `legionxA4-2026-10-10_00.24.12/`, `legionxA4-2026-10-10_10.07.48/`.

## Failing nets до фиксов

10.10.2026 00:24 seed=1, Error 11802:

| attempt | unrouted |
|---|---|
| 1 | `U_legion_lb_walk\|Add1~33`, `U_legion_lb_walk\|LessThan4~12`, `U_legion_regs\|wfs_meta[18]` |
| 2 | `U_legion_regs\|lo_rx[24]` |

После pipeline walk/regs/look-through + EXTRA/STANDARD FIT, сиды 1–5 (ещё без power Off): 11802 на `U_legion_fft_peak\|g_acc[2][31]~2_Duplicate_49` и `g_acc~16`.

После `dont_replicate`/`acc_nz` + `OPTIMIZE_POWER_DURING_FITTING "Off"` + `FITTER_AGGRESSIVE_ROUTABILITY_OPTIMIZATION ALWAYS`: fit OK seed 1–5.

## Seed margin (текущий нетлист)

| seed | fit | ALM | M10K | DSP |
|---|---|---|---|---|
| 1 | Successful 10:06:57 | 15 018 (81 %) | 285 (93 %) | 40 |
| 2 | Successful 21:47:39 | 14 987 (81 %) | 285 (93 %) | 40 |
| 3 | Successful 22:19:36 | 14 995 (81 %) | 285 (93 %) | 40 |
| 4 | Successful 23:07:03 | 15 009 (81 %) | 285 (93 %) | 40 |
| 5 | Successful 23:49:38 | 14 983 (81 %) | 285 (93 %) | 40 |

Summaries: `legionxA4-2026-10-10_10.07.48/legionxA4.fit.summary`, `seed_margin_2026-10-10/seed{2,3,4,5}/legion.fit.summary`.

## Slack (seed 1, Slow 1100mV 85C) vs 29.09

| clock | domain | setup 10.10 | setup 29.09 | hold 10.10 | path if setup < 0 |
|---|---|---|---|---|---|
| pll_sclk (8 ns / 125 MHz) | rx/tx = `ad9361.clock`; FFT на нём | −38.942 | −39.829 | −3.746 | `fs_rx[0]` / `peak_i[0]` → `g_acc[4][4]`, 18 lvl, data 46.335 ns |
| system_pll (12.499 ns / 80 MHz) | sys / NIOS | −8.118 | −9.596 | +0.352 | `ctrl_tx[1]` → `wcur_meta[4]`, relationship 0.001 ns (CDC) |
| fx3_pll | FX3 | +0.884 | +2.239 | +0.393 | — |
| c5_clock2 | ref | +8.035 | +8.964 | +0.422 | — |

look_through worst: `count[6]` → `count[28]`, setup −13.126, data 20.920 ns (32-bit `count` vs `period`/`width`). Регистр на compare сдвигает `blank` на 1 tx_clk — не делалось.

STA: `Critical Warning (332148): Timing requirements not met`. 29.09 fit OK имел те же знаки и хуже slack.

## Per entity (10.10.2026 00:24 failed fit)

| module | ALM | M10K | DSP | RAM bits |
|---|---|---|---|---|
| U_legion_delayline0 | 49.8 | 16 | 0 | 131 072 |
| U_legion_delayline1 | 42.1 | 16 | 0 | 131 072 |
| U_legion_aim_delay | 52.9 | 16 | 0 | 131 072 |
| U_legion_player | 21.0 | 12 | 0 | 98 304 |
| U_legion_fft_peak | 1557.8 | 2 | 8 | 12 288 |
| U_legion_look_through | 263.7 | 0 | 1 | 0 |
| U_legion_mixer0/1 | 16.1 / 15.8 | 0 | 2+2 | 0 |
| U_legion_nco + mix_nco0/1 | 115+112+116 | 0 | 0 | 0 |
| U_legion_detector | 163.3 | 0 | 1 | 0 |

4096×32 delayline = 16 M10K (измерение fit).

## Не влезает

| item | цифра | вердикт |
|---|---|---|
| delayline 8192×32 | 32 M10K / линия; +16 к каждой из 3 = +48; free 23 | M10K нет |
| delayline 16384×32 | 64 M10K / линия; +48 к каждой | M10K нет |
| 3-й отвод 4096×32 | +16 M10K → 301/308; ALM mixer+NCO+combine не синтезировали | M10K да; fit не гоняли |
| CORDIC | нет нетлиста на этом чипе; M10K 0 | нет цифры Quartus |
| FFT > 256 | FFT-256 = 2 M10K + 8 DSP (`U_legion_fft_peak`) | глубина/ALM не измеряли |

## Registers (без новых функций)

DET_THR = 0x02. 0x40 = CH_ENERGY_3. LT 0x5A–0x5D. amp0/amp1 = 0x28. Look-through: TX-on vs TX-off vs `det_thr`; `echo_hold` гейтит TX; нет energy→amp.

## pll_sclk / fft_channelize (11.10.2026 seed 1)

Fit OK 20:04:44. ALM 15 426 / 18 480 (83 %). M10K 284 / 308 (92 %). DSP 35 / 66.
`U_legion_fft_channelize`: 4392 ALM, 6841 regs.
pll_sclk setup −6.651 (`acc_i_q → acc[*]`, data 14.427 ns). system_pll +2.055 / +0.363.

xA4 не тянет 125 MHz с fft_channelize при 83% ALM.
Требуется архитектурное изменение внутри xA4.

## pll_sclk / no channelize + M10K (11.10.2026)

Fit seed1 20:58:46. ALM 10 898 / 18 480 (59 %). M10K 284 / 308 (92 %). DSP 35 / 66.
`U_legion_fft_channelize` снят. `lg_ch_word=0`.
pll_sclk setup −6.353 (`ctrl_tx[1]→mixer1|q[22]`).

MCP `ctrl_tx→mixer1*q*` setup 4 / hold 3: preview seed3 −5.775
(`dcfifo/walk→mixer1|q`, relationship 8 ns). `ctrl_tx→mixer1` ушёл.

`U_legion_fft_peak`: 2 M10K, 12 288 bit (256×32 + 256×16). Нужно −4 блока.
delayline 3×16 M10K (131 072) — запрещено трогать. nios 1 062 848 bit.
M10K 284 = достижимый минимум без delayline/NIOS.

Mixer S1/S2 seed1 21:57:58. ALM 10 981 (59 %). M10K 284. pll_sclk −5.476
(`lbd_tx[0]→lb_aim|q[12]`, PIO delay 2FF). mixer|q снят с top. Host: mix/bypass +1 sample.

## pll_sclk частота (11.10.2026)

pll_sclk ≠ system_pll (38.4→80 NIOS). pll_sclk = altlvds_rx generic_pll:
DATA_CLK `adi_rx_clock` / 2. ALTERA_PLL_RECONFIG не применим.
`bladerf_set_pll_refclk` = ADF4002 REF (VCTCXO), не DATA_CLK.

fs → DATA_CLK=4×fs → pll_sclk=2×fs. Хост: `set_air_fs_hz` → NIOS RFIC SAMPLERATE.

| f pll_sclk | DATA_CLK | fs | seed1 ALM | pll_sclk su | period | data | worst |
|---|---|---|---|---|---|---|---|
| 125 (было) | 250 | 61.44e6 | 10981 59% | −5.476 | 8.000 | 13.229 | lbd_tx→lb_aim |
| 100 | 200 | 50e6 | 11004 60% | **−3.872** | 10.000 | 13.644 | lbd_tx→lb_aim |
| 76.8 | 153.6 | 38.4e6 | 10981 59% | **−0.793** | 13.020 | 13.575 | lbd_tx→lb_aim |
| 76.8 + AIM pipe | 153.6 | 38.4e6 | 10985 59% | **−0.251** | 13.020 | 13.071 | fft_peak best_bin→top |
| **72** | **144** | **36e6** | 11002 60% | **+0.789** | 13.888 | 10.784 | fft_peak ram WE→best_mag |

pre-MCP @ 76.8 worst: lbd_tx −0.793 (path #1), dcfifo −0.773 (path #2)
в `pll768/seed1_pll_setup.txt`. MCP-only fit не сохранён.

## Timing CLOSED (thin margin) — 72 МГц (11.10.2026 23:08)

pll_sclk = **72 МГц**. fs = **36 MSPS**, pll_sclk = **2×fs**. DATA_CLK = 144 МГц.
altlvds: data_rate 288.0 Mbps, inclock_period 6944 ps, refclk 144.000000 MHz.
STA: **72.0 MHz**, period **13.888 нс** (`legionxA4.sta.rpt` clocks).
Host: `PLL_SCLK_HZ = 72_000_000`, `AIR_FS_FOR_PLL_SCLK_HZ = 36_000_000`.
`bladerf_set_pll_refclk` не используется.

Timing status: **CLOSED (thin margin at Slow 0°C: seed3 +0.011 нс, Fmax 72.06 МГц)**.
Все 3 seed: pll_sclk setup/hold ≥ 0, TNS 0. Порога slack кроме ≥0 нет.

MCP (PIO; не чаще 1 раза в 4 клока = 55.556 нс @ 72 МГц):
- `ctrl_tx → legion_lb_aim*q*` setup 4 / hold 3
- `ctrl_tx → mixer1*q*` setup 4 / hold 3
- `lbd_tx → lb_aim*q*` setup 4 / hold 3
  (`lbd_tx` = 2FF `r_lb_delay`, PIO **0x24** `LEGION_REG_LB_DELAY`; не 0x2A)

Pipeline: `legion_mixer` S1/S2; `legion_lb_aim` S1/S2 (`preserve`).
Host: mix/bypass +1 sample; AIM mix +1 sample. **Итого +2 сэмпла.**
@ 36 MSPS: 2/36e6 = **55.556 нс** (не мкс). Two-ray delay1 @ 36e6 = **41**
(1/B; +2 в tap не входят).

RBF seed=3: `fpga/vendor/bladerf/hdl/quartus/legionxA4-2026-10-11_23.08.28/legionxA4.rbf`
md5 `bd0316396c32bb6e615061f3bdf413fe`. Копия: `timing_close_2026-10-11/pll72/`.
Tag: `v1.0-rbf-72mhz`. HDL не менять.

| seed | fit | ALM | M10K | DSP | pll su 85C | pll ho | Slow 0C su | worst |
|---|---|---|---|---|---|---|---|---|
| 1 | OK 22:55:28 | 11 002 (**60 %**) | 284 | 35 | **+0.789** | +0.279 | +0.402 | fft_peak ram WE→best_mag[22] data 10.784 |
| 2 | OK 23:01:24 | 10 969 (**59 %**) | 284 | 35 | **+0.147** | +0.260 | +0.100 | lb_xlat Mux5→pre_q[13] data **13.894** |
| 3 | OK 23:07:11 | 10 979 (**59 %**, frozen RBF) | 284 | 35 | **+0.725** | +0.290 | **+0.011** | iqcor→detector det_cnt_r data 12.544 |

ALM: seed1 60%, seed2 59%, seed3 59% (frozen RBF). M10K 284, DSP 35.
seed2 data delay **13.894 > period 13.888**; slack +0.147 из-за skew +0.223
(`pll72/seed2/pll_setup.txt`). Это не «все пути < period».

system_pll setup: +1.987 / +2.132 / +2.582. STA: `timing_close_2026-10-11/pll72/seed{1,2,3}/`.

## Host pipeline (PR #113, шаги 3–9 ТЗ) — подтверждённые факты, 11.10.2026

| Факт | Значение | Источник |
|---|---|---|
| bladeRF rx config | buffers=32, num_transfers=**16** (не 8: overrun на 20 MSPS) | Nuand, форумы [F1] |
| Формат I/Q | SC16_Q11: 12 бит в int16 left-justified, /2048 | libbladeRF [F2-аудит] |
| Overrun reaction | эскалация 20→10 MSPS (rx stop → set samplerate → rx start), порог 10 | практика SDR [F3] |
| USB pre-flight | `bladeRF-cli -e info` → «USB speed: SuperSpeed» + `rx config format=bin` verify | [F8] |
| PFB rejection | 62.4 dB к худшему соседу, 159 dB к медиане (M=64, taps=8, тон) | замер этой машины |
| PFB скорость | 0.221 мс/кадр numpy CPU (20000 сэмплов) — GPU быстрее | замер этой машины |
| Decision+запись | p50=3.185 мс, p99=3.455 мс (torch CPU + legion_fpga.py/FakeTransport) | замер этой машины |
| ELRS 900 | SX127x: 200 Гц LoRa (модель по умолчанию); LR1121: 1000 Гц FSK (`ELRS900_LR1121`) — выбор за железом стенда | Wikipedia ExpressLRS [F4] |
| Q15 | база **32768**: 0.85×32768=27852.8→27853 (база 32767 даёт 27852); 1.0 clamp→32767 | [F5] |
| TRT/Blackwell | граф cuDNN-free (Conv2d/BN/ReLU/GAP/Linear); сборка движка — лаборатория | [F6] |
| DroneRF loader | верифицирован на DroneRF-семействе (Goorm-AI-04/DroneRF, HF): `<class>/RF Data_*/\*.csv`, пары I,Q (N,2) без заголовка; лейаут DroneRFa (IEEE Dataport) — в лаборатории | HF API, 11.10.2026 |
| Viewer | pyqtgraph `useOpenGL=True, antialias=False`; 60 FPS — лабораторный замер (AetherSDR читает тот же UDP JSON при недостатке) | [F2-аудит] |
| GPIO PA | в схеме стенда не используется (в legion_fpga.py нет GPIO/expansion API; TX — AD9361 напрямую). Изменится схема — добавить UART GPIO путь | аудит 7.2 |

Тесты: 84 функции на аудит + `test_rbf_timing` 9 (чтение `timing.rpt`
seeds 1–3, Slow 0°C, MCP WARN). Прогон 66 (torch/synth/bench — lab).
Позже 94 passed кроме `train_smoke`. Критерии железа (overruns=0/60 с,
GPU <5 мс, IMD3 тракта, acc>0.95, TRT --bench, 60 FPS, AD9361 36 MSPS) —
процедуры ниже, выполняются в лаборатории.

## Host +2 сэмпла / 72 МГц (11.10.2026)

| Константа | Значение |
|---|---|
| `PLL_SCLK_HZ` | 72_000_000 |
| `AIR_FS_FOR_PLL_SCLK_HZ` | 36_000_000 |
| `PIPELINE_EXTRA_SAMPLES` | 2 |
| `pipeline_extra_s(36e6)` | 55.556 нс |
| `mcp_pio_min_s()` | 55.556 нс (setup 4 @ 72 МГц) |
| `twory_delay1(36e6)` | 41 |
| USB I/Q lab `FS_LAB` | 20e6 (не эфир) |
| FPGA air writes | `AIR_FS_HZ` = 36e6 |
| LO settle | 6 мс |

`drfmTworyDelay1(36e6) = 41`. MCP PIO: USB обычно >> 55.556 нс; sleep нет.
`fpga_control.note_pio_write` — runtime WARN (не блок), если интервал < MCP.

## FHSS-паттерны (host, не 77777)

| Модуль | Роль |
|---|---|
| `corridor.py` | 2+ коридора, sub = [fmin−400 кГц, fmax+400 кГц] |
| `hop_recorder.py` | скачки только в sub |
| `pattern_store.py` | add/find_match в том же sub |
| `hopmap.py` | PatternStore + Markov fallback |
| `effectiveness_monitor.py` | PDR low → effective |
| `drift_detector.py` | LP < 0.7 × 3 → DRIFT |
| `fpga_control.py` | `apply_predictive_jam` только confirmed |
| `fpga_preload.py` | LUT ≤ 255 + GRID_PRI/FLAGS/RSV (фаза) |
| `lo_sweep.py` | окна IBW 56 МГц, overlap 15%, сшивание по sample_count |
| `cognitive.py` | LISTENING→INITIAL_SCAN→LEARNING→CONFIRMING→JAMMING→MONITORING |
| `pipeline.py` | FSM + `chans_for_corridor` (ширина/200 кГц) |
| `classify` | 3 класса: drone / wifi / noise |

Предсказание без confirmed — запрещено. Parent corridor — запрещён.

## Лаборатория (нет bladeRF на этой машине)

### AD9361 36 MSPS
1. Прошить `legionxA4-2026-10-11_23.08.28/legionxA4.rbf` (md5 `bd0316396c32bb6e615061f3bdf413fe`).
2. `bladeRF-cli -e "set samplerate rx 36M"`
3. `bladeRF-cli -e "print samplerate rx"` → 36000000.
4. `bladeRF-cli -e "rx start"`; 60 с; `rx status` → `rx_overruns=0`.
5. overruns>0 → AD9361 0x006 CLK/DATA delay (~0.3 нс/LSB).
6. DATA_CLK = 144 МГц (осциллограф / AD9361 API). Записать сюда.

### RBF flash
`md5sum legionxA4.rbf` = `bd0316396c32bb6e615061f3bdf413fe`. Tag `v1.0-rbf-72mhz`.

### FSM
`python3 -m legion_rx.pipeline cognitive --duration-s 1 --cpu` (FakeTransport).
Железо: `integrate` после rx stop → `set_air_fs_hz(36e6)`.

## Known limitations (12.10.2026, аудит HDL 1–4)

- Slow 0°C thin margin: seed3 setup **+0.011 нс**, Fmax **72.06 МГц** vs 72.0
  (`pll72/seed3/timing.rpt`, `sta.rpt:296,309`). STA ≥ 0, запас тонкий.
- seed2 data delay **13.894 нс > period 13.888 нс**; slack **+0.147** из-за
  skew +0.223 (`pll72/seed2/pll_setup.txt:6`).
- MCP-only fit не сохранён. pre-MCP `pll768`: lbd_tx −0.793 (#1),
  dcfifo −0.773 (#2).
- AD9361 36 MSPS на железе не проверен (нет bladeRF на этой машине).
- `test_rbf_timing` читает `pll72/seed{1,2,3}/timing.rpt`, не гоняет Quartus.
- Порога slack кроме setup/hold ≥ 0 в проекте нет.

## Когнитивный контур FHSS-памяти (шаги 3–9+, 11.10.2026)

FSM: LISTENING→INITIAL_SCAN→LEARNING→CONFIRMING→JAMMING→MONITORING→
(DRIFT_DETECTED|TARGET_SILENT|RE_ACQUIRE|RE_LEARNING).

| Компонент | Реализация | Источник |
|---|---|---|
| CorridorDetector | динамический EMA-пол на бин, теги start/end/freq; коридор = аккумуляция активности + дилатация ±1 бин (краевое расщепление PFB) | [G1] |
| P(hopping\|data) | байесовские лог-шансы (CV интервалов, duty, всплески); rate mean ± 95% CI | [G2] |
| Sub-corridor | f_min−400 кГц … f_max+400 кГц, id parent+sub; работа ТОЛЬКО внутри | ТЗ |
| HopRecorder | hops + sample_count + energy; коммит = период + ≥2 цикла | [G6] |
| PatternStore | ID, pending/confirmed/legacy; find_match доля align ±1; match_need; find_cycle_period (автокорр.) | [G5] |
| sequence_type | table_based / pseudo_random / adaptive_afh | [G2] |
| Упреждающая помеха | apply_predictive_jam: только confirmed, только в sub, amp0+amp1≤1.0 [F16] | [G4] |
| fpga_preload | LUT ≤ 255; host пишет GRID+PROTO; HDL GRID 0x51–0x57 не читает | ТЗ |
| EffectivenessMonitor | PDR-прокси = observed/max(expected, 1e-9); float | ТЗ |
| DriftDetector | доля align ±1 < 0.7 × max(3, 3×cycle) тиков → DRIFT | ТЗ |
| TARGET_SILENT | >100 мс → stop; RE_ACQUIRE need=max(8, cycle//8) при cycle>64 | ТЗ |
| Классификатор | 3 класса (drone/wifi/noise) | ТЗ п.11 |
| Сетка | поиск периода 2..4096; LUT 2..255 | ТЗ п.12 |
| Fallback | Markov-1 HopTracker в FSM, если find_match пуст | [G3] |

Помеха в том же Python-тике, что confirm; USB-замер — лаборатория.

## lo_sweep

Сканирование коридора шире IBW 56 МГц: окна с перекрытием 15%.
400 МГц → 9 окон × 4 мс ≈ 36 мс. Сшивание по sample_count.
Quick-tune: LRU 256 + `set_frequency_rx`. `bladerf_get_quick_tune`
недоступен через `legion_fpga.py`. Очередь retune ≤ 16. fs при частых
retune ≤ 20 Msps.

## Универсальная сетка FHSS (12.10.2026)

| Факт | Значение |
|---|---|
| Сетка (поиск) | 2..4096 из сигнала |
| LUT / автономия | cycle ≤ 255: host пишет LUT+флаг. HDL-таймера нет — удар с host |
| Частота | через lo_sweep. IBW 56 МГц за раз |
| Коридор | sub = [f_min−400 кГц, f_max+400 кГц]; шире IBW — окна |
| Коммит | период найден и ≥ 2 цикла |
| Позиция jam | +1 только при смене канала, `% cycle_length` |
| Viewer | axis=(f_start, f_end, nfft) STFT-1024 fftshift |
| Preload | теоретическая оценка; замер — лаборатория |
| LP score | доля align ±1 |

## Требования к HDL (12.10.2026, чтение `fpga/hdl`)

ТРЕБОВАНИЕ К HDL: регистр period_us (или эквивалент в сэмплах) + таймер,
который считает до периода и переключает CH_LUT на следующую запись
без host. Без этого автономный LUT-режим на FPGA не работает.
Host только пишет регистры.

| Элемент | Статус | Где |
|---|---|---|
| `LEGION_REG_GRID_PRI_US` 0x54 | адрес есть; HDL не читает | `legion_pkg.vhd:159`; `legion_regs.vhd` write → `when others => null` |
| `LEGION_REG_GRID_FLAGS` 0x56 | то же | pkg:161, regs:309 |
| `LEGION_REG_GRID_RSV` 0x57 | то же (фаза NIOS-only) | pkg:162,165 |
| `LEGION_REG_PROTO_PERIOD` 0x32 | есть; шагает DRFM walk, не CH_LUT | `legion_lb_walk.vhd` |
| Регистр `period_us` для LUT | нет | — |
| Таймер индекса CH_LUT | нет | CH_LUT — запись host → map bin→ch |
| `GRID_FLAG_AUTONOMOUS` | host-бит 1<<4; HDL игнорирует | `legion_fpga.py` |

Итог: **НЕ ПОДТВЕРЖДЁН** (таймера нет в текущем нетлисте).

## Что не сделано

- HDL таймер переключения LUT (шаги 1–3, не host).
- `bladerf_get_quick_tune`: нет в `legion_fpga.py`. Host — LRU + `set_frequency_rx`.
- Bench IQ: синтез на фиксированном LO. Смена `fsm.lo_hz` не двигает waveform.
- USB/preload замеры — лаборатория.
- Push не делался — по требованию.

## Ограничения

- LUT: 256 слотов, индекс 8 бит, n≤255. Cycle > 255 — видимая часть, удар с host.
- IBW: 56 МГц. Коридор шире — lo_sweep.
- Перестройка: ~4 мс. Пропуск ~4 прыжка при 1000 Гц.
- Quick-tune: LRU на host; ~500 мкс / полный шаг ~3.8 мс — цифры [F13]/[F14], не замер.
- Look-through: каждые 10 hops host снимает флаг на 1 hop (~10% hops без autonomous).
  `set_look_through` / REG_LT_* не вызываются.
- Два передатчика: не поддерживается.
- Обнаружение НСУ (1 Вт, 11 дБи): 5–10 км прямая видимость, 1.5–3 км город.
- FPGA не автономна по FHSS-LUT: GRID 0x51–0x57 HDL не обрабатывает.
