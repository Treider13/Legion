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

/* Запись/чтение регистра LEGION в FPGA (через PIO legion_wdata/legion_aws).
 * Реализация — в legion_cmds.c; вызывается из pkt_8x32.c (case 0x80). */
bool legion_reg_write(uint8_t addr, uint32_t data);
bool legion_reg_read(uint8_t addr, uint32_t *data);

#endif /* LEGION_CMDS_H_ */
