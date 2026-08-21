/* ============================================================================
 * LEGION FPGA — NIOS II сторона регистрового канала (bladeRF 1 x40).
 *
 * Паттерн доступа к фабрике — как у штатного кода Nuand (devices.c):
 *   IOWR_ALTERA_AVALON_PIO_DATA(<NAME>_BASE, value) — базовые адреса даёт
 *   BSP (system.h) после регенерации nios_system с нашими PIO
 *   (fpga/integration/nios_system-legion.tcl.snippet).
 *
 * Протокол записи регистра (два PIO):
 *   1) IOWR(LEGION_WDATA, data)            — данные
 *   2) IOWR(LEGION_AWS, 0x80 | addr)       — строб we + адрес
 *   3) IOWR(LEGION_AWS, 0x00)              — снять строб
 * Чтение: статус целиком на LEGION_STATUS PIO (addr игнорируется).
 * =========================================================================*/
#include "legion_cmds.h"

#include <system.h>
#include <altera_avalon_pio_regs.h>

#include "debug.h"

bool legion_reg_write(uint8_t addr, uint32_t data)
{
    if (addr > LEGION_REG_WD_KICK) {
        DBG("LEGION: bad addr 0x%x\n", addr);
        return false;
    }
    IOWR_ALTERA_AVALON_PIO_DATA(LEGION_WDATA_BASE, data);
    IOWR_ALTERA_AVALON_PIO_DATA(LEGION_AWS_BASE, 0x80 | addr);
    IOWR_ALTERA_AVALON_PIO_DATA(LEGION_AWS_BASE, 0x00);
    return true;
}

bool legion_reg_read(uint8_t addr, uint32_t *data)
{
    (void)addr;  /* статус единый, адрес не используется */
    *data = IORD_ALTERA_AVALON_PIO_DATA(LEGION_STATUS_BASE);
    return true;
}
