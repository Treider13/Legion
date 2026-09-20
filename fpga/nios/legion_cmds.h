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
#define LEGION_REG_SCAN_DWELL_US  0x11  /* выдержка turn от первого детекта, мкс; 0 = 3e6 */
/* Точный Гц: FFT-пик на FPGA. 0x12–0x14/0x17–0x1B — статики NIOS.
 * 0x15 — mux STATUS (IOWR AWS=0x15, IORD STATUS). 0x16 — HDL+NIOS. */
#define LEGION_REG_SEARCH_BW_HZ   0x12  /* analog BW обзора, Гц; 0 = AIR_BW */
#define LEGION_REG_FIRE_BW_HZ     0x13  /* leftover; вырез цифровой, analog не узжаем */
#define LEGION_REG_PEAK_KHZ       0x14  /* найденная частота, кГц (считает NIOS) */
#define LEGION_REG_PEAK_BIN       0x15  /* слово пика HDL: bin/mag/frame/valid */
#define LEGION_REG_FFT_CTRL       0x16  /* bit0 enable, bit1 dc_notch */
#define LEGION_REG_BAND_IDX       0x17  /* 0..7 — куда писать F1/F2 */
#define LEGION_REG_BAND_F1_KHZ    0x18
#define LEGION_REG_BAND_F2_KHZ    0x19
#define LEGION_REG_BAND_COUNT     0x1A  /* 0 = один коридор SCAN_F1/F2 */
#define LEGION_REG_SETTLE_N       0x1B  /* сэмплы после hop; 0 = 4096 */

#define LEGION_SCAN_CTRL_EN       (1u << 0)
#define LEGION_SCAN_CTRL_TURN     (1u << 1)
#define LEGION_SCAN_CTRL_PARK     (1u << 2) /* ICE9: один LO на середине коридора */
#define LEGION_SCAN_CTRL_SURVEY   (1u << 3) /* глухой обзор → 56 МГц на всплеск → T */
#define LEGION_FFT_CTRL_EN        (1u << 0)
#define LEGION_FFT_CTRL_DC_NOTCH  (1u << 1)
#define LEGION_BAND_MAX           8u
#define LEGION_SURVEY_LOOK_MAX    128u
#define LEGION_FIRE_BW_DEFAULT_HZ 2000000u
#define LEGION_SETTLE_N_DEFAULT   4096u
#define LEGION_REG_MAX            LEGION_REG_SETTLE_N

/* Режимы MODE — зеркало legion_pkg.vhd (LEGION_MODE_*) */
#define LEGION_MODE_PASS          0x0   /* обычный стрим с хоста */
#define LEGION_MODE_PLAYER        0x1   /* волна из RAM */
#define LEGION_MODE_NCO           0x2   /* тон DDS */
#define LEGION_MODE_LB_GATED      0x3   /* RX→TX по детектору */
#define LEGION_MODE_LB_ALWAYS     0x4   /* RX→TX всегда */

/* Статус (STATUS-PIO, читается по read-пакету target 0x80), биты:
 *   0 playing, 1 capture_done, 2 det_active, 3 wd_fired (HDL, живой),
 *   4 wd_latch (NIOS, липкий до следующего ARM — HDL 7..4 = 0, бит
 *   подмешивается в legion_reg_read: после автономного DISARM по deadman
 *   HDL-бит 3 гаснет за мкс, enable=0 сбрасывает expired),
 *   15..8 lb_fifo_level, 31..16 det_count
 * (зеркало legion_regs.vhd, процесс status_tx) */
#define LEGION_STATUS_DET_ACTIVE  (1u << 2)
#define LEGION_STATUS_WD_FIRED    (1u << 3)
#define LEGION_STATUS_WD_LATCH    (1u << 4)

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
 * узжаем. HOLD: TURN = выдержка, затем следующий взгляд (плитка);
 * PRIORITY: пока det — взгляд не шагаем;
 * PARK: одна стоянка на середине коридора (ICE9), PLL не гоняем —
 * хоп внутри взгляда = live FFT → xlat.
 * SURVEY (bit3, FFT on, коридор шире взгляда): глухой проход 0…n−1
 * (enter_search mute, без unmute после SETTLE) → LO на clip(PEAK)
 * → HDL DC-notch снят (тон в bin 0), SCAN_DWELL от unmute → снова обзор.
 * F1/F2 не пишет. Отказ hop не переводит в stare (не unmute на старом LO).
 * n==1 / PARK в HOLD: не enter_search на тот же LO (mute+SETTLE ломает µs).
 * USB в круге «увидел → усилитель» нет. */
void legion_work(void);

#endif /* LEGION_CMDS_H_ */
