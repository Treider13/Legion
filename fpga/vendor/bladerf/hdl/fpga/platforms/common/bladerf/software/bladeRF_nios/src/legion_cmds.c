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
#include "devices.h"  /* control_reg_read/write — x40: снять lms_*_enable при deadman
                       * time_tamer_read(RX) — счётчик сэмплов (оба борта) */

#if defined(BOARD_BLADERF_MICRO) && defined(BLADERF_NIOS_LIBAD936X)
#include "devices_rfic.h"
#define LEGION_HAVE_RFIC 1
#endif

#if !defined(BOARD_BLADERF_MICRO)
#include "lms.h"
#include "band_select.h"
#endif

/* Тракт ретрансляции micro: fs и analog BW парковки (хост паркует так же —
 * tools/sdr_worker.py FPGA_PARK_FS_HZ). Окно детектора 16 сэмплов = 8 мкс. */
#define LEGION_AIR_FS_HZ 2000000U
#define LEGION_AIR_BW_HZ 2000000U
/* 0 = «не задан» → дефолт 2 МГц (эфир lb_gated). Solo пишет окно оператора. */

/* Параметры эфира, приехавшие регистрами (только NIOS, в HDL не пишутся).
 * gain: 0xFFFFFFFF = «не задан» (остаётся из init AD9361); на проводе gain
 * кодируется смещением +1000, чтобы легальные 0/−1 дБ не сталкивались с
 * сентинелом. */
static uint32_t legion_air_freq_khz;
static uint32_t legion_air_gain_db = 0xFFFFFFFFU;
static uint32_t legion_air_fs_hz;
static uint32_t legion_air_bw_hz;
static uint32_t legion_air_fs_actual; /* прочитанный с чипа fs; 0 = нет факта */
static bool     legion_air_is_up;
static bool     legion_air_dirty;     /* INIT прошёл, RFIC может быть жив */
#define LEGION_FS_4X_MIN 520834u
#define LEGION_FS_4X_MAX 2083334u
/* CTRL.ARM, как записан хостом (нужен legion_work: в STATUS бита armed нет —
 * там playing/cap_done/det_active/wd_fired, legion_regs.vhd). */
static bool     legion_armed;
/* Липкий «deadman сработал»: HDL-бит wd_fired (STATUS.3) после нашего
 * CTRL=0 гаснет за микросекунды (enable=0 сбрасывает expired,
 * legion_watchdog.vhd) — хост читал бы пульс никогда. Держим латч до
 * следующего ARM и подмешиваем в чтение STATUS битом 4 (HDL 7..4 = 0). */
static bool     legion_wd_latch;

/* Онбордовый обзор: коридор и стратегия. HDL эти адреса не декодирует. */
static uint32_t legion_scan_f1_khz;
static uint32_t legion_scan_f2_khz;
static uint32_t legion_scan_ctrl;
static uint32_t legion_scan_dwell_us;
static uint32_t legion_scan_idx;
static int      legion_scan_dir;      /* +1 / −1, ping-pong как planCenters */
static bool     legion_scan_look_set; /* tamer якорь текущей стоянки */
static uint64_t legion_quiet_t0;
static bool     legion_hold_armed;    /* TURN: выдержка от первого det в взгляде */
static uint64_t legion_hold_t0;

#define LEGION_SCAN_QUIET_MS     5u
#define LEGION_SCAN_DWELL_DEFAULT_US 3000000u

#if defined(LEGION_HAVE_RFIC)
static bool legion_fs_needs_4x(uint32_t fs)
{
    return fs >= LEGION_FS_4X_MIN && fs <= LEGION_FS_4X_MAX;
}

/* Nuand/foxhunt: FILTER до SAMPLERATE. 4x только в [520834, 2083334]. */
static bool legion_rfic_write_filters(uint32_t fs_hz)
{
    uint32_t const rx_fir = legion_fs_needs_4x(fs_hz)
        ? (uint32_t)BLADERF_RFIC_RXFIR_DEC4
        : (uint32_t)BLADERF_RFIC_RXFIR_DEFAULT;
    uint32_t const tx_fir = legion_fs_needs_4x(fs_hz)
        ? (uint32_t)BLADERF_RFIC_TXFIR_INT4
        : (uint32_t)BLADERF_RFIC_TXFIR_DEFAULT;

    if (!rfic_command_write_immed(BLADERF_RFIC_COMMAND_FILTER,
                                  BLADERF_CHANNEL_RX(0), rx_fir)) {
        return false;
    }
    if (!rfic_command_write_immed(BLADERF_RFIC_COMMAND_FILTER,
                                  BLADERF_CHANNEL_TX(0), tx_fir)) {
        return false;
    }
    return true;
}

