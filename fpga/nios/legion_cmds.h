/* ============================================================================
 * LEGION FPGA — NIOS II сторона регистрового канала (bladeRF 1 x40).
 *
 * Канал: NIOS 8x32-пакеты, target 0x80 — диапазон 0x80..0xFF официально
 * зарезервирован Nuand под пользовательские расширения
 * (fpga_common/include/nios_pkt_8x32.h, комментарий к NIOS_PKT_8x32_TARGET_USR1).
 *
 * Регистровая карта зеркалит fpga/hdl/legion_pkg.vhd — держать синхронно
 * (проверяется тестом fpga/test/test_legion_fpga.py).
 * =========================================================================*/
#ifndef LEGION_CMDS_H_
#define LEGION_CMDS_H_

#include <stdint.h>
#include <stdbool.h>

/* Target ID: первый из пользовательского диапазона Nuand (0x80..0xFF) */
#define LEGION_NIOS_TARGET        0x80

/* Адреса регистров — зеркало legion_pkg.vhd (LEGION_REG_*) */
#define LEGION_REG_CTRL           0x00  /* bit0=ARM, bits3:1=MODE, bit4=WD_EN */
#define LEGION_REG_NCO_FTW        0x01  /* FTW = round(f/fs * 2^32) */
#define LEGION_REG_DET_THR        0x02  /* порог средней энергии I²+Q² */
#define LEGION_REG_DET_SHIFT      0x03  /* окно = 2^shift сэмплов (4..12) */
#define LEGION_REG_PLAYER_LEN     0x04  /* длина волны-1 (0..4095) */
#define LEGION_REG_PLAYER_CTL     0x05  /* bit0: capture_arm */
#define LEGION_REG_LB_SHIFT       0x06  /* сдвиг усиления loopback 0..8 */
#define LEGION_REG_WD_LIMIT       0x07  /* таймаут: limit × 2^16 тактов tx_clock */
#define LEGION_REG_WD_KICK        0x08  /* любая запись = heartbeat */
/* Эфир micro (AD9361) — живут в NIOS, в HDL не пишутся. На bladeRF 1 эфир
 * поднимает шлюз через CONTROL bit1/2 (bladerf_p.vhd), там эти регистры —
 * no-op true. */
#define LEGION_REG_AIR_FREQ_KHZ   0x09  /* LO парковки, кГц (47М..6Г) */
#define LEGION_REG_AIR_GAIN_DB    0x0A  /* ручной RX gain, дБ (0 = не трогать) */
#define LEGION_REG_AIR_PREP       0x0B  /* bit0: 1=up/0=standby; bit1: RX; bit2: TX */
#define LEGION_REG_AIR_FS_HZ      0x0C  /* sample rate эфира/solo, Гц; 0 = 2 МГц */
#define LEGION_REG_AIR_BW_HZ      0x0D  /* analog BW эфира/solo, Гц; 0 = 2 МГц */
/* Онбордовый обзор коридора (только NIOS, HDL when others => null).
 * После Старта перехвата хост пишет коридор и включает walker: плата
 * шагает LO сама. USB в круге «энергия → TX» не участвует. */
#define LEGION_REG_SCAN_F1_KHZ    0x0E  /* начало коридора, кГц */
#define LEGION_REG_SCAN_F2_KHZ    0x0F  /* конец коридора, кГц */
#define LEGION_REG_SCAN_CTRL      0x10  /* bit0=enable, bit1=turn, bit2=park, bit3=survey */
#define LEGION_REG_SCAN_DWELL_US  0x11  /* выдержка на сигнал внутри окна, мкс; 0 = 3e6 */
/* Точный Гц: FFT-пик на FPGA. 0x12–0x14/0x17–0x1B — статики NIOS.
 * 0x15 — mux STATUS (IOWR AWS=0x15, IORD STATUS). 0x16 — HDL+NIOS. */
