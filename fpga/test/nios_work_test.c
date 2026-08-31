/* ============================================================================
 * LEGION — поведенческий тест NIOS-логики на ПК (без железа, без Quartus).
 *
 * Гоняется против МАСТЕРА fpga/nios/legion_cmds.c в двух конфигах
 * (x40 и micro+RFIC) с записывающим PIO-стабом (nios_work_stubs/ первым
 * в -I) и журналируемыми RFIC-стабами (сигнатуры проверяются компилятором
 * против реального devices_rfic.h — не выдуманы).
 *
 * Покрывает:
 *   A1: legion_work() — wd_fired при живом ARM → автономный DISARM:
 *       CTRL=0 в HDL + (micro: RFIC STANDBY через air_down / x40: снятие
 *       lms_rx_enable|lms_tx_enable в CONTROL RMW). Однократно.
 *       Без ARM или без wd_fired — ничего не делает.
 *   B2: AIR_PREP с readback GAINMODE ≠ MGC → отказ подъёма эфира.
 *   B3: порядок AIR_PREP: TXMUTE(1) раньше любой записи TX FREQUENCY,
 *       TXMUTE(0) после ENABLE TX.
 *   SCAN: walker при SCAN_CTRL.enable — hop по quiet (tamer) / dwell (turn);
 *         tamer стоит → hop нет; wd_fired важнее walker.
 * =========================================================================*/
#include <stdio.h>
#include <stdint.h>
#include <stdbool.h>
#include <string.h>

#include "system.h"        /* nios_stubs: BASE-адреса */
#include "devices.h"       /* BLADERF_NIOS_LIBAD936X по RAM_SPAN — как в legion_cmds.c */
#include "legion_cmds.h"

#if defined(BOARD_BLADERF_MICRO) && defined(BLADERF_NIOS_LIBAD936X)
#include "devices_rfic.h"  /* реальные прототипы rfic_command_* — стабы ниже
                            * проверяются компилятором на совпадение */
#define HAVE_RFIC 1
#endif

/* ---------------- Журнал PIO ---------------- */
static struct { uint32_t base, data; } pio_log[512];
static int pio_n;
static uint32_t t_status;    /* STATUS-PIO (бит 3 = wd_fired) */
static uint32_t t_control;   /* CONTROL-PIO Nuand (x40: бит1 rx, бит2 tx) */
static uint64_t t_tamer;     /* RX time tamer (сэмплы) */

uint64_t time_tamer_read(bladerf_module m)
{
    (void)m;
    return t_tamer;
}

#if !defined(HAVE_RFIC)
struct bladerf;
struct lms_freq;
static int lms_n;
static int band_n;

int lms_set_precalculated_frequency(struct bladerf *dev, bladerf_module mod,
                                    struct lms_freq *f)
{
    (void)dev; (void)mod; (void)f;
    lms_n++;
    return 0;
}

int band_select(struct bladerf *dev, bladerf_module module, bool low_band)
{
    (void)dev; (void)module; (void)low_band;
    band_n++;
    return 0;
}
#endif

uint32_t t_pio_read(uint32_t base)
{
    if (base == (uint32_t)LEGION_STATUS_BASE) return t_status;
    if (base == (uint32_t)CONTROL_BASE) return t_control;
    return 0;
}

void t_pio_write(uint32_t base, uint32_t data)
{
    if (pio_n < (int)(sizeof(pio_log) / sizeof(pio_log[0]))) {
        pio_log[pio_n].base = base;
        pio_log[pio_n].data = data;
        pio_n++;
    }
    if (base == (uint32_t)CONTROL_BASE) t_control = data;
}

/* Ищем последовательность записи регистра LEGION: WDATA=data, AWS=0x80|addr */
static bool pio_wrote_reg(uint8_t addr, uint32_t data)
{
    for (int i = 0; i + 1 < pio_n; i++) {
        if (pio_log[i].base == (uint32_t)LEGION_WDATA_BASE &&
            pio_log[i].data == data &&
            pio_log[i + 1].base == (uint32_t)LEGION_AWS_BASE &&
            pio_log[i + 1].data == (0x80u | addr)) {
            return true;
        }
    }
    return false;
}