static bool legion_rfic_readback_filter(bladerf_channel ch, uint64_t want)
{
    uint64_t got = 0;
    if (!rfic_command_read_immed(BLADERF_RFIC_COMMAND_FILTER, ch, &got)) {
        return false;
    }
    return got == want;
}

/* Допуск park: fs 15%. */
static bool legion_rfic_readback_fs(bladerf_channel ch, uint32_t want,
                                    uint32_t *actual)
{
    uint64_t got = 0;
    uint64_t diff;

    if (!rfic_command_read_immed(BLADERF_RFIC_COMMAND_SAMPLERATE, ch, &got)) {
        return false;
    }
    if (want == 0) {
        return false;
    }
    diff = got > want ? got - want : want - got;
    if (diff * 100ull > (uint64_t)want * 15ull) {
        return false;
    }
    if (actual != NULL) {
        *actual = (uint32_t)got;
    }
    return true;
}

/* Допуск park: BW не «1.5 вместо окна» — факт ≥ половины запроса. */
static bool legion_rfic_readback_bw(bladerf_channel ch, uint32_t want)
{
    uint64_t got = 0;

    if (!rfic_command_read_immed(BLADERF_RFIC_COMMAND_BANDWIDTH, ch, &got)) {
        return false;
    }
    return got >= ((uint64_t)want / 2ull);
}

static bool legion_rfic_standby(void)
{
    if (!rfic_command_write_immed(BLADERF_RFIC_COMMAND_INIT,
                                  RFIC_SYSTEM_CHANNEL,
                                  BLADERF_RFIC_INIT_STATE_STANDBY)) {
        DBG("LEGION: RFIC STANDBY — отказ\n");
        return false;
    }
    legion_air_is_up = false;
    legion_air_dirty = false;
    legion_air_fs_actual = 0;
    legion_air_gain_db = 0xFFFFFFFFU;
    DBG("LEGION: эфир в standby\n");
    return true;
}

static void legion_air_fail_rollback(void)
{
    legion_air_is_up = false;
    legion_air_fs_actual = 0;
    (void)legion_rfic_standby();
}
#endif