#define LEGION_REG_SEARCH_BW_HZ   0x12  /* analog BW обзора, Гц; 0 = AIR_BW */
#define LEGION_REG_FIRE_BW_HZ     0x13  /* leftover; вырез цифровой, analog не узжаем */
#define LEGION_REG_PEAK_KHZ       0x14  /* найденная частота, кГц (считает NIOS) */
#define LEGION_REG_PEAK_BIN       0x15  /* слово пика HDL: bin/mag/frame/valid */
#define LEGION_REG_FFT_CTRL       0x16  /* bit0 enable, bit1 dc_notch, bit2 lock, bit3 xlat bypass */
#define LEGION_REG_BAND_IDX       0x17  /* 0..7 — куда писать F1/F2 */
#define LEGION_REG_BAND_F1_KHZ    0x18
#define LEGION_REG_BAND_F2_KHZ    0x19
#define LEGION_REG_BAND_COUNT     0x1A  /* 0 = один коридор SCAN_F1/F2 */
#define LEGION_REG_SETTLE_N       0x1B  /* сэмплы после hop; 0 = 4096 */
#define LEGION_REG_SCAN_SURVEY_US 0x1C  /* период глухого прохода, мкс; 0 = 5e6 */
#define LEGION_REG_SCAN_EVENT     0x1D  /* [7:0] код, [31:8] seq — лог хоста */
#define LEGION_REG_AIR_TX_GAIN_DB 0x1E  /* ручной TX gain, дБ; код = gain+1000; 0xFFFFFFFF = не задан */
#define LEGION_REG_DELAY          0x1F  /* начальная задержка, сэмплы (HDL) */
#define LEGION_REG_WALK_STEP      0x20  /* прирост задержки за цикл play */
#define LEGION_REG_WALK_MAX       0x21  /* потолок; 0 = до 2^32−1 */
#define LEGION_REG_WALK_CTL       0x22  /* bit0 EN, bit1 AUTO, bit2 HOLD */
#define LEGION_REG_WALK_CUR       0x23  /* STATUS mux: текущая задержка */
#define LEGION_REG_LB_DELAY       0x24  /* tap0, сэмплы; 0 = без отвода */
#define LEGION_REG_LB_FTW         0x25  /* tap0 смеситель; 0 = обход */
#define LEGION_REG_LB_DELAY1      0x26  /* tap1 */
#define LEGION_REG_LB_FTW1        0x27
#define LEGION_REG_LB_AMP         0x28  /* [15:0] A0 Q15, [31:16] A1 */
#define LEGION_REG_WALK_PERIOD    0x29  /* сэмплы между шагами; 0 = фронт det */
#define LEGION_REG_WALK_FTW_STEP  0x2A  /* прирост FTW0 за шаг */
#define LEGION_REG_CH_CTRL        0x2B  /* HDL [15:0]; NIOS preset [17:16] */
#define LEGION_REG_CH_IDX         0x2C  /* индекс 0..79 */
#define LEGION_REG_CH_PWR         0x2D  /* STATUS mux: слово канала */
#define LEGION_REG_PEAK1          0x2E  /* STATUS mux: Top-N 1 */
#define LEGION_REG_PEAK2          0x2F
#define LEGION_REG_PEAK3          0x30
#define LEGION_REG_CH_LUT         0x31  /* write {idx[15:8], ch[7:0]} */
#define LEGION_REG_PROTO_PERIOD   0x32  /* период пакета, сэмплы (хост) */
#define LEGION_REG_PROTO_PULSE    0x33  /* длительность пакета, сэмплы */
#define LEGION_REG_DRFM_STEP_SRC  0x34  /* 0=WALK_PERIOD, 1=PROTO_PERIOD */
#define LEGION_REG_CH_THR         0x35  /* порог энергии слота (NIOS) */
#define LEGION_REG_CH_HYST        0x36  /* N окон подряд (NIOS) */
#define LEGION_REG_CH_TARGET      0x37  /* FFT bin 0..255 */
#define LEGION_REG_CH_MODE        0x38  /* 0=8×10 МГц ISM 2.4, 1=ELRS 80 */
#define LEGION_REG_CH_ACTIVE_0    0x39  /* [7:0] активные 10-МГц слоты */
#define LEGION_REG_CH_ACTIVE_1    0x3A  /* ELRS bits 0..31 */
#define LEGION_REG_CH_ACTIVE_2    0x3B  /* ELRS bits 32..63 */
#define LEGION_REG_CH_ACTIVE_3    0x3C  /* ELRS bits 64..79 */
#define LEGION_REG_CH_ENERGY_0    0x3D
#define LEGION_REG_CH_ENERGY_1    0x3E
#define LEGION_REG_CH_ENERGY_2    0x3F
#define LEGION_REG_CH_ENERGY_3    0x40
#define LEGION_REG_CH_ENERGY_4    0x41
#define LEGION_REG_CH_ENERGY_5    0x42
#define LEGION_REG_CH_ENERGY_6    0x43
#define LEGION_REG_CH_ENERGY_7    0x44
#define LEGION_REG_CH_HITS_0      0x45
#define LEGION_REG_CH_HITS_1      0x46
#define LEGION_REG_CH_HITS_2      0x47
#define LEGION_REG_CH_HITS_3      0x48
#define LEGION_REG_CH_HITS_4      0x49
#define LEGION_REG_CH_HITS_5      0x4A
#define LEGION_REG_CH_HITS_6      0x4B
#define LEGION_REG_CH_HITS_7      0x4C
#define LEGION_REG_CH_BINS_03     0x4D  /* пики слотов 0..3 */
#define LEGION_REG_CH_BINS_47     0x4E  /* пики слотов 4..7 */
#define LEGION_REG_CH_FS_HZ       0x4F  /* NIOS → HDL */
#define LEGION_REG_CH_LO_KHZ      0x50  /* центр взгляда → HDL */
/* Сетка умной атаки — только NIOS (HDL when others => null). Не 0x32–0x50. */
#define LEGION_REG_GRID_META      0x51  /* n, n_used, conf, source, kind */
#define LEGION_REG_GRID_F0_HZ     0x52  /* uint32: Hz если влезает; 5.8 → кГц */
#define LEGION_REG_GRID_STEP_HZ   0x53
#define LEGION_REG_GRID_PRI_US    0x54  /* 0 = не часы walk */
#define LEGION_REG_GRID_SHIFT_HZ  0x55  /* int32 residual FreqCorrection */
#define LEGION_REG_GRID_FLAGS     0x56
#define LEGION_REG_GRID_RSV       0x57  /* reserved, 0 */
#define LEGION_REG_CH_PWR_THR     0x58  /* [15:0] порог канала CH_PWR */
#define LEGION_REG_AIM_CH         0x59  /* [7:0] канал или 0xFF, [31] armed */