/* ---------------- Журнал RFIC (micro) ---------------- */
#ifdef HAVE_RFIC
static struct { uint8_t cmd, ch; uint64_t data; } rfic_log[512];
static int rfic_n;
static bool rfic_read_ok = true;
static uint64_t rfic_read_value;

bool rfic_command_write_immed(bladerf_rfic_command cmd, bladerf_channel ch,
                              uint64_t data)
{
    if (rfic_n < (int)(sizeof(rfic_log) / sizeof(rfic_log[0]))) {
        rfic_log[rfic_n].cmd = (uint8_t)cmd;
        rfic_log[rfic_n].ch = (uint8_t)ch;
        rfic_log[rfic_n].data = data;
        rfic_n++;
    }
    return true;
}

bool rfic_command_read_immed(bladerf_rfic_command cmd, bladerf_channel ch,
                             uint64_t *data)
{
    (void)cmd; (void)ch;
    *data = rfic_read_value;
    return rfic_read_ok;
}

/* Индекс первого вызова cmd на канале ch с data==want (−1 = не было) */
static int rfic_idx(uint8_t cmd, uint8_t ch, uint64_t want)
{
    for (int i = 0; i < rfic_n; i++) {
        if (rfic_log[i].cmd == cmd && rfic_log[i].ch == ch &&
            rfic_log[i].data == want) {
            return i;
        }
    }
    return -1;
}
#endif /* HAVE_RFIC */

/* ---------------- Мини-раннер ---------------- */
static int fails;
#define CHECK(name, cond) do { \
    printf("  %s  %s\n", (cond) ? "PASS" : "FAIL", name); \
    if (!(cond)) fails++; \
} while (0)

#define CTRL_ARM_WD_PLAYER (0x1u | (LEGION_MODE_PLAYER << 1) | (1u << 4))
#define CTRL_ARM_WD_LBG    (0x1u | (LEGION_MODE_LB_GATED << 1) | (1u << 4))