static void legion_scan_reset(void)
{
    legion_scan_idx = 0;
    legion_scan_dir = 1;
    legion_scan_look_set = false;
    legion_quiet_t0 = 0;
    legion_hold_armed = false;
    legion_hold_t0 = 0;
}

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
    legion_air_dirty = true;

    /* TX глушим сразу после INIT, ДО любых перестроек. Раньше нельзя:
     * TXMUTE требует init_state==ON (RFIC_CMD_INIT_REQD, devices_rfic.c).
     * RFIC-апдейты (FREQUENCY/SAMPLERATE) могут перезапускать
     * TX-калибровку — апстрим Nuand позже ввёл для этого guard TX_RECAL;
     * в нашем дереве его нет, держим mute сами до конца последовательности.
     * (INIT из OFF сам кратко отмыкает TX на attenuation из init-params —
     * 10 дБ, ad936x_params.c — это поведение апстрима, не нашего тракта.) */
    if (tx && !rfic_command_write_immed(BLADERF_RFIC_COMMAND_TXMUTE,
                                        BLADERF_CHANNEL_TX(0), 1)) {
        DBG("LEGION: RFIC TX mute — отказ\n");
        legion_air_fail_rollback();
        return false;
    }

    legion_air_fs_actual = 0;

    uint32_t const fs_hz = legion_air_fs_hz ? legion_air_fs_hz : LEGION_AIR_FS_HZ;
    uint32_t const bw_hz = legion_air_bw_hz ? legion_air_bw_hz : LEGION_AIR_BW_HZ;
    uint32_t const rx_fir = legion_fs_needs_4x(fs_hz)
        ? (uint32_t)BLADERF_RFIC_RXFIR_DEC4
        : (uint32_t)BLADERF_RFIC_RXFIR_DEFAULT;
    uint32_t const tx_fir = legion_fs_needs_4x(fs_hz)
        ? (uint32_t)BLADERF_RFIC_TXFIR_INT4
        : (uint32_t)BLADERF_RFIC_TXFIR_DEFAULT;

    /* FILTER до любой SAMPLERATE — как Nuand bladerf2_set_sample_rate и foxhunt. */
    if (!legion_rfic_write_filters(fs_hz)) {
        DBG("LEGION: RFIC FILTER — отказ\n");
        legion_air_fail_rollback();
        return false;
    }

    if (rx) {
        if (!rfic_command_write_immed(BLADERF_RFIC_COMMAND_FREQUENCY,
                                      BLADERF_CHANNEL_RX(0), freq_hz) ||
            !rfic_command_write_immed(BLADERF_RFIC_COMMAND_SAMPLERATE,
                                      BLADERF_CHANNEL_RX(0), fs_hz) ||
            !rfic_command_write_immed(BLADERF_RFIC_COMMAND_BANDWIDTH,
                                      BLADERF_CHANNEL_RX(0), bw_hz) ||
            /* Ручной gain: AGC после ARM уплыл бы — порог детектора
             * посчитан хостом при усилении парковки и дальше неизменен. */
            !rfic_command_write_immed(BLADERF_RFIC_COMMAND_GAINMODE,
                                      BLADERF_CHANNEL_RX(0), BLADERF_GAIN_MGC)) {
            DBG("LEGION: RFIC RX cfg — отказ\n");
            legion_air_fail_rollback();
            return false;
        }
        /* Readback GAINMODE: записанный MGC без подтверждения — вайб (как
         * readback LO/fs в park). Молча живой AGC уплыл бы после ARM. */
        uint64_t gm = 0;
        uint32_t fs_got = 0;
        if (!rfic_command_read_immed(BLADERF_RFIC_COMMAND_GAINMODE,
                                     BLADERF_CHANNEL_RX(0), &gm) ||
            gm != BLADERF_GAIN_MGC) {
            DBG("LEGION: RFIC GAINMODE readback != MGC — отказ\n");
            legion_air_fail_rollback();
            return false;
        }
        if (!legion_rfic_readback_filter(BLADERF_CHANNEL_RX(0), rx_fir) ||
            !legion_rfic_readback_fs(BLADERF_CHANNEL_RX(0), fs_hz, &fs_got) ||
            !legion_rfic_readback_bw(BLADERF_CHANNEL_RX(0), bw_hz)) {
            DBG("LEGION: RFIC RX FILTER/fs/BW readback — отказ\n");
            legion_air_fail_rollback();
            return false;
        }
        legion_air_fs_actual = fs_got;
        /* Усиление — ровно то, при котором хост мерил шумовую полку:
         * парк пиннит MGC, читает gain и шлёт его в ARM (gain_db).
         * На проводе — смещение +1000 (сентинел 0xFFFFFFFF = «не задан»). */
        if (legion_air_gain_db != 0xFFFFFFFFU) {
            int32_t const gain_db = (int32_t)(legion_air_gain_db - 1000U);
            if (!rfic_command_write_immed(BLADERF_RFIC_COMMAND_GAIN,
                                          BLADERF_CHANNEL_RX(0),
                                          (uint32_t)gain_db)) {
                DBG("LEGION: RFIC RX gain — отказ\n");
                legion_air_fail_rollback();
                return false;
            }
        }
    }

    if (tx) {
        /* TX уже заглушён (сразу после INIT). Unmute — после ENABLE. */
        uint32_t fs_got = 0;
        if (!rfic_command_write_immed(BLADERF_RFIC_COMMAND_FREQUENCY,
                                      BLADERF_CHANNEL_TX(0), freq_hz) ||
            !rfic_command_write_immed(BLADERF_RFIC_COMMAND_SAMPLERATE,
                                      BLADERF_CHANNEL_TX(0), fs_hz) ||
            !rfic_command_write_immed(BLADERF_RFIC_COMMAND_BANDWIDTH,
                                      BLADERF_CHANNEL_TX(0), bw_hz)) {
            DBG("LEGION: RFIC TX cfg — отказ\n");
            legion_air_fail_rollback();
            return false;
        }
        if (!legion_rfic_readback_filter(BLADERF_CHANNEL_TX(0), tx_fir) ||
            !legion_rfic_readback_fs(BLADERF_CHANNEL_TX(0), fs_hz, &fs_got) ||
            !legion_rfic_readback_bw(BLADERF_CHANNEL_TX(0), bw_hz)) {
            DBG("LEGION: RFIC TX FILTER/fs/BW readback — отказ\n");
            legion_air_fail_rollback();
            return false;
        }
        if (legion_air_fs_actual == 0) {
            legion_air_fs_actual = fs_got;
        }
    }

    /* ENABLE последним: RFFE SPDT/MIMO/ENABLE + выбор порта AD9361 по
     * частоте — внутри штатного _rfic_cmd_wr_enable (devices_rfic_cmds.c). */
    if (rx && !rfic_command_write_immed(BLADERF_RFIC_COMMAND_ENABLE,
                                        BLADERF_CHANNEL_RX(0), 1)) {
        DBG("LEGION: RFIC RX enable — отказ\n");
        legion_air_fail_rollback();
        return false;
    }
    if (tx && !rfic_command_write_immed(BLADERF_RFIC_COMMAND_ENABLE,
                                        BLADERF_CHANNEL_TX(0), 1)) {
        DBG("LEGION: RFIC TX enable — отказ\n");
        legion_air_fail_rollback();
        return false;
    }

    /* Unmute последним: вся перестройка (и возможная TX-cal внутри неё)
     * прошла при заглушённом TX. */
    if (tx && !rfic_command_write_immed(BLADERF_RFIC_COMMAND_TXMUTE,
                                        BLADERF_CHANNEL_TX(0), 0)) {
        DBG("LEGION: RFIC TX unmute — отказ\n");
        legion_air_fail_rollback();
        return false;
    }

    legion_air_is_up = true;
    DBG("LEGION: эфир поднят: %lu кГц, RX=%d TX=%d fs=%lu\n",
        (unsigned long)legion_air_freq_khz, (int)rx, (int)tx,
        (unsigned long)legion_air_fs_actual);
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
    if (!legion_air_is_up && !legion_air_dirty) {
        return true;
    }
    return legion_rfic_standby();