#define LEGION_SCAN_CTRL_EN       (1u << 0)
#define LEGION_SCAN_CTRL_TURN     (1u << 1)
#define LEGION_SCAN_CTRL_PARK     (1u << 2) /* ИИ: 56 МГц на всплеск */
#define LEGION_SCAN_CTRL_SURVEY   (1u << 3) /* глухой обзор → окно → период → снова обзор */
#define LEGION_FFT_CTRL_EN        (1u << 0)
#define LEGION_FFT_CTRL_DC_NOTCH  (1u << 1)
#define LEGION_FFT_CTRL_LOCK      (1u << 2) /* xlat не следует за live-пиком */
#define LEGION_FFT_CTRL_XLAT_BYPASS (1u << 3) /* xlat=passthrough; два тона ≥ fs/16 */
#define LEGION_CH_MAP_RAW         0u
#define LEGION_CH_MAP_LUT         1u
#define LEGION_CH_MAP_MASK        3u
#define LEGION_CH_FFTSHIFT        (1u << 5)
#define LEGION_CH_DC_SKIP         (1u << 6)
#define LEGION_CH_N80             (1u << 7)
#define LEGION_CH_N               80u
#define LEGION_CH_SLOT_N          8u
#define LEGION_CH_EXCL_DEFAULT    8u
#define LEGION_CH_PRESET_SHIFT    16
#define LEGION_CH_PRESET_MASK     3u
#define LEGION_CH_PRESET_MANUAL   0u
#define LEGION_CH_PRESET_ELRS     1u /* ExpressLRS FHSS.cpp ISM2G4 80×1 МГц */
#define LEGION_CH_PRESET_ISM8     2u /* 2400–2480 / 8×10 МГц, не OcuSync */
#define LEGION_CH_PRESET_O4VID3   3u /* DJI O4 20/10 МГц: 5768.5/5789.5/5814.5 */
#define LEGION_XLAT_NULL_BINS     16u /* MA-16 first-null: f=fs/N=fs/16 → 256/16 bins */
#define LEGION_BAND_MAX           8u
#define LEGION_SURVEY_LOOK_MAX    128u
#define LEGION_FIRE_BW_DEFAULT_HZ 2000000u
#define LEGION_SETTLE_N_DEFAULT   4096u
#define LEGION_SCAN_SURVEY_DEFAULT_US 5000000u
#define LEGION_EVT_PASS           1u
#define LEGION_EVT_STARE          2u
#define LEGION_EVT_LOCK           3u
#define LEGION_EVT_SWITCH         4u
#define LEGION_EVT_RESURVEY       5u
#define LEGION_WALK_CTL_EN        (1u << 0)
#define LEGION_WALK_CTL_AUTO      (1u << 1)
#define LEGION_WALK_CTL_HOLD      (1u << 2)
#define LEGION_REG_MAX            LEGION_REG_AIM_CH
#define LEGION_CH_ELRS_N          80u
#define LEGION_CH_MODE_OCUSYNC    0u
#define LEGION_CH_MODE_ELRS       1u
#define LEGION_OCUSYNC_F0_KHZ     2400000u
#define LEGION_OCUSYNC_BW_KHZ     10000u
#define LEGION_ELRS_F0_KHZ        2400400u
#define LEGION_ELRS_F1_KHZ        2479400u
#define LEGION_ELRS_SPACING_KHZ   1000u
#define LEGION_DRFM_STEP_SRC_LAB  0u
#define LEGION_DRFM_STEP_SRC_PROTO 1u
#define LEGION_AIM_NONE           0xFFu /* нет цели; 0 = валидный DC */
#define LEGION_PWR_STRIDE_FRAMES  64u   /* 64×256/56e6 ≈ 293 мкс; ≥16 снимков / 5 мс */
#define LEGION_FRAME_MASK         0x7fu
#define LEGION_DROP_FR_NONE       0x80u /* не кадр 0..127 */
#define LEGION_GRID_KIND_UNKNOWN  0u
#define LEGION_GRID_KIND_FHSS     1u    /* fhss-narrow */
#define LEGION_GRID_KIND_OFDM     2u    /* ofdm-wide */
#define LEGION_GRID_KIND_ANALOG   3u
#define LEGION_GRID_KIND_ZC       4u    /* droneid-zc */
#define LEGION_GRID_KIND_CW       5u
#define LEGION_GRID_SRC_NONE      0u
#define LEGION_GRID_SRC_MATCHER   1u
#define LEGION_GRID_SRC_PRESET    2u
#define LEGION_GRID_SRC_OPERATOR  3u
#define LEGION_GRID_SRC_TILE2     4u
#define LEGION_GRID_FLAG_WINLIM   (1u << 0)
#define LEGION_GRID_FLAG_F0UNC    (1u << 1)
#define LEGION_GRID_FLAG_ZC       (1u << 2)
#define LEGION_GRID_FLAG_FCORR    (1u << 3)
#define LEGION_C58_KHZ            5100000u
#define LEGION_CH_PWR_VALID(w)    (((w) & 0x80000000u) != 0)
#define LEGION_CH_PWR_FRAME(w)    (((w) >> 24) & LEGION_FRAME_MASK)
#define LEGION_CH_PWR_MAG(w)      (((w) >> 8) & 0xffffu)
#define LEGION_CH_PWR_IDX(w)      ((w) & 0xffu)
#define LEGION_GRID_META_N(m)     ((m) & 0xffu)
#define LEGION_GRID_META_KIND(m)  (((m) >> 28) & 0xfu)
#define LEGION_GRID_META_SRC(m)   (((m) >> 24) & 0xfu)

