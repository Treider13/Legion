/* ============================================================================
 * LEGION FPGA — NIOS II сторона регистрового канала (bladeRF 1 x40 и
 * bladeRF 2.0 micro xA4/xA9).
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
 *
 * Эфир micro (AD9361): хост при закрытии USB-handle гасит RFIC
 * (bladerf2_close → rfic->standby → clear RFFE + ad9361_deinit — факт из
 * libbladeRF rfic_host.c), поэтому воздушный тракт перед ARM поднимает NIOS
 * через штатный RFIC-интерфейс Nuand для FPGA-tuning (devices_rfic.c):
 * INIT(ON) → LO/fs/BW/gain → TX unmute → ENABLE. Частота/усиление приезжают
 * регистрами AIR_FREQ_KHZ/AIR_GAIN_DB до записи AIR_PREP. На bladeRF 1 это
 * не нужно: там аналог включает шлюз через CONTROL bit1/2 (bladerf_p.vhd).
 * =========================================================================*/
#include "legion_cmds.h"

#include <system.h>
#include <altera_avalon_pio_regs.h>

#include "debug.h"

#if defined(BOARD_BLADERF_MICRO) && defined(BLADERF_NIOS_LIBAD936X)
#include "devices_rfic.h"
#define LEGION_HAVE_RFIC 1
#endif

/* Тракт ретрансляции micro: fs и analog BW парковки (хост паркует так же —
 * tools/sdr_worker.py FPGA_PARK_FS_HZ). Окно детектора 16 сэмплов = 8 мкс. */
#define LEGION_AIR_FS_HZ 2000000U
#define LEGION_AIR_BW_HZ 2000000U

/* Параметры эфира, приехавшие регистрами (только NIOS, в HDL не пишутся).
 * gain: 0xFFFFFFFF = «не задан» (остаётся из init AD9361); 0 дБ — легальное
 * значение, поэтому ноль сентинелом быть не может. */
static uint32_t legion_air_freq_khz;
static uint32_t legion_air_gain_db = 0xFFFFFFFFU;
static bool     legion_air_is_up;

bool legion_air_up(bool rx, bool tx)
{
#if defined(LEGION_HAVE_RFIC)
    uint64_t const freq_hz = (uint64_t)legion_air_freq_khz * 1000ULL;

    if (freq_hz == 0) {
        DBG("LEGION: AIR без частоты (AIR_FREQ_KHZ=0) — отказ\n");
        return false;
    }

    /* INIT(ON): уже ON — no-op; STANDBY — тёплый рестор; OFF — полный
     * ad9361_init с калибровками (сотни мс, один раз после питания). */
    if (!rfic_command_write_immed(BLADERF_RFIC_COMMAND_INIT,
                                  RFIC_SYSTEM_CHANNEL,
                                  BLADERF_RFIC_INIT_STATE_ON)) {
        DBG("LEGION: RFIC INIT ON — отказ\n");
        return false;
    }

    if (rx) {
        if (!rfic_command_write_immed(BLADERF_RFIC_COMMAND_FREQUENCY,
                                      BLADERF_CHANNEL_RX(0), freq_hz) ||
            !rfic_command_write_immed(BLADERF_RFIC_COMMAND_SAMPLERATE,
                                      BLADERF_CHANNEL_RX(0), LEGION_AIR_FS_HZ) ||
            !rfic_command_write_immed(BLADERF_RFIC_COMMAND_BANDWIDTH,
                                      BLADERF_CHANNEL_RX(0), LEGION_AIR_BW_HZ) ||
            /* Ручной gain: AGC после ARM уплыл бы — порог детектора
             * посчитан хостом при усилении парковки и дальше неизменен. */
            !rfic_command_write_immed(BLADERF_RFIC_COMMAND_GAINMODE,
                                      BLADERF_CHANNEL_RX(0), BLADERF_GAIN_MGC)) {
            DBG("LEGION: RFIC RX cfg — отказ\n");
            return false;
        }
        /* Усиление — ровно то, при котором хост мерил шумовую полку:
         * парк пиннит MGC, читает gain и шлёт его в ARM (gain_db). */
        if (legion_air_gain_db != 0xFFFFFFFFU &&
            !rfic_command_write_immed(BLADERF_RFIC_COMMAND_GAIN,
                                      BLADERF_CHANNEL_RX(0),
                                      legion_air_gain_db)) {
            DBG("LEGION: RFIC RX gain — отказ\n");
            return false;
        }
    }

    if (tx) {
        if (!rfic_command_write_immed(BLADERF_RFIC_COMMAND_FREQUENCY,
                                      BLADERF_CHANNEL_TX(0), freq_hz) ||
            !rfic_command_write_immed(BLADERF_RFIC_COMMAND_SAMPLERATE,
                                      BLADERF_CHANNEL_TX(0), LEGION_AIR_FS_HZ) ||
            !rfic_command_write_immed(BLADERF_RFIC_COMMAND_BANDWIDTH,
                                      BLADERF_CHANNEL_TX(0), LEGION_AIR_BW_HZ) ||
            !rfic_command_write_immed(BLADERF_RFIC_COMMAND_TXMUTE,
                                      BLADERF_CHANNEL_TX(0), 0)) {
            DBG("LEGION: RFIC TX cfg — отказ\n");
            return false;
        }
    }

    /* ENABLE последним: RFFE SPDT/MIMO/ENABLE + выбор порта AD9361 по
     * частоте — внутри штатного _rfic_cmd_wr_enable (devices_rfic_cmds.c). */
    if (rx && !rfic_command_write_immed(BLADERF_RFIC_COMMAND_ENABLE,
                                        BLADERF_CHANNEL_RX(0), 1)) {
        DBG("LEGION: RFIC RX enable — отказ\n");
        return false;
    }
    if (tx && !rfic_command_write_immed(BLADERF_RFIC_COMMAND_ENABLE,
                                        BLADERF_CHANNEL_TX(0), 1)) {
        DBG("LEGION: RFIC TX enable — отказ\n");
        return false;
    }

    legion_air_is_up = true;
    DBG("LEGION: эфир поднят: %lu кГц, RX=%d TX=%d\n",
        (unsigned long)legion_air_freq_khz, (int)rx, (int)tx);
    return true;
#elif defined(BOARD_BLADERF_MICRO)
    /* micro без libad936x (RAM_SPAN < 128 KiB, devices.h) — эфир не поднять */
    DBG("LEGION: micro без libad936x — AIR отказ\n");
    (void)rx;
    (void)tx;
    return false;
#else
    /* bladeRF 1 x40: аналог включает шлюз через CONTROL bit1/2 — здесь no-op */
    (void)rx;
    (void)tx;
    return true;
#endif
}