#else
    return true;
#endif
}

static uint32_t legion_look_hz(void)
{
    return legion_air_bw_hz ? legion_air_bw_hz : LEGION_AIR_BW_HZ;
}

static uint32_t legion_fs_hz(void)
{
    if (legion_air_fs_actual != 0) {
        return legion_air_fs_actual;
    }
    return legion_air_fs_hz ? legion_air_fs_hz : LEGION_AIR_FS_HZ;
}

/* Сетка стоянок — та же формула, что planCenters в app/src/sense/scan.ts:
 * n = ceil(span/look), центр i = f1 + look/2 + i·look, клип к f2. */
static uint32_t legion_scan_n(void)
{
    uint32_t const look_khz = legion_look_hz() / 1000u;
    uint32_t span;

    if (legion_scan_f1_khz == 0 || legion_scan_f2_khz < legion_scan_f1_khz) {
        return 0;
    }
    if (look_khz == 0) {
        return 0;
    }
    span = legion_scan_f2_khz - legion_scan_f1_khz;
    if (span <= look_khz) {
        return 1;
    }
    return (span + look_khz - 1u) / look_khz;
}

static uint32_t legion_scan_center_khz(uint32_t i)
{
    uint32_t const look_khz = legion_look_hz() / 1000u;
    uint32_t const n = legion_scan_n();
    uint32_t c;

    if (n == 0) {
        return 0;
    }
    if (n == 1) {
        return (legion_scan_f1_khz / 2u) + (legion_scan_f2_khz / 2u);
    }
    if (i >= n) {
        i = n - 1u;
    }
    c = legion_scan_f1_khz + (look_khz / 2u) + i * look_khz;
    if (c > legion_scan_f2_khz) {
        c = legion_scan_f2_khz;
    }
    return c;
}

static void legion_scan_advance(void)
{
    uint32_t const n = legion_scan_n();

    if (n <= 1u) {
        return;
    }
    if (legion_scan_dir > 0) {
        if (legion_scan_idx + 1u >= n) {
            legion_scan_dir = -1;
            if (legion_scan_idx > 0) {
                legion_scan_idx--;
            }
        } else {
            legion_scan_idx++;
        }
    } else if (legion_scan_idx == 0) {
        legion_scan_dir = 1;
        if (n > 1u) {
            legion_scan_idx++;
        }
    } else {
        legion_scan_idx--;
    }
}

#if !defined(BOARD_BLADERF_MICRO)
/* Integer-копия lms_calculate_tuning_params (fpga_common/src/lms.c):
 * та же таблица VCO/DIV (консервативные края, не LMS FAQ), nint/nfrac
 * от ref 38.4 МГц, VCOCAP = 15 + round(40·(f−low)/(high−low)).
 * f->x не пишем — поле только вне BLADERF_NIOS_BUILD (lms.h). */
