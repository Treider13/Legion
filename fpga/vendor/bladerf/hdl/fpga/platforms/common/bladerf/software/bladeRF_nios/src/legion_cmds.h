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

/* Режимы MODE — зеркало legion_pkg.vhd (LEGION_MODE_*) */
#define LEGION_MODE_PASS          0x0   /* обычный стрим с хоста */
#define LEGION_MODE_PLAYER        0x1   /* волна из RAM */
#define LEGION_MODE_NCO           0x2   /* тон DDS */
#define LEGION_MODE_LB_GATED      0x3   /* RX→TX по детектору */
#define LEGION_MODE_LB_ALWAYS     0x4   /* RX→TX всегда */

/* Статус (STATUS-PIO, читается по read-пакету target 0x80), биты:
 *   0 playing, 1 capture_done, 2 det_active, 3 wd_fired,
 *   15..8 lb_fifo_level, 31..16 det_count
 * (зеркало legion_regs.vhd, процесс status_tx) */
#define LEGION_STATUS_WD_FIRED    (1u << 3)

/* Запись/чтение регистра LEGION в FPGA (через PIO legion_wdata/legion_aws).
 * Реализация — в legion_cmds.c; вызывается из pkt_8x32.c (case 0x80). */
bool legion_reg_write(uint8_t addr, uint32_t data);
bool legion_reg_read(uint8_t addr, uint32_t *data);

/* Эфир micro: подъём/стендбай воздушного тракта через Nuand RFIC-интерфейс
 * NIOS (rfic_command_write_immed, devices_rfic.c). На bladeRF 1 — no-op.
 * Подъём: INIT(ON) → TX mute → LO/fs/BW/gain(+readback GAINMODE) →
 * ENABLE → TX unmute последним. Первый подъём после питания — полный
 * ad9361_init (сотни мс): хост ждёт длинным таймаутом. */
bool legion_air_up(bool rx, bool tx);
bool legion_air_down(void);

/* Фоновая работа из main-loop (else-ветка bladeRF_nios.c, рядом с
 * do_work пакетных обработчиков). Deadman без хоста: watchdog сработал
 * (STATUS.wd_fired) при живом ARM → сам DISARM: CTRL=0, на micro это
 * уводит RFIC в standby (case LEGION_REG_CTRL), на x40 снимаются
 * lms_rx/tx_enable в CONTROL (NIOS — хозяин PIO, devices_inline.h).
 * USB NIOS не отдаёт — он не хозяин линка; release делает шлюз. */
void legion_work(void);

#endif /* LEGION_CMDS_H_ */
