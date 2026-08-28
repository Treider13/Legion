/* Синтетический system.h для синтаксической проверки NIOS-кода на ПК.
 * Настоящий system.h генерирует BSP (nios_system) при сборке Quartus —
 * в репозитории его нет и быть не может. Здесь только BASE-адреса,
 * которые реально читает проверяемый код. RAM_SPAN переопределяется
 * через -D (≥128 KiB включает BLADERF_NIOS_LIBAD936X, devices.h). */
#ifndef LEGION_STUB_SYSTEM_H_
#define LEGION_STUB_SYSTEM_H_

#ifndef RAM_SPAN
#define RAM_SPAN 131072
#endif

#define LEGION_WDATA_BASE  0x01000000
#define LEGION_AWS_BASE    0x01000004
#define LEGION_STATUS_BASE 0x01000008
#define CONTROL_BASE       0x01000010
#define OPENCORES_I2C_BASE 0x01000020
#define XB_GPIO_BASE       0x01000030
#define XB_GPIO_DIR_BASE   0x01000034
#define RX_TAMER_BASE      0x01000040
#define TX_TAMER_BASE      0x01000050
#define COMMAND_UART_BASE  0x01000060

#endif /* LEGION_STUB_SYSTEM_H_ */