#define LEGION_LMS_REF_HZ   38400000u
#define LEGION_LMS_FMIN     237500000u   /* bladeRF1.h BLADERF_FREQUENCY_MIN */
#define LEGION_LMS_FMAX     3800000000u  /* VCO1_HIGH/2 */
#define LEGION_VCO4_LOW     3800000000ull
#define LEGION_VCO4_HIGH    4535000000ull
#define LEGION_VCO3_HIGH    5408000000ull
#define LEGION_VCO2_HIGH    6480000000ull
#define LEGION_VCO1_HIGH    7600000000ull
#define LEGION_VCO4         (4 << 3)
#define LEGION_VCO3         (5 << 3)
#define LEGION_VCO2         (6 << 3)
#define LEGION_VCO1         (7 << 3)
#define LEGION_DIV2         0x4
#define LEGION_DIV4         0x5
#define LEGION_DIV8         0x6
#define LEGION_DIV16        0x7

static int legion_lms_fill(uint32_t freq, struct lms_freq *f)
{
    static const struct {
        uint32_t low;
        uint32_t high;
        uint8_t  value;
    } bands[] = {
        { LEGION_LMS_FMIN,                    (uint32_t)(LEGION_VCO4_HIGH / 16), LEGION_VCO4 | LEGION_DIV16 },
        { (uint32_t)(LEGION_VCO4_HIGH / 16),  (uint32_t)(LEGION_VCO3_HIGH / 16), LEGION_VCO3 | LEGION_DIV16 },
        { (uint32_t)(LEGION_VCO3_HIGH / 16),  (uint32_t)(LEGION_VCO2_HIGH / 16), LEGION_VCO2 | LEGION_DIV16 },
        { (uint32_t)(LEGION_VCO2_HIGH / 16),  (uint32_t)(LEGION_VCO1_HIGH / 16), LEGION_VCO1 | LEGION_DIV16 },
        { (uint32_t)(LEGION_VCO4_LOW / 8),    (uint32_t)(LEGION_VCO4_HIGH / 8),  LEGION_VCO4 | LEGION_DIV8  },
        { (uint32_t)(LEGION_VCO4_HIGH / 8),   (uint32_t)(LEGION_VCO3_HIGH / 8),  LEGION_VCO3 | LEGION_DIV8  },
        { (uint32_t)(LEGION_VCO3_HIGH / 8),   (uint32_t)(LEGION_VCO2_HIGH / 8),  LEGION_VCO2 | LEGION_DIV8  },
        { (uint32_t)(LEGION_VCO2_HIGH / 8),   (uint32_t)(LEGION_VCO1_HIGH / 8),  LEGION_VCO1 | LEGION_DIV8  },
        { (uint32_t)(LEGION_VCO4_LOW / 4),    (uint32_t)(LEGION_VCO4_HIGH / 4),  LEGION_VCO4 | LEGION_DIV4  },
        { (uint32_t)(LEGION_VCO4_HIGH / 4),   (uint32_t)(LEGION_VCO3_HIGH / 4),  LEGION_VCO3 | LEGION_DIV4  },
        { (uint32_t)(LEGION_VCO3_HIGH / 4),   (uint32_t)(LEGION_VCO2_HIGH / 4),  LEGION_VCO2 | LEGION_DIV4  },
        { (uint32_t)(LEGION_VCO2_HIGH / 4),   (uint32_t)(LEGION_VCO1_HIGH / 4),  LEGION_VCO1 | LEGION_DIV4  },
        { (uint32_t)(LEGION_VCO4_LOW / 2),    (uint32_t)(LEGION_VCO4_HIGH / 2),  LEGION_VCO4 | LEGION_DIV2  },
        { (uint32_t)(LEGION_VCO4_HIGH / 2),   (uint32_t)(LEGION_VCO3_HIGH / 2),  LEGION_VCO3 | LEGION_DIV2  },
        { (uint32_t)(LEGION_VCO3_HIGH / 2),   (uint32_t)(LEGION_VCO2_HIGH / 2),  LEGION_VCO2 | LEGION_DIV2  },
        { (uint32_t)(LEGION_VCO2_HIGH / 2),   LEGION_LMS_FMAX,                  LEGION_VCO1 | LEGION_DIV2  },
    };
    unsigned i;
    uint64_t vco_x;
    uint64_t temp;
    uint32_t denom;
    uint32_t vcocap;

    if (freq < LEGION_LMS_FMIN) {
        freq = LEGION_LMS_FMIN;
    } else if (freq > LEGION_LMS_FMAX) {
        freq = LEGION_LMS_FMAX;
    }

    for (i = 0; i < (unsigned)(sizeof(bands) / sizeof(bands[0])); i++) {
        if (freq >= bands[i].low && freq <= bands[i].high) {
            break;
        }
    }
    if (i >= (unsigned)(sizeof(bands) / sizeof(bands[0]))) {
        return -1;
    }

    denom = bands[i].high - bands[i].low;
    if (denom == 0) {
        return -1;
    }
    /* 15 + round(40 · (f−low)/(high−low)), кламп 0x3f — estimate_vcocap */
    vcocap = 15u + (40u * (freq - bands[i].low) + denom / 2u) / denom;
    if (vcocap > 0x3fu) {
        vcocap = 0x3fu;
    }

    vco_x = ((uint64_t)1) << ((bands[i].value & 7) - 3);
    temp = (vco_x * (uint64_t)freq) / LEGION_LMS_REF_HZ;
    f->nint = (uint16_t)temp;
    temp = ((uint64_t)1 << 23) * (vco_x * (uint64_t)freq - (uint64_t)f->nint * LEGION_LMS_REF_HZ);
    temp = (temp + LEGION_LMS_REF_HZ / 2u) / LEGION_LMS_REF_HZ;
    f->nfrac = (uint32_t)temp;
    f->freqsel = bands[i].value;
    f->vcocap = (uint8_t)vcocap;
    f->xb_gpio = 0;
    f->flags = 0;
    if (freq < BLADERF1_BAND_HIGH) {
        f->flags |= LMS_FREQ_FLAGS_LOW_BAND;
    }
    return 0;
}
#endif

