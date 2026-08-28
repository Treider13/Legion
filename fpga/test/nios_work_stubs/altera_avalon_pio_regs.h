/* Записывающий PIO-стаб для nios_work_test.c: стоит ПЕРВЫМ в -I, поэтому
 * перекрывает nios_stubs/altera_avalon_pio_regs.h. Чтение/запись уходят в
 * журнал теста (t_pio_read/t_pio_write), CONTROL_BASE эмулируется как
 * настоящий регистр (RMW). Сигнатуры — как у Altera HAL. */
#ifndef LEGION_TEST_PIO_REGS_H_
#define LEGION_TEST_PIO_REGS_H_

#include <stdint.h>

uint32_t t_pio_read(uint32_t base);
void t_pio_write(uint32_t base, uint32_t data);

#define IORD_ALTERA_AVALON_PIO_DATA(base) t_pio_read((uint32_t)(base))
#define IOWR_ALTERA_AVALON_PIO_DATA(base, data) \
    t_pio_write((uint32_t)(base), (uint32_t)(data))

#define IORD_8DIRECT(base, offset)  ((void)((base) + (offset)), (uint8_t)0)
#define IORD_16DIRECT(base, offset) ((void)((base) + (offset)), (uint16_t)0)
#define IORD_32DIRECT(base, offset) ((void)((base) + (offset)), (uint32_t)0)
#define IOWR_8DIRECT(base, offset, data) \
    do { (void)((base) + (offset)); (void)(data); } while (0)
#define IOWR_16DIRECT(base, offset, data) \
    do { (void)((base) + (offset)); (void)(data); } while (0)
#define IOWR_32DIRECT(base, offset, data) \
    do { (void)((base) + (offset)); (void)(data); } while (0)

#endif /* LEGION_TEST_PIO_REGS_H_ */