/* Режимы MODE — зеркало legion_pkg.vhd (LEGION_MODE_*) */
#define LEGION_MODE_PASS          0x0   /* обычный стрим с хоста */
#define LEGION_MODE_PLAYER        0x1   /* волна из RAM */
#define LEGION_MODE_NCO           0x2   /* тон DDS */
#define LEGION_MODE_LB_GATED      0x3   /* RX→TX по детектору */
#define LEGION_MODE_LB_ALWAYS     0x4   /* RX→TX всегда */
#define LEGION_MODE_AIM           0x5   /* NCO по CH_TARGET */

/* Статус (STATUS-PIO, читается по read-пакету target 0x80), биты:
 *   0 playing, 1 capture_done, 2 det_active, 3 wd_fired (HDL, живой),
 *   4 wd_latch (NIOS, липкий до следующего ARM — HDL 7..4 = 0, бит
 *   подмешивается в legion_reg_read: после автономного DISARM по deadman
 *   HDL-бит 3 гаснет за мкс, enable=0 сбрасывает expired),
 *   15..8 lb_fifo_level, 31..16 det_count;
 *   7:5 — состояние walk-off (HDL), бит 4 = 0 в HDL (латч NIOS)
 * (зеркало legion_regs.vhd, процесс status_tx) */