static bool legion_hop_lo(uint32_t freq_khz)
{
    uint64_t const freq_hz = (uint64_t)freq_khz * 1000ULL;

    if (freq_khz == 0 || freq_hz == 0) {
        return false;
    }

#if defined(LEGION_HAVE_RFIC)
    /* Живой тракт: mute → FREQUENCY RX+TX → unmute. Без INIT/ad9361_init. */
    if (!legion_air_is_up) {
        return false;
    }
    if (!rfic_command_write_immed(BLADERF_RFIC_COMMAND_TXMUTE,
                                  BLADERF_CHANNEL_TX(0), 1)) {
        return false;
    }
    {
        bool const rx_ok = rfic_command_write_immed(
            BLADERF_RFIC_COMMAND_FREQUENCY, BLADERF_CHANNEL_RX(0), freq_hz);
        bool const tx_ok = rfic_command_write_immed(
            BLADERF_RFIC_COMMAND_FREQUENCY, BLADERF_CHANNEL_TX(0), freq_hz);
        if (!rx_ok || !tx_ok) {
            /* Mute остаётся. Unmute на разных LO запрещён. */
            if (rx_ok && legion_air_freq_khz != 0) {
                (void)rfic_command_write_immed(
                    BLADERF_RFIC_COMMAND_FREQUENCY, BLADERF_CHANNEL_RX(0),
                    (uint64_t)legion_air_freq_khz * 1000ULL);
            }
            return false;
        }
    }
    if (!rfic_command_write_immed(BLADERF_RFIC_COMMAND_TXMUTE,
                                  BLADERF_CHANNEL_TX(0), 0)) {
        return false;
    }
#elif defined(BOARD_BLADERF_MICRO)
    (void)freq_hz;
    return false;
#else
    {
        struct lms_freq f;
        bool low;
        uint32_t cr;

        if (freq_hz > 0xFFFFFFFFULL) {
            return false;
        }
        if (legion_lms_fill((uint32_t)freq_hz, &f) != 0) {
            return false;
        }
        /* BLADERF_GPIO_LMS_TX_ENABLE = bit2 (bladeRF1.h). На время записи
         * PLL глушим аналог TX: иначе det_active ещё от старого LO, гейт
         * открыт, в усилитель уходят броски ФАПЧ. RX (bit1) не трогаем —
         * time tamer и детектор должны тикать. */
        cr = control_reg_read();
        control_reg_write(cr & ~0x4u);
        if (lms_set_precalculated_frequency(NULL, BLADERF_MODULE_RX, &f) != 0 ||
            lms_set_precalculated_frequency(NULL, BLADERF_MODULE_TX, &f) != 0) {
            control_reg_write(cr);
            return false;
        }
        low = (f.flags & LMS_FREQ_FLAGS_LOW_BAND) != 0;
        if (band_select(NULL, BLADERF_MODULE_RX, low) != 0 ||
            band_select(NULL, BLADERF_MODULE_TX, low) != 0) {
            control_reg_write(cr);
            return false;
        }
        control_reg_write(cr);
    }
#endif
    legion_air_freq_khz = freq_khz;
    return true;
}

