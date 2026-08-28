/* Синтетический altera_avalon_pio_regs.h: настоящий — из Altera HAL
 * (поставляется с Quartus) и тянет <io.h> с IOWR_8DIRECT/IORD_32DIRECT
 * и т.п. Здесь — компилируемый эквивалент сигнатур для проверки на ПК. */
#ifndef LEGION_STUB_ALTERA_AVALON_PIO_REGS_H_
#define LEGION_STUB_ALTERA_AVALON_PIO_REGS_H_

#include <stdint.h>

#define IORD_ALTERA_AVALON_PIO_DATA(base) ((void)(base), (uint32_t)0)
#define IOWR_ALTERA_AVALON_PIO_DATA(base, data) \
    do { (void)(base); (void)(data); } while (0)

/* <io.h> из Altera HAL: прямой доступ по адресу со смещением */
#define IORD_8DIRECT(base, offset)  ((void)((base) + (offset)), (uint8_t)0)
#define IORD_16DIRECT(base, offset) ((void)((base) + (offset)), (uint16_t)0)
#define IORD_32DIRECT(base, offset) ((void)((base) + (offset)), (uint32_t)0)
#define IOWR_8DIRECT(base, offset, data) \
    do { (void)((base) + (offset)); (void)(data); } while (0)
#define IOWR_16DIRECT(base, offset, data) \
    do { (void)((base) + (offset)); (void)(data); } while (0)
#define IOWR_32DIRECT(base, offset, data) \
    do { (void)((base) + (offset)); (void)(data); } while (0)

#endif /* LEGION_STUB_ALTERA_AVALON_PIO_REGS_H_ */
