/* Зонд невакуумности для check_nios_syntax.sh: повторяет последовательность
 * include'ов legion_cmds.c и проверяет его gate LEGION_HAVE_RFIC:
 *   #if defined(BOARD_BLADERF_MICRO) && defined(BLADERF_NIOS_LIBAD936X)
 * Без #include "devices.h" в legion_cmds.c BLADERF_NIOS_LIBAD936X не
 * определялся даже в конфиге micro-rfic — RFIC-путь был мёртвым и в этой
 * проверке, и (главное) в реальной сборке NIOS: Makefile micro задаёт
 * -DBOARD_BLADERF_MICRO, но не -DBLADERF_NIOS_LIBAD936X (тот живёт только
 * в devices.h по RAM_SPAN). Найдено этой проверкой 2026-08-28. */
#include <system.h>
#include <altera_avalon_pio_regs.h>
#include "debug.h"
#include "devices.h"

#if defined(LEGION_PROBE_EXPECT_RFIC)
#   if defined(BOARD_BLADERF_MICRO) && defined(BLADERF_NIOS_LIBAD936X)
        /* ожидали RFIC-ветку — она есть */
#   else
#       error "RFIC path expected but gated out (BLADERF_NIOS_LIBAD936X?)"
#   endif
#else
#   if defined(BOARD_BLADERF_MICRO) && defined(BLADERF_NIOS_LIBAD936X)
#       error "RFIC path active in a config where it must be compiled out"
#   endif
#endif

int legion_probe_dummy;