static void legion_scan_mark_look(void)
{
    legion_quiet_t0 = time_tamer_read(BLADERF_MODULE_RX);
    legion_scan_look_set = true;
    legion_hold_armed = false;
    legion_hold_t0 = 0;
}

static bool legion_scan_go(uint32_t khz)
{
    if (khz == 0) {
        return false;
    }
    if (khz == legion_air_freq_khz) {
        legion_scan_mark_look();
        return true;
    }
    if (!legion_hop_lo(khz)) {
        return false;
    }
    legion_scan_mark_look();
    return true;
}

/* Шаг сетки только после удачного hop: иначе idx уехал, а LO остался —
 * следующие quiet/dwell крутили бы чужие стоянки. */
static void legion_scan_try_next(void)
{
    uint32_t const old_idx = legion_scan_idx;
    int const old_dir = legion_scan_dir;

    legion_scan_advance();
    if (legion_scan_go(legion_scan_center_khz(legion_scan_idx))) {
        return;
    }
    legion_scan_idx = old_idx;
    legion_scan_dir = old_dir;
}

static void legion_scan_walk(void)
{
    uint32_t const n = legion_scan_n();
    uint64_t now;
    uint64_t quiet;
    uint64_t dwell;
    uint32_t dwell_us;
    bool det;
    bool turn;

    if ((legion_scan_ctrl & LEGION_SCAN_CTRL_EN) == 0 || n == 0) {
        return;
    }

    if (!legion_scan_look_set) {
        if (legion_scan_idx >= n) {
            legion_scan_idx = 0;
        }
        (void)legion_scan_go(legion_scan_center_khz(legion_scan_idx));
        return;
    }

    if (n == 1) {
        /* Весь коридор в одном аналоговом окне — LO не шагаем.
         * Гейт I²+Q² работает в текущем взгляде (микросекунды). */
        return;
    }

    now = time_tamer_read(BLADERF_MODULE_RX);
    /* Tamer не идёт (нет тактов RX) → elapsed=0 → hop не срабатывает.
     * Гейт на текущем взгляде жив, если тракт поднят. */
    quiet = ((uint64_t)legion_fs_hz() * LEGION_SCAN_QUIET_MS) / 1000u;
    if (quiet == 0) {
        quiet = 1;
    }
    dwell_us = legion_scan_dwell_us ? legion_scan_dwell_us : LEGION_SCAN_DWELL_DEFAULT_US;
    /* fs·мкс / 1e6; 40e6·60e6 влезает в uint64. */
    dwell = ((uint64_t)legion_fs_hz() * (uint64_t)dwell_us) / 1000000u;
    if (dwell == 0) {
        dwell = 1;
    }
    det = (IORD_ALTERA_AVALON_PIO_DATA(LEGION_STATUS_BASE) &
           LEGION_STATUS_DET_ACTIVE) != 0;
    turn = (legion_scan_ctrl & LEGION_SCAN_CTRL_TURN) != 0;

    /* Выдержка TURN — от первого det в этом взгляде, не от входа в взгляд.
     * Иначе сигнал, появившийся позже dwell, сразу терялся бы без удержания
     * (пример оператора: нашёл 2450 → 0.4 мс на усилитель → дальше 2465). */
    if (det && !legion_hold_armed) {
        legion_hold_armed = true;
        legion_hold_t0 = now;
    }
    if (det) {
        legion_quiet_t0 = now;
    }

    if (turn && legion_hold_armed) {
        if (now - legion_hold_t0 >= dwell) {
            legion_scan_try_next();
        }
        return;
    }
    if (det) {
        /* PRIORITY: пока энергия — не шагаем. */
        return;
    }
    if (now - legion_quiet_t0 < quiet) {
        return;
    }
    legion_scan_try_next();
}

