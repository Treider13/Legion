# xA4 resources — 5CEBA4F23C8

Build: Quartus Prime Lite 23.1std.1. Device: bladeRF 2.0 micro xA4.

## Chip totals

| Resource | 29.09.2026 (fit OK) | 10.10.2026 (fit FAIL) | delta |
|---|---|---|---|
| ALM | 14 683 / 18 480 (79 %) | 14 943 / 18 480 (81 %) | +260 |
| registers | 27 686 | 26 773 | packing differs (fail) |
| RAM bits | 2 258 912 / 3 153 920 (72 %) | 2 258 912 / 3 153 920 (72 %) | 0 |
| M10K | 285 / 308 (93 %) | 285 / 308 (93 %) | 0 |
| DSP | 39 / 66 (59 %) | 40 / 66 (61 %) | +1 |
| free ALM | 3 797 | 3 537 | −260 |
| free M10K | 23 | 23 | 0 |

Sources: `fpga/vendor/bladerf/hdl/quartus/legionxA4-2026-09-29_15.50.11/legionxA4.fit.summary`, `fpga/vendor/bladerf/hdl/quartus/legionxA4-2026-10-10_00.24.12/legionxA4.fit.summary`.

10.10.2026: `quartus_map` OK, `quartus_fit` Error 11802 (route). Seed=1. Unrouted: `U_legion_lb_walk` Add1/LessThan4, `U_legion_regs` wfs_meta[18] then lo_rx[24].

ALM +1.8 % (< 5 %). Growth = `U_legion_look_through`.

## Per entity

| module | ALM 29.09 fit | ALM 10.10 fit | M10K | DSP | RAM bits | note |
|---|---|---|---|---|---|---|
| U_legion_delayline0 | 51.6 | 49.8 | 16 | 0 | 131 072 | 4096×32 |
| U_legion_delayline1 | 41.0 | 42.1 | 16 | 0 | 131 072 | 4096×32 |
| U_legion_aim_delay | 53.0 | 52.9 | 16 | 0 | 131 072 | 4096×32 |
| U_legion_player | 21.9 | 21.0 | 12 | 0 | 98 304 | |
| U_legion_fft_peak | 1559.1 | 1557.8 | 2 | 8 | 12 288 | DIT-256 |
| U_legion_look_through | — | 263.7 | 0 | 1 | 0 | new; map 437 ALUT / 143 FF |
| U_legion_mixer0 | 15.8 | 16.1 | 0 | 2 | 0 | |
| U_legion_mixer1 | 15.8 | 15.8 | 0 | 2 | 0 | |
| U_legion_nco | 116.4 | 115.0 | 0 | 0 | 0 | tone |
| U_legion_mix_nco0 | 110.8 | 112.1 | 0 | 0 | 0 | |
| U_legion_mix_nco1 | 111.4 | 116.0 | 0 | 0 | 0 | |
| U_legion_detector | 146.7 | 163.3 | 0 | 1 | 0 | I²+Q² |

Map 10.10: registers 26 983, RAM bits 2 258 912, DSP 40. ALM estimate 17 709 (was 17 392).

Congestion 29.09: 18× `wr_addr` DUPLICATE (Router Logic Cell Insertion) on three delaylines.

## Free after look-through (fit numbers, route failed)

ALM 3 537 (19 %). M10K 23. RAM bits 894 008. DSP 26.

## Does not fit

| item | why |
|---|---|
| delayline 8192×32 | +16 M10K per line; 3 lines = +48; free 23 |
| delayline 16384×32 | +48 M10K per line |
| 3rd tap 4096×32 | +16 M10K + mixer/NCO/combine port; free 23; route already fails |
| 4th tap | +32 M10K |
| CORDIC | NCO+mixer already there; extra hundreds ALM; route already fails |
| FFT > 256 | more RAM/ALM; AD9361 IBW ≤ 56 MHz |

## Registers (unchanged this pass)

DET_THR = 0x02 (32-bit, host `set_detector`). 0x40 = CH_ENERGY_3. LT 0x5A–0x5D. amp0/amp1 from 0x28 only. Look-through: TX-on vs TX-off vs `det_thr`; `echo_hold` gates TX; no energy→amp.
