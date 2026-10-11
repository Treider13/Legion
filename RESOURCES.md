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