bool legion_reg_write(uint8_t addr, uint32_t data)
{
    if (addr > LEGION_REG_SCAN_DWELL_US) {
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

        case LEGION_REG_AIR_FS_HZ:
            legion_air_fs_hz = data;
            return true;

        case LEGION_REG_AIR_BW_HZ:
            legion_air_bw_hz = data;
            return true;

        case LEGION_REG_SCAN_F1_KHZ:
            legion_scan_f1_khz = data;
            legion_scan_reset();
            return true;

        case LEGION_REG_SCAN_F2_KHZ:
            legion_scan_f2_khz = data;
            legion_scan_reset();
            return true;

        case LEGION_REG_SCAN_CTRL:
            legion_scan_ctrl = data;
            legion_scan_reset();
            return true;

        case LEGION_REG_SCAN_DWELL_US:
            legion_scan_dwell_us = data;
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
            legion_armed = (data & 0x1) != 0;
            if ((data & 0x1) != 0) {
                /* Новый ARM — латч deadman прошлой сессии снять; обзор с первой стоянки */
                legion_wd_latch = false;
                legion_scan_reset();
            }
            if ((data & 0x1) == 0) {
                /* DISARM: цифру гасим сразу (mux нули), эфир — честно.
                 * STANDBY отказ → запись CTRL=0 уже ушла, write не ok. */
                legion_armed = false;
                IOWR_ALTERA_AVALON_PIO_DATA(LEGION_WDATA_BASE, data);
                IOWR_ALTERA_AVALON_PIO_DATA(LEGION_AWS_BASE, 0x80 | addr);
                IOWR_ALTERA_AVALON_PIO_DATA(LEGION_AWS_BASE, 0x00);
                if (!legion_air_down()) {
                    return false;
                }
                return true;
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
    if (addr == LEGION_REG_AIR_FREQ_KHZ) {
        *data = legion_air_freq_khz;
        return true;
    }
    if (addr == LEGION_REG_AIR_FS_HZ) {
        *data = legion_air_fs_hz;
        return true;
    }
    if (addr == LEGION_REG_AIR_BW_HZ) {
        *data = legion_air_bw_hz;
        return true;
    }
    if (addr == LEGION_REG_SCAN_F1_KHZ) {
        *data = legion_scan_f1_khz;
        return true;
    }
    if (addr == LEGION_REG_SCAN_F2_KHZ) {
        *data = legion_scan_f2_khz;
        return true;
    }
    if (addr == LEGION_REG_SCAN_CTRL) {
        *data = legion_scan_ctrl;
        return true;
    }
    if (addr == LEGION_REG_SCAN_DWELL_US) {
        *data = legion_scan_dwell_us;
        return true;
    }
    *data = IORD_ALTERA_AVALON_PIO_DATA(LEGION_STATUS_BASE);
    /* Бит 4 — не из HDL (там 7..4 = 0): липкий латч NIOS «deadman сработал»,
     * иначе wd_fired после автономного DISARM — микросекундный пульс. */
    if (legion_wd_latch) {
        *data |= LEGION_STATUS_WD_LATCH;
    }
    return true;
}

void legion_work(void)
{
    /* Deadman без хоста: watchdog в FPGA сработал (heartbeat пропал), а ARM
     * жив → сам DISARM. Цифру mux уже заглушил (нули с каденсом); здесь
     * гасим остальное: CTRL=0 снимает ARM (expired липкий — без этого
     * следующий ARM молчал бы навсегда), на micro тот же CTRL=0 уводит
     * RFIC в standby (case LEGION_REG_CTRL выше), на x40 снимаем
     * lms_rx_enable|lms_tx_enable в CONTROL (NIOS — хозяин этого PIO,
     * devices_inline.h; шлюз ходит в него через NIOS-пакеты target 0x01).
     * USB NIOS не отпускает — он не хозяин линка; release делает шлюз
     * (сторож по kick_age), а при живом ноутбуке — приложение. */
    if (!legion_armed) {
        return;
    }
    if ((IORD_ALTERA_AVALON_PIO_DATA(LEGION_STATUS_BASE) &
         LEGION_STATUS_WD_FIRED) != 0) {
        DBG("LEGION: wd_fired при живом ARM — автономный DISARM\n");
        legion_wd_latch = true;
        legion_reg_write(LEGION_REG_CTRL, 0);
#if !defined(BOARD_BLADERF_MICRO)
        control_reg_write(control_reg_read() & ~0x6u);
#endif
        return;
    }
    legion_scan_walk();
}