bool legion_air_down(void)
{
#if defined(LEGION_HAVE_RFIC)
    /* Следующий подъём мерит полку при другом усилении — gain не кэшируем. */
    legion_air_gain_db = 0xFFFFFFFFU;
    if (!legion_air_is_up) {
        return true;
    }
    /* STANDBY = тёплое гашение: clear RFFE + TX mute, чип остаётся
     * сконфигурированным — следующий подъём быстрый (без ad9361_init). */
    if (!rfic_command_write_immed(BLADERF_RFIC_COMMAND_INIT,
                                  RFIC_SYSTEM_CHANNEL,
                                  BLADERF_RFIC_INIT_STATE_STANDBY)) {
        DBG("LEGION: RFIC STANDBY — отказ\n");
        return false;
    }
    legion_air_is_up = false;
    DBG("LEGION: эфир в standby\n");
    return true;
#else
    return true;
#endif
}

bool legion_reg_write(uint8_t addr, uint32_t data)
{
    if (addr > LEGION_REG_AIR_PREP) {
        DBG("LEGION: bad addr 0x%x\n", addr);
        return false;
    }

    switch (addr) {
        case LEGION_REG_AIR_FREQ_KHZ:
            legion_air_freq_khz = data;
            return true;

        case LEGION_REG_AIR_GAIN_DB:
            legion_air_gain_db = data;
            return true;

        case LEGION_REG_AIR_PREP:
            if (data & 0x1) {
                return legion_air_up((data & 0x2) != 0, (data & 0x4) != 0);
            }
            return legion_air_down();

        case LEGION_REG_CTRL:
#if defined(BOARD_BLADERF_MICRO)
            /* ARM loopback без поднятого эфира — молчаливый отказ: иначе
             * мукс гейтил бы тишину из мёртвого (standby) тракта AD9361. */
            if ((data & 0x1) != 0) {
                uint8_t const mode = (data >> 1) & 0x7;
                if ((mode == LEGION_MODE_LB_GATED ||
                     mode == LEGION_MODE_LB_ALWAYS) && !legion_air_is_up) {
                    DBG("LEGION: ARM lb_* без AIR_PREP — отказ\n");
                    return false;
                }
            }
#endif
            if ((data & 0x1) == 0 && legion_air_is_up) {
                /* DISARM: эфир гасим сами — шлюз про RFIC не знает */
                legion_air_down();
            }
            break;

        default:
            break;
    }

    IOWR_ALTERA_AVALON_PIO_DATA(LEGION_WDATA_BASE, data);
    IOWR_ALTERA_AVALON_PIO_DATA(LEGION_AWS_BASE, 0x80 | addr);
    IOWR_ALTERA_AVALON_PIO_DATA(LEGION_AWS_BASE, 0x00);
    return true;
}

bool legion_reg_read(uint8_t addr, uint32_t *data)
{
    /* Readback эфира — из статиков NIOS, не из HDL: «ok» AIR_PREP без
     * readback был бы вайбом (та же философия, что readback LO/fs в park). */
    if (addr == LEGION_REG_AIR_PREP) {
        *data = (legion_air_is_up ? 0x1u : 0x0u) |
                (legion_air_freq_khz != 0 ? 0x2u : 0x0u);
        return true;
    }
    *data = IORD_ALTERA_AVALON_PIO_DATA(LEGION_STATUS_BASE);
    return true;
}
