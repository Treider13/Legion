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
| `drift_detector.py` | LP < 0.7 × max(3, 3×cycle) hops → DRIFT |
| `fpga_control.py` | `apply_predictive_jam` только confirmed |
| `fpga_preload.py` | LUT ≤ 255 + GRID_PRI/FLAGS/RSV (фаза) |
| `lo_sweep.py` | окна IBW 56 МГц, overlap 15%, сшивание по sample_count |
| `cognitive.py` | LISTENING→INITIAL_SCAN→LEARNING→CONFIRMING→JAMMING→MONITORING |
| `pipeline.py` | FSM + `chans_for_corridor` (ширина/200 кГц) |
| `classify` | 3 класса: drone / wifi / noise |

Предсказание без confirmed — запрещено. Parent corridor — запрещён.

## Лаборатория (нет bladeRF на этой машине)

### AD9361 36 MSPS
1. Прошить `legionxA4-2026-10-12_09.27.36/legionxA4.rbf` (md5 `6ce02ebc8b23d03e01048674fc26c9f9`, hop LUT).
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
| fpga_preload | LUT ≤ 255; host пишет GRID+FS/LO; HDL legion_lut_hop шагает индекс | ТЗ |
| EffectivenessMonitor | PDR-прокси = observed/max(expected, 1e-9); float | ТЗ |
| DriftDetector | доля align ±1 < 0.7 × max(3, 3×cycle) hops → DRIFT | ТЗ |
| TARGET_SILENT | >100 мс → stop; RE_ACQUIRE need=max(8, cycle//8) при cycle>64 | ТЗ |
| Классификатор | 3 класса (drone/wifi/noise) | ТЗ п.11 |
| Сетка | поиск периода 2..4096; LUT 2..255 | ТЗ п.12 |
| Fallback | Markov-1 HopTracker в FSM, если find_match пуст | [G3] |

Помеха в том же Python-тике, что confirm; USB-замер — лаборатория.

## lo_sweep

История на 11.10.2026, до UsbOwner. Живой контур v1.3 — секция «Полка DRFM» ниже.

Сканирование коридора шире IBW 56 МГц: окна с перекрытием 15%.
400 МГц → 9 окон × 4 мс ≈ 36 мс. Сшивание по sample_count.
Quick-tune: LRU 256 + `set_frequency_rx`. `bladerf_get_quick_tune`
недоступен через `legion_fpga.py`. Очередь retune ≤ 16. fs при частых
retune ≤ 20 Msps.
`finish().stitched` (дубли overlap сняты, `hole` при разрыве ~4 мс между
окнами) загружается в `HopRecorder.load_stitched`. Обучающий recorder
не пустой: прыжки всех окон на одной сетке от `sub.f_start`.
2400–2483 МГц → 2 окна. На эфире этот ряд не снимался.

## Универсальная сетка FHSS (12.10.2026)

| Факт | Значение |
|---|---|
| Сетка (поиск) | 2..4096 из сигнала |
| LUT / автономия | cycle≤255: после RBF `v1.1-rbf-hop-72mhz` FLAGS.AUTONOMOUS → HDL шагает HOP_LUT 0x5E; >255 — host |
| Частота | через lo_sweep. IBW 56 МГц за раз |
| Коридор | sub = [f_min−400 кГц, f_max+400 кГц]; шире IBW — окна |
| Коммит | период найден и ≥ 2 цикла |
| Позиция jam | +1 только при смене канала, `% cycle_length` |
| Viewer | axis=(f_start, f_end, nfft) STFT-1024 fftshift |
| Preload | теоретическая оценка; замер — лаборатория |
| LP score | доля align ±1 |

## HDL таймер LUT (12.10.2026, `fpga/hdl`)

`legion_lut_hop.vhd`: период = PRI_US·fs/1e6 сэмплов (запас — PROTO_PERIOD).
FLAGS bit4 + n_eff≠0 → индекс LUT++, FTW = (f0+ch·step+shift−lo)/fs·2^32 на `tx_lb_ftw`.
NIOS GRID 0x51–0x57 больше не `return true` до poke — слово уходит в HDL.
Нетлист в RBF `v1.1-rbf-hop-72mhz` (seed3, 12.10.2026 09:27). Лаборатория не гонялась.

| Элемент | Статус | Где |
|---|---|---|
| `LEGION_REG_GRID_PRI_US` 0x54 | HDL latch | `legion_regs.vhd` |
| `LEGION_REG_GRID_FLAGS` 0x56 | HDL latch, bit4 AUTO | pkg + hop |
| `LEGION_REG_GRID_SHIFT_HZ` 0x55 | int32 в FTW hop | hop |
| `LEGION_REG_GRID_RSV` 0x57 | фаза + hop_ch STATUS | hop / NIOS |
| `LEGION_REG_PROTO_PERIOD` 0x32 | DRFM walk + запас hop | `legion_lb_walk` / hop |
| Таймер индекса HOP_LUT (0x5E) | в RBF v1.1 | `legion_lut_hop.vhd` |
| `GRID_FLAG_AUTONOMOUS` | 1<<4, HDL читает | `legion_fpga.py`, pkg |

## HDL hop-тракт — исправления

- Combo-divide → multi-cycle: `legion_divider.vhd` (64 такта, restoring). Период и `rsv mod n_eff` идут через него. FTW — прежний 32-тактный делитель `mag·2^32/fs_ftw`. Операторов `/` и `mod` в hop нет.
- Combo-mult → multi-cycle: `legion_mult.vhd` (32 такта, shift-add). `pri·fs`, `f0·1000`, `lo·1000`, `ch·step` идут через него. Оператора `*` в hop нет.
- n=0 → FTW=0. `auto=0` или `n_eff=0` держат `hop_ftw=0` (не `lut(0)`).
- Порядок preload: CH_FS, CH_LO, HOP_LUT 0x5E, GRID (META/F0/STEP/PRI/SHIFT/RSV), FLAGS bit4 последним, PROTO, CH_CTRL.
- Hop LUT разведён с RX: 0x31 = bin→ch канализатора; 0x5E = idx→ch hop. NIOS `rebuild_lut` не затирает hop.
- CH_LO обязателен: `preload_hop_sequence` без `lo_hz` → ValueError.
- SHIFT 0x55 подключён: `FTW = (f0 + ch·step + shift − lo) / fs · 2^32` (shift — int32).
- RSV readback: NIOS 0x57 возвращает `legion_grid_rsv` в [7:0]; HDL STATUS mux даёт hop_ch в [15:8].
- Walk не сдвигает hop при `hop_auto=1`: смеситель tap0 берёт `hop_ftw`, walk продолжает двигать отводы.
- `n_eff` — эффективная длина (n_used если ≠0, иначе n). `hop_ch` — текущий канал в STATUS 0x57.
- Timing: CLOSED, seed3. См. секцию ниже. seed1/seed2 Slow 0°C не закрыли.

## Timing CLOSED — hop LUT 72 МГц (12.10.2026)

История. Это образ v1.1, не frozen v1.3. Актуальные цифры — секция «Полка DRFM по времени».

pll_sclk = **72 МГц**. fs = **36 MSPS**. Hop в нетлисте: `U_lut_hop` 3001 ALM (seed1 `map.rpt`; у frozen seed3 `map.rpt` нет), `U_div` 114, `U_mult` 143.

Timing status: **CLOSED** (seed3 Slow 0°C setup **+0.576 нс**, TNS 0).
Fmax **75.12 МГц** вычислено из slack: 1/(13.888 − 0.576) нс
(`pll_setup_0c_full.txt`, `sta.summary`). Отдельной строки Fmax в summary нет.
Slow 85C setup **+0.772 нс**, hold +0.285. Отрицательных slack в `sta.summary` нет.

RBF seed=3: `fpga/vendor/bladerf/hdl/quartus/legionxA4-2026-10-12_09.27.36/legionxA4.rbf`
md5 `6ce02ebc8b23d03e01048674fc26c9f9`. Копия: `timing_close_2026-10-12/hop72/`.
Tag: `v1.1-rbf-hop-72mhz`. Автономный LUT: в этом RBF (лаборатория не гонялась).

Старый RBF без hop: `legionxA4-2026-10-11_23.08.28`, md5 `bd0316396c32bb6e615061f3bdf413fe`.

| seed | fit | ALM | M10K | DSP | pll su 85C | pll ho | Slow 0C su | worst |
|---|---|---|---|---|---|---|---|---|
| 1 | OK 09:14:40 | 13 166 (**71 %**) | 284 | 35 | +0.061 | +0.290 | **−0.463** FAIL | fft_peak `best_bin`→`top_best_ok` data 14.120 |
| 2 | OK 09:21:49 | 13 164 (**71 %**) | 284 | 35 | **−0.078** FAIL | +0.240 | **−0.214** | lb_xlat `Mux17`→`pre_q[9]` data 14.127 |
| 3 | OK 09:27:36 | 13 158 (**71 %**, frozen RBF) | 284 | 35 | **+0.772** | +0.285 | **+0.576** | fft_peak `best_bin`→`top_best_bin` data 12.867 |

STA: `timing_close_2026-10-12/hop72/seed{1,2,3}/`. seed2 official `sta.summary` не писался (quartus_sta CLI); цифры из `report_timing`.

## Требования к пересборке

- Пересборка FPGA с `legion_divider` / `legion_mult` / `legion_lut_hop` (master + vendor x40/micro).
- QIP: `divider` → `mult` → `hop` (`bladerf-legion.qip` обеих платформ).
- Timing Slow 0°C setup ≥ 0 (TNS 0). seed1/seed2 hop72 Slow 0°C не закрыли; frozen — seed3.
- Лаборатория: USB, preload, hop на плате. Без платы «LUT работает на эфире» не заявлять.

## Что не сделано

История на момент v1.2. С v1.3 `bladerf_get_quick_tune` вызывается из `host/legion_rx/libbladerf_owner.py`. HEAD и тег — в секции полки.

- Лаборатория: USB/preload/hop на плате. 12.10.2026: `bladeRF-cli -p` — устройств нет. Образ v1.2 на эфире не гонялся.
- `bladerf_get_quick_tune`: нет в `legion_fpga.py` (PIO/FakeTransport). Host — LRU + `set_frequency_rx`.
- Ветка `pr-77777-lab-host-pipeline` на origin. HEAD `9400e57`, тег `v1.2-rbf-hop-lt-68mhz` актуален. `v1.0`/`v1.1` — архив (72 МГц). «LUT работает на эфире» не заявляется.

## Ограничения

- LUT: 256 слотов, индекс 8 бит, n≤255. Cycle > 255 — видимая часть, удар с host.
- Окно одного LO: min(56 МГц AD9361, fs). Сейчас fs = 34 MSPS → 34 МГц. Коридор 400 МГц → 14 окон × 4 мс ≈ 56 мс. 2400–2483 → 3 окна.
- Перестройка: ~4 мс. Пропуск ~4 прыжка при 1000 Гц.
- Quick-tune: LRU на host; ~500 мкс / полный шаг ~3.8 мс — цифры [F13]/[F14], не замер.
- Look-through: HDL `REG_LT_*`, не FLAGS bit4. См. секцию ниже.
- Два передатчика: не поддерживается.
- Обнаружение НСУ (1 Вт, 11 дБи): 5–10 км прямая видимость, 1.5–3 км город.
- Автономия LUT: после `v1.1-rbf-hop-72mhz`. Cycle > 255 — удар с host.
  rolling 256 нет. «<1 мс» не заявлено. При AUTO host не пишет LB_FTW каждый hop.
  «LUT работает на эфире» не заявляется: лаборатория не гонялась.
- f_rf: 40 бит, wrap при \|f0+ch·step\| ≥ 2^40. В ISM (f0 ≤ 6 ГГц, ch·step ≤ 255 МГц) не достигается.

## Look-through

HDL `legion_look_through` гасит ЦАП и не трогает индекс `legion_lut_hop`.
Host на listen-hop не снимает FLAGS bit4: иначе `idx` замирает и при
повторном AUTO загружается из `rsv`.

| Регистр | Адрес | Семантика |
|---|---|---|
| `REG_LT_CTRL` | `0x5A` | bit0 EN, [7:4] ratio_shift |
| `REG_LT_PERIOD` | `0x5B` | hop-тики TX-он, если значение ≤ 255 |
| `REG_LT_WIDTH` | `0x5C` | hop-тики blank. `REG_LT_LEN` в HDL нет |
| `REG_LT_STATUS` | `0x5D` | [0] echo_hold, [1] blank |

`legion_lut_hop` выдаёт `hop_tick` на один `tx_clock` при `idx++`.
`legion_look_through` считает эти импульсы. `enable_look_through(10, 1)`
пишет PERIOD=9, WIDTH=1: blank, пока счётчик ∈ [9, 10), то есть 1 hop из 10
по смене `idx`. FLAGS bit4 при этом не снимается.

PERIOD > 255 и ни одного `hop_tick` — прежний счётчик сэмплов.
Текущий такт: pll_sclk **68 МГц**, fs **34 MSPS**, DATA_CLK 136 МГц.
Blank на плате не измерялся. «LUT работает на эфире» не заявляется.

## RBF v1.2 — pll_sclk 68 МГц (12.10.2026)

Причина смены частоты: hop_tick при 72 МГц не закрыл Slow 0°C
(худший slack −0.223 нс, `lb_xlat phase_acc[31]` → `pre_q[5]`, период 13.888 нс).
68 МГц даёт период 14.704 нс. VCO LVDS: вход 136 МГц ×4 = **544 МГц**,
`pll_sclk` = VCO/8 = **68 МГц**. 544 МГц ниже паспортных 600 МГц;
Quartus образ собрал, как раньше собрал 576 МГц при 72 МГц.

Образ seed 3 (наибольший запас Slow 0°C): `timing_close_2026-10-12/hop-lt-68mhz/seed3/legionxA4.rbf`
md5 `2d5ccc3dc49cd2e390195b0c8ea16149`
sha256 `cfb4271fce0935d3522b887829efd4e17f7f980646e761237125c722f8679c12`
Тег `v1.2-rbf-hop-lt-68mhz`.
Старый закрытый образ v1.1 не переписывался: `legionxA4-2026-10-12_09.27.36`, md5 `6ce02ebc8b23d03e01048674fc26c9f9`, pll_sclk 72 МГц.

Fmax `pll_sclk` в `sta.rpt` seed 3: Slow 85C **75.01 МГц**, Slow 0C **73.43 МГц**. Это строки отчёта, не пересчёт.

| seed | каталог | ALM | M10K | DSP | Slow 85C | Slow 0C | TNS |
|---|---|---|---|---|---|---|---|
| 1 | `legionxA4-2026-10-12_11.09.17` | 13 281 (72 %) | 284 | 35 | +0.973 | +0.591 | 0 |
| 2 | `legionxA4-2026-10-12_11.16.47` | 13 256 (72 %) | 284 | 35 | +0.801 | +0.325 | 0 |
| 3 | `legionxA4-2026-10-12_11.24.01` | 13 295 (72 %) | 284 | 35 | +1.373 | +1.086 | 0 |

## Архив: hop_tick при 72 МГц — Slow 0°C FAIL

Quartus 23.1std.1, `bladeRF-micro` A4, revision `legion`, seeds 1–3.
Критерий Slow 0°C setup ≥ 0 не выполнен. Худший путь не в `hop_tick`:
`legion_lb_xlat|phase_acc[31]` → `legion_lb_xlat|pre_q[5]` на `pll_sclk`
(seed 3, Slow 0°C, slack **−0.223 нс**, data delay 14.404 нс, relationship 13.888 нс).
Логику не менял.

| seed | каталог | ALM | M10K | DSP | Slow 85C su | Slow 0C su | TNS 0C | md5 |
|---|---|---|---|---|---|---|---|---|
| 1 | `legionxA4-2026-10-12_10.35.22` | 13 269 (72 %) | 284 | 35 | +0.433 | **−0.137** | −0.226 | `10e199525ee7d7177b2c295605604a04` |
| 2 | `legionxA4-2026-10-12_10.42.36` | 13 245 (72 %) | 284 | 35 | +0.430 | **−0.042** | −0.042 | `4effd95910fc3594f9715fcf5b057657` |
| 3 | `legionxA4-2026-10-12_10.49.40` | 13 284 (72 %) | 284 | 35 | +0.108 | **−0.223** | −0.223 | `34dd9b4692b0091ba98b851237e4d6c4` |

Slow 85C у всех трёх setup > 0 и TNS 0. Эти образы на 72 МГц прошивать нельзя.
Закрытый образ с `hop_tick` — v1.2, 68 МГц, секция выше. v1.1 (`09.27.36`, md5 `6ce02ebc…`) остаётся предыдущим закрытым образом без `hop_tick`.

## Live mode

```
python -m host.legion_rx.pipeline cognitive --corridor 2400 2483 --live --fifo /tmp/iq --samplerate 20M
```

Живой `cognitive --live`: bladeRF-cli выставляет частоту, LNA и полосу и закрывается. Дальше USB держит `UsbOwner` (libbladeRF): поток SC16_Q11_META, кадры в FIFO, C-читатель → PFB → FSM. `schedule_retune` пары RX+TX — через тот же `UsbOwner`. Запись регистров на время кадра отпускает libbladeRF и забирает его обратно. Консоль во время удара устройство не открывает.

`--corridor 2400 2483` — 83 МГц. Окно одного LO = fs = 34 МГц → 3 окна. Живой поток этого режима идёт на `AIR_FS` 34 MSPS. Look-through — HDL `REG_LT_*`.

Без `--live` — синтетика и `FakeTransport`.

`mute_ns` в `config.json` равен 0, пока лаборатория не измерит длительность. «LUT работает» — только после удара на плате.

## Полка DRFM по времени (12.10.2026)

Quartus Prime Lite 23.1std.1, `bladeRF-micro` A4, revision `legion`.
Образы после одного такта `ch_r` и `hop_tick`. git_info сборки: `b9aa911` clean. Тег `v1.3-rbf-multi-lo-68mhz`.

Slow 0°C setup `pll_sclk` на сидах 1–3 положительный, TNS 0. Fast 0°C hold `tck` на этих трёх тоже положительный. Hold `pll_sclk` не закрыт только на сиде 3 (−0.013 нс). Это разброс fitter. HDL после разбора пути не менялся, RBF не пересобирался.

Worst hold path сида 3, Fast 1100mV 0°C, оба такта `pll_sclk~PLL_OUTPUT_COUNTER|divclk`. Timing Analyzer по базе `work/bladerf-micro-A4-legion` (md5 RBF совпал с сидом 3): `report_hold_pll_seed3.txt:39-55`.

- Источник: `legion_lb_xlat:U_legion_lb_xlat|Add2~1_OTERM2229`
- Назначение: `legion_lb_xlat:U_legion_lb_xlat|pre_s[0]`
- Data delay 0.511 нс, clock skew 0.524 нс, slack −0.013 нс
- Путь внутри `legion_lb_xlat` (legacy, сумматор → `pre_s`). Не `lut_hop`, не look-through, не `legion_regs`.

Сводная строка −0.013: `legionxA4-2026-10-12_15.36.32/legionxA4.sta.summary` и `legionxA4.sta.rpt:2200`. В `sta.rpt` регистров нет, только slack часов.

Frozen = seed 2. Путь `timing_close_2026-10-12/hop-lt-68mhz-frozen/legionxA4.rbf`. md5 `4db61f199a08b8e6f3ed1e67caed5ed5`. Исходный каталог `legionxA4-2026-10-12_15.29.07`. Slow 0°C setup pll_sclk +1.209, TNS 0. Fast 0°C hold pll_sclk +0.080, tck +0.112. Тег `v1.3-rbf-multi-lo-68mhz`.

Критерий frozen: хотя бы один seed PASS на обоих углах и обоих клоках (Slow 0°C setup `pll_sclk`, Fast 0°C hold `pll_sclk` и `tck`, TNS 0). Сид 3 FAIL на одном hold-пути в `legion_lb_xlat` (legacy, slack −0.013 нс). Это не блокер. Сид 1 тоже PASS и в заморозку не выбран: запас hold меньше (+0.060).

| seed | вердикт | каталог | ALM | M10K | DSP | Slow 0C setup pll_sclk | TNS | Fast 0C hold pll_sclk | Fast 0C hold tck | md5 |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | PASS | `legionxA4-2026-10-12_15.22.03` | 11 887 (64 %) | 285 | 35 | +0.977 | 0 | +0.060 | +0.121 | `5e0d3b49f9f7ebdf5aa417b93d148e5f` |
| 2 | PASS, frozen | `legionxA4-2026-10-12_15.29.07` | 11 886 (64 %) | 285 | 35 | +1.209 | 0 | +0.080 | +0.112 | `4db61f199a08b8e6f3ed1e67caed5ed5` |
| 3 | FAIL hold pll_sclk | `legionxA4-2026-10-12_15.36.32` | 11 898 (64 %) | 285 | 35 | +0.926 | 0 | −0.013, TNS −0.013 | +0.013 | `252f933954a84c9b9c5df84437571f10` |

M10K 285: на одну таблицу больше, чем у v1.2 (284). Это 256×32 кГц, если Quartus собрал память. Отдельный отчёт RAM inference здесь не разбирался.

- Окно одного LO = fs = 34 МГц при pll_sclk 68 МГц. Пятно уже или равно 34 МГц — одна стоянка. Иначе N = ceil((f_max − f_min − fs) / step) + 1, step = fs × 0.85 = 28.9 МГц. Последняя стоянка накрывает f_max. Больше 8 стоянок — восемь самых плотных, в отчёте сколько МГц осталось снаружи. Шаг шире fs не делается.
- Профили quick-tune: не больше 8 пар RX+TX, снимаются после сужения пятна. Скачок несущей больше 100 МГц — не быстрый профиль. Граница диапазонов xA4 — 3 ГГц, не 1.5 ГГц. Переход через 3 ГГц — полная калибровка.
- Mute duration — регистр 0x64, наносекунды. Формула в HDL остаётся ticks = mute_ns × 34 / 1000: RBF v1.3 уже собран, пересборка запрещена. Счётчик на `pll_sclk` 68 МГц, поэтому ненулевой mute_ns будет примерно вдвое короче запрошенного. В `config.json` `mute_ns` = 0: счётчик не стартует. 98 % не обещается.
- Данные LUT в hop не проходят 2FF. Intel CDC-50008: побитовый 2FF на шине, которая не код Грея, рвёт слово. Через границу тактов идёт строб, данные держатся до фронта. `lo_khz` — отдельный 2FF всего слова.
- Look-through: 1 слушающий прыжок из 100. Автономный флаг не снимается. Запись 0x57 отпускает libbladeRF на этот тик: второе открытие USB даёт EBUSY. Индекс переставляется, если услышанная частота в текущем окне.
- Retune time на плате не измерен. В окне поле пустое, пока лаборатория не запишет число.
- LUT: 256 ячеек по 32 бита, значение в килогерцах. Инициализации в reset нет, запись по одному адресу за такт. Чтение — в регистр. Через границу тактов идёт только строб.
- Разбор пятна останавливается после двух совпавших кругов. Широкий поиск остаётся 4 мс.
- Длительность удара — параметр, по умолчанию 15 с, не константа в коде. После таймера поиск снова идёт по исходному коридору оператора.
- 0x55 — сдвиг в герцах, знаковое, один раз, без ×1000. lo_khz × 1000 в формуле. Умножитель 32×32→64 только до вычитания. После вычитания diff 40 бит. Знак diff отделяется до битового цикла. Цикл ftw_bit 31→0 на модуле, не на 64 битах.
- Обход индекса: 9-битное сравнение, не 8-битное.
- LEGION_REG_MAX = 0x64. Адреса 0x5E данные LUT, 0x5F начало, 0x60 конец, 0x61 адрес, 0x62 строб данных, 0x63 строб границ, 0x64 mute.
- На время удара USB держит libbladeRF (`host/legion_rx/libbladerf_owner.py`), не bladeRF-cli. Очередь retune 16 мест, пара RX+TX — два места, доливается пачками. quick_tune не NULL.
- Задержки 0 и 64 и амплитуда 32767 пишутся при загрузке полки. apply_predictive_jam на автономном пути не вызывается.
- Лаборатория ещё впереди: замер mute duration, замер retune time, удар на плате.

## Лаборатория v1.3

Образ: `timing_close_2026-10-12/hop-lt-68mhz-frozen/legionxA4.rbf`, md5 `4db61f199a08b8e6f3ed1e67caed5ed5`.

Прошивка: `bladeRF-cli -l <этот rbf>`. После загрузки `bladeRF-cli -e version` показывает FPGA. md5 файла сверяет `host/legion_rx/ops.py` при старте.

Замер mute. В `config.json` поставить `mute_ns` (например 100000). Старт удара. На анализаторе спектра смотреть провал несущей между прыжками. Записать измеренные наносекунды обратно в `retune` не путать с mute. Пока `mute_ns` = 0, провала от счётчика нет. Формула в RBF — ×34/1000 при такте 68 МГц: измерение покажет примерно половину запрошенного.

Замер retune. Два LO внутри 100 МГц, пара quick_tune, метка в `schedule_retune`. Разница меток RX metadata и момента смены на спектре — микросекунды в `config.json` поле `retune_time_us`.

Удар ELRS 2.4. Коридор 2400e6–2483e6, jam 15 с, LNA 20, эквивалент 50 Ом, не антенна. `python -m host.legion_rx.main_app`, Start. PASS: FSM доходит до JAMMING или MULTI_LO, USB overruns не растут пачкой, TX глушится по Stop. FAIL: устройство не открылось, md5 RBF другой, FSM не выходит из LISTENING за время коридора.

## Лицензии рядом с полкой

См. `LICENSES.md`. Nuand HDL — MIT. Хост Nuand — LGPL-2.1. ADI HDL — лицензия Analog Devices, только на компоненте ADI. Sandia `gr-fhss_utils` — GPL-3.0, в дерево не входит.