#define LEGION_STATUS_DET_ACTIVE  (1u << 2)
#define LEGION_STATUS_WD_FIRED    (1u << 3)
#define LEGION_STATUS_WD_LATCH    (1u << 4)
#define LEGION_STATUS_WALK_SHIFT  5
#define LEGION_STATUS_WALK_MASK   (7u << 5)

/* Запись/чтение регистра LEGION в FPGA (через PIO legion_wdata/legion_aws).
 * Реализация — в legion_cmds.c; вызывается из pkt_8x32.c (case 0x80). */
bool legion_reg_write(uint8_t addr, uint32_t data);
bool legion_reg_read(uint8_t addr, uint32_t *data);

/* Эфир micro: подъём/стендбай воздушного тракта через Nuand RFIC-интерфейс
 * NIOS (rfic_command_write_immed, devices_rfic.c). На bladeRF 1 — no-op.
 * Подъём: INIT(ON) → TX mute → (вход в 4x: FILTER DEC4/INT4, затем LO/fs/BW;
 * выход из 4x: LO/fs/BW, затем FILTER default — Nuand bladerf2.c) →
 * readback FILTER/SAMPLERATE/BANDWIDTH/GAINMODE → ENABLE → TX unmute.
 * Отказ после INIT → STANDBY.
 * DISARM: CTRL=0, затем air_down; отказ STANDBY = write false.
 * Первый подъём после питания — полный ad9361_init (сотни мс): хост
 * ждёт длинным таймаутом. */
bool legion_air_up(bool rx, bool tx);
bool legion_air_down(void);

/* Фоновая работа из main-loop (else-ветка bladeRF_nios.c, рядом с
 * do_work пакетных обработчиков). Deadman без хоста: watchdog сработал
 * (STATUS.wd_fired) при живом ARM → сам DISARM: CTRL=0, на micro это
 * уводит RFIC в standby (case LEGION_REG_CTRL), на x40 снимаются
 * lms_rx/tx_enable в CONTROL (NIOS — хозяин PIO, devices_inline.h).
 * USB NIOS не отдаёт — он не хозяин линка; release делает шлюз.
 * После deadman (если ARM жив и SCAN_CTRL.enable): шаг LO по коридору.
 * FFT_CTRL=0 (дефолт): взгляд = AIR_BW, гейт I²+Q², hop на центр взгляда.
 * FFT_CTRL.enable: SEARCH (TX mute, hop на центр взгляда) → SETTLE unmute →
 * FFT-бин → цифровой вырез на стоящем LO (legion_lb_xlat, FTW=bin≪24).
 * PLL во взгляде не трогаем — гейт снова микросекунды. FIRE_BW analog не
 * узжаем. Умная сетка: TILE = occupancy CH_PWR за look (stride 64 кадра);
 * aim = центр канала. CH_TARGET=0xFF — нет цели (0 = DC). После hop
 * drop_fr после unmute, не stale_fr за 6 мс. Пустая сетка — max mag, без
 * aim_en. CH_THR — слот 10 МГц; CH_PWR_THR — канал. Ноль = уровень выкл.
 * Пока бит 31 CH_TARGET снят, хоп внутри взгляда = live FFT → xlat.
 * Пока он вооружён, downmix и произведение стоят на [7:0]
 * (иначе TX = эмиттер − live + aim). Два тона ≥ 16 бинов: xlat bypass,
 * синтез не вооружается. Readback CH_TARGET — голый бин (0xFF = нет).
 * HOLD: TURN = выдержка, затем следующий взгляд (плитка);
 * PRIORITY: пока det — взгляд не шагаем;
 * PARK: одна стоянка на середине коридора (ICE9), PLL не гоняем.
 * SURVEY+PARK (ИИ): глухой проход 0…n−1 (mute) → LO на clip(PEAK) →
 * HDL DC-notch снят, SCAN_SURVEY_US от unmute — снова обзор.
 * Внутри окна SCAN_DWELL на сигнал: TURN=обычный (выдержка, потом другой
 * пик), иначе приоритет (сильнее — перескок и новая выдержка).
 * F1/F2 не пишет. Отказ hop не переводит в stare (не unmute на старом LO).
 * Отказ hop в обзоре/после периода: SEARCH + look_set=0 — повтор.
 * n==1 / PARK в HOLD: не enter_search на тот же LO (mute+SETTLE ломает µs).
 * USB в круге «увидел → усилитель» нет. */
void legion_work(void);

#endif /* LEGION_CMDS_H_ */