int main(void)
{
#ifdef HAVE_RFIC
    printf("== конфиг: micro + RFIC (AD9361) ==\n");

    /* --- B3/B2: AIR_PREP up — порядок и readback --- */
    rfic_read_value = BLADERF_GAIN_MGC;
    legion_reg_write(LEGION_REG_AIR_FREQ_KHZ, 2442500);
    legion_reg_write(LEGION_REG_AIR_GAIN_DB, 42 + 1000);
    CHECK("AIR_PREP up ok", legion_reg_write(LEGION_REG_AIR_PREP, 0x7));

    int i_init  = rfic_idx(BLADERF_RFIC_COMMAND_INIT, RFIC_SYSTEM_CHANNEL,
                           BLADERF_RFIC_INIT_STATE_ON);
    int i_mute  = rfic_idx(BLADERF_RFIC_COMMAND_TXMUTE, BLADERF_CHANNEL_TX(0), 1);
    int i_txfrq = rfic_idx(BLADERF_RFIC_COMMAND_FREQUENCY, BLADERF_CHANNEL_TX(0),
                           2442500ULL * 1000ULL);
    int i_txen  = rfic_idx(BLADERF_RFIC_COMMAND_ENABLE, BLADERF_CHANNEL_TX(0), 1);
    int i_unmut = rfic_idx(BLADERF_RFIC_COMMAND_TXMUTE, BLADERF_CHANNEL_TX(0), 0);
    CHECK("B3: INIT ON есть", i_init >= 0);
    CHECK("B3: TXMUTE(1) после INIT и раньше TX FREQUENCY",
          i_mute > i_init && i_txfrq > i_mute);
    CHECK("B3: TXMUTE(0) после ENABLE TX (unmute последним)",
          i_unmut > i_txen && i_txen > i_txfrq);

    /* --- B2: readback GAINMODE ≠ MGC → подъём отказывает --- */
    legion_reg_write(LEGION_REG_AIR_PREP, 0x0);  /* down */
    rfic_read_value = BLADERF_GAIN_HYBRID_AGC;
    CHECK("B2: AIR_PREP с AGC на readback → отказ",
          !legion_reg_write(LEGION_REG_AIR_PREP, 0x7));
    rfic_read_value = BLADERF_GAIN_MGC;
    CHECK("AIR_PREP снова ok после MGC", legion_reg_write(LEGION_REG_AIR_PREP, 0x7));

    /* --- A1: deadman --- */
    CHECK("ARM lb_gated при поднятом эфире", legion_reg_write(LEGION_REG_CTRL, CTRL_ARM_WD_LBG));
    int pio_mark = pio_n, rfic_mark = rfic_n;
    t_status = 0;
    legion_work();
    CHECK("A1: wd жив → legion_work ничего не пишет",
          pio_n == pio_mark && rfic_n == rfic_mark);

    t_status = LEGION_STATUS_WD_FIRED;
    legion_work();
    CHECK("A1: wd_fired → CTRL=0 записан в HDL",
          pio_wrote_reg(LEGION_REG_CTRL, 0));
    CHECK("A1: wd_fired → RFIC в STANDBY (air_down из CTRL=0)",
          rfic_idx(BLADERF_RFIC_COMMAND_INIT, RFIC_SYSTEM_CHANNEL,
                   BLADERF_RFIC_INIT_STATE_STANDBY) >= 0);
    CHECK("A1: micro НЕ трогает CONTROL PIO (не наш регистр)",
          t_control == 0);
    /* HDL-бит wd_fired после CTRL=0 гаснет за мкс (enable=0 сбрасывает
     * expired, legion_watchdog.vhd) — хост читает липкий латч NIOS (bit4). */
    t_status = 0;  /* HDL expired сброшен */
    uint32_t st = 0;
    legion_reg_read(0, &st);
    CHECK("A1: латч deadman виден в STATUS (bit4) после сброса HDL-бита",
          (st & LEGION_STATUS_WD_LATCH) != 0);
    pio_mark = pio_n; rfic_mark = rfic_n;
    legion_work();
    CHECK("A1: повторный legion_work — однократность",
          pio_n == pio_mark && rfic_n == rfic_mark);

    /* ARM lb_* без эфира — существующий guard не сломан */
    CHECK("ARM lb_gated без эфира → отказ (guard цел)",
          !legion_reg_write(LEGION_REG_CTRL, CTRL_ARM_WD_LBG));
    /* Изоляция guard'а: отклонённый ARM не должен взвести legion_armed —
     * иначе wd_fired сейчас вызвал бы DISARM (найдено перепроверкой,
     * раунд 6: без этого шага баг маскировался бы последующим re-ARM). */
    pio_mark = pio_n; rfic_mark = rfic_n;
    t_status = LEGION_STATUS_WD_FIRED;
    legion_work();
    CHECK("A1: отклонённый guard'ом ARM + wd_fired → legion_work молчит",
          pio_n == pio_mark && rfic_n == rfic_mark);
    t_status = 0;

    /* re-ARM (с эфиром) снимает латч */
    legion_reg_write(LEGION_REG_AIR_PREP, 0x7);
    CHECK("re-ARM после deadman принимается",
          legion_reg_write(LEGION_REG_CTRL, CTRL_ARM_WD_LBG));
    legion_reg_read(0, &st);
    CHECK("A1: re-ARM снял латч (bit4 чист)", (st & LEGION_STATUS_WD_LATCH) == 0);
    legion_reg_write(LEGION_REG_CTRL, 0);

    /* wd_fired без ARM — ничего */
    pio_mark = pio_n; rfic_mark = rfic_n;
    t_status = LEGION_STATUS_WD_FIRED;
    legion_work();
    CHECK("A1: wd_fired без ARM → ничего", pio_n == pio_mark && rfic_n == rfic_mark);

    /* --- Онбордовый обзор: USB не в круге увидел→TX --- */
    rfic_n = 0;
    legion_reg_write(LEGION_REG_AIR_FREQ_KHZ, 2414000); /* центр 0 при look 28 МГц */
    legion_reg_write(LEGION_REG_AIR_FS_HZ, 28000000);
    legion_reg_write(LEGION_REG_AIR_BW_HZ, 28000000);
    legion_reg_write(LEGION_REG_SCAN_F1_KHZ, 2400000);
    legion_reg_write(LEGION_REG_SCAN_F2_KHZ, 2500000);
    legion_reg_write(LEGION_REG_SCAN_DWELL_MS, 10);
    legion_reg_write(LEGION_REG_SCAN_CTRL, LEGION_SCAN_CTRL_EN); /* priority */
    CHECK("SCAN: AIR_PREP перед ARM", legion_reg_write(LEGION_REG_AIR_PREP, 0x7));
    CHECK("SCAN: ARM lb_gated", legion_reg_write(LEGION_REG_CTRL, CTRL_ARM_WD_LBG));
    t_status = 0;
    t_tamer = 1000;
    rfic_n = 0;
    legion_work(); /* стоянка 0 уже на LO — hop нет */
    CHECK("SCAN: первая стоянка без hop FREQUENCY",
          rfic_idx(BLADERF_RFIC_COMMAND_FREQUENCY, BLADERF_CHANNEL_RX(0),
                   2442000ULL * 1000ULL) < 0);
    t_tamer += 140001; /* 5 мс @ 28 MSPS */
    legion_work();
    CHECK("SCAN: тишина → hop на центр 1 (2442 МГц)",
          rfic_idx(BLADERF_RFIC_COMMAND_FREQUENCY, BLADERF_CHANNEL_RX(0),
                   2442000ULL * 1000ULL) >= 0);
    {
        uint32_t khz = 0;
        legion_reg_read(LEGION_REG_AIR_FREQ_KHZ, &khz);
        CHECK("SCAN: readback AIR_FREQ после hop", khz == 2442000);
    }
    rfic_n = 0;
    t_status = LEGION_STATUS_DET_ACTIVE;
    t_tamer += 10000000;
    legion_work();
    CHECK("SCAN: PRIORITY + энергия → LO не шагает", rfic_n == 0);
    t_status = 0;
    t_tamer += 100; /* меньше quiet */
    rfic_n = 0;
    legion_work();
    CHECK("SCAN: после спада энергии quiet не истёк → нет hop", rfic_n == 0);
    t_tamer += 140001;
    legion_work();
    CHECK("SCAN: quiet истёк → hop дальше", rfic_n > 0);

    /* tamer стоит — обзор не шагает, гейт мог бы жить на текущем взгляде */
    legion_reg_write(LEGION_REG_SCAN_CTRL, LEGION_SCAN_CTRL_EN);
    legion_reg_write(LEGION_REG_CTRL, CTRL_ARM_WD_LBG);
    t_status = 0;
    t_tamer = 50;
    legion_work(); /* якорь */
    rfic_n = 0;
    for (int k = 0; k < 20; k++) legion_work();
    CHECK("SCAN: tamer стоит → hop нет", rfic_n == 0);

    /* TURN: hop по выдержке даже при энергии */
    legion_reg_write(LEGION_REG_SCAN_CTRL,
                     LEGION_SCAN_CTRL_EN | LEGION_SCAN_CTRL_TURN);
    CHECK("SCAN TURN: ARM", legion_reg_write(LEGION_REG_CTRL, CTRL_ARM_WD_LBG));
    t_status = LEGION_STATUS_DET_ACTIVE;
    t_tamer = 0;
    legion_work();
    rfic_n = 0;
    t_tamer += (uint64_t)28000000 * 10 / 1000 + 1; /* dwell 10 мс */
    legion_work();
    CHECK("SCAN: TURN + энергия + dwell → hop", rfic_n > 0);

    /* deadman по-прежнему важнее walker */
    t_status = LEGION_STATUS_WD_FIRED;
    pio_n = 0; rfic_n = 0;
    legion_work();
    CHECK("SCAN: wd_fired → DISARM, не hop",
          pio_wrote_reg(LEGION_REG_CTRL, 0));
    legion_reg_write(LEGION_REG_SCAN_CTRL, 0);
    legion_reg_write(LEGION_REG_CTRL, 0);
#else
    printf("== конфиг: x40 (LMS6002D, CONTROL со шлюза) ==\n");

    /* wd_fired без ARM — ничего */
    t_status = LEGION_STATUS_WD_FIRED;
    legion_work();
    CHECK("A1: wd_fired без ARM → ничего", pio_n == 0);

    /* ARM player + шлюз «включил» аналог: CONTROL bit1|bit2 */
    CHECK("ARM player", legion_reg_write(LEGION_REG_CTRL, CTRL_ARM_WD_PLAYER));
    t_control = 0x6;
    int mark = pio_n;
    t_status = 0;
    legion_work();
    CHECK("A1: wd жив → legion_work ничего не пишет", pio_n == mark);

    t_status = LEGION_STATUS_WD_FIRED;
    legion_work();
    CHECK("A1: wd_fired → CTRL=0 записан в HDL",
          pio_wrote_reg(LEGION_REG_CTRL, 0));
    CHECK("A1: wd_fired → CONTROL lms_rx/tx_enable сняты (RMW)",
          t_control == 0);
    /* HDL-бит гаснет за мкс после CTRL=0 — хост читает латч NIOS (bit4) */
    t_status = 0;
    uint32_t st = 0;
    legion_reg_read(0, &st);
    CHECK("A1: латч deadman виден в STATUS (bit4) после сброса HDL-бита",
          (st & LEGION_STATUS_WD_LATCH) != 0);
    mark = pio_n;
    legion_work();
    CHECK("A1: повторный legion_work — однократность", pio_n == mark);

    /* re-ARM после автономного DISARM принимается (expired снят enable=0 в HDL)
     * и снимает латч */
    CHECK("re-ARM после deadman принимается",
          legion_reg_write(LEGION_REG_CTRL, CTRL_ARM_WD_PLAYER));
    legion_reg_read(0, &st);
    CHECK("A1: re-ARM снял латч (bit4 чист)", (st & LEGION_STATUS_WD_LATCH) == 0);

    /* Онбордовый обзор x40: hop = lms_set_precalculated + band_select, CONTROL жив */
    legion_reg_write(LEGION_REG_AIR_FREQ_KHZ, 2414000);
    legion_reg_write(LEGION_REG_AIR_FS_HZ, 28000000);
    legion_reg_write(LEGION_REG_AIR_BW_HZ, 28000000);
    legion_reg_write(LEGION_REG_SCAN_F1_KHZ, 2400000);
    legion_reg_write(LEGION_REG_SCAN_F2_KHZ, 2500000);
    legion_reg_write(LEGION_REG_SCAN_CTRL, LEGION_SCAN_CTRL_EN);
    t_control = 0x6;
    CHECK("SCAN x40: ARM", legion_reg_write(LEGION_REG_CTRL, CTRL_ARM_WD_LBG));
    t_status = 0;
    t_tamer = 1000;
    lms_n = 0; band_n = 0;
    legion_work(); /* стоянка 0 уже на LO */
    CHECK("SCAN x40: первая стоянка без LMS hop", lms_n == 0 && band_n == 0);
    t_tamer += 140001;
    legion_work();
    CHECK("SCAN x40: тишина → lms RX+TX (2) и band_select RX+TX (2)",
          lms_n == 2 && band_n == 2);
    CHECK("SCAN x40: CONTROL lms_rx/tx_enable живы", t_control == 0x6);
    {
        uint32_t khz = 0;
        legion_reg_read(LEGION_REG_AIR_FREQ_KHZ, &khz);
        CHECK("SCAN x40: AIR_FREQ после hop", khz == 2442000);
    }
    lms_n = 0; band_n = 0;
    t_tamer = 50;
    legion_reg_write(LEGION_REG_SCAN_CTRL, LEGION_SCAN_CTRL_EN);
    legion_reg_write(LEGION_REG_CTRL, CTRL_ARM_WD_LBG);
    legion_work();
    lms_n = 0; band_n = 0;
    for (int k = 0; k < 20; k++) legion_work();
    CHECK("SCAN x40: tamer стоит → hop нет", lms_n == 0 && band_n == 0);
    legion_reg_write(LEGION_REG_SCAN_CTRL, 0);
    legion_reg_write(LEGION_REG_CTRL, 0);
#endif

    printf(fails ? "NIOS WORK: %d FAILURES\n" : "NIOS WORK: ALL PASS\n", fails);
    return fails ? 1 : 0;
}
