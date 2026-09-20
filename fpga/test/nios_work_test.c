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
 *   SCAN: walker при SCAN_CTRL.enable — hop по quiet (tamer) / dwell от
 *         первого det (turn, мкс); tamer стоит → hop нет; wd_fired важнее walker.
 *   FFT+TURN: FIRE без hop PLL (цифровой вырез, AIR=центр взгляда, PEAK=~2444);
 *             выдержка SCAN_DWELL_US, затем следующий взгляд 2484.
 *   FFT+PARK: 2400–2487 → один центр 2443.5; dwell+энергия не гоняет PLL.
 *   FFT+SURVEY: 2000–3000 глухой 18 клеток; пик 2434 → LO 2434;
 *             SCAN_SURVEY_US → снова 2028. События: PASS / STARE / LOCK /
 *             SWITCH / RESURVEY (один код на work — иначе хост теряет).
 *             Внутри окна: обычный держит выдержку; приоритет тоже держит
 *             и на сильнее перескакивает с новой выдержкой.
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
static uint32_t t_aws;       /* последний AWS: mux 0x15 → peak, не STATUS */
static uint32_t t_peak_word; /* слово пика HDL: valid/frame/mag/bin */

static uint32_t mk_peak(int valid, unsigned frame, unsigned mag_hi, unsigned bin)
{
    return ((valid ? 0x80000000u : 0u) |
            ((frame & 0x7fu) << 24) |
            ((mag_hi & 0xffffu) << 8) |
            (bin & 0xffu));
}

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
static bool lms_tx_off_during_set;
static bool lms_fail_tx;

int lms_set_precalculated_frequency(struct bladerf *dev, bladerf_module mod,
                                    struct lms_freq *f)
{
    (void)dev; (void)f;
    if ((t_control & 0x4u) == 0) lms_tx_off_during_set = true;
    lms_n++;
    if (lms_fail_tx && mod == BLADERF_MODULE_TX) {
        return -1;
    }
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
    if (base == (uint32_t)LEGION_STATUS_BASE) {
        if ((t_aws & 0x7Fu) == LEGION_REG_PEAK_BIN && (t_aws & 0x80u) == 0) {
            return t_peak_word;
        }
        return t_status;
    }
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
    if (base == (uint32_t)LEGION_AWS_BASE) t_aws = data;
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
static uint64_t rfic_read_value; /* GAINMODE, если нет теневой записи */
static uint64_t rfic_shadow[16][4]; /* cmd × канал 0..3 */
static bool rfic_shadow_set[16][4];
static uint64_t rfic_read_override[16];
static bool rfic_read_override_set[16];
static bool rfic_fail_enable_tx;
static bool rfic_fail_tx_freq;
static bool rfic_fail_rx_freq;
static bool rfic_fail_standby;
static bool rfic_fail_filter;

static int rfic_ch_slot(bladerf_channel ch)
{
    if (ch == BLADERF_CHANNEL_RX(0)) return 0;
    if (ch == BLADERF_CHANNEL_TX(0)) return 1;
    if (ch == BLADERF_CHANNEL_RX(1)) return 2;
    if (ch == BLADERF_CHANNEL_TX(1)) return 3;
    return 0;
}

bool rfic_command_write_immed(bladerf_rfic_command cmd, bladerf_channel ch,
                              uint64_t data)
{
    if (rfic_n < (int)(sizeof(rfic_log) / sizeof(rfic_log[0]))) {
        rfic_log[rfic_n].cmd = (uint8_t)cmd;
        rfic_log[rfic_n].ch = (uint8_t)ch;
        rfic_log[rfic_n].data = data;
        rfic_n++;
    }
    if (rfic_fail_standby && cmd == BLADERF_RFIC_COMMAND_INIT &&
        data == BLADERF_RFIC_INIT_STATE_STANDBY) {
        return false;
    }
    if (rfic_fail_enable_tx && cmd == BLADERF_RFIC_COMMAND_ENABLE &&
        ch == BLADERF_CHANNEL_TX(0) && data == 1) {
        return false;
    }
    if (rfic_fail_tx_freq && cmd == BLADERF_RFIC_COMMAND_FREQUENCY &&
        ch == BLADERF_CHANNEL_TX(0)) {
        return false;
    }
    if (rfic_fail_rx_freq && cmd == BLADERF_RFIC_COMMAND_FREQUENCY &&
        ch == BLADERF_CHANNEL_RX(0)) {
        return false;
    }
    if (rfic_fail_filter && cmd == BLADERF_RFIC_COMMAND_FILTER) {
        return false;
    }
    if ((unsigned)cmd < 16) {
        int const slot = rfic_ch_slot(ch);
        rfic_shadow[cmd][slot] = data;
        rfic_shadow_set[cmd][slot] = true;
    }
    return true;
}

bool rfic_command_read_immed(bladerf_rfic_command cmd, bladerf_channel ch,
                             uint64_t *data)
{
    if (!rfic_read_ok) {
        *data = 0;
        return false;
    }
    if ((unsigned)cmd < 16 && rfic_read_override_set[cmd]) {
        *data = rfic_read_override[cmd];
        return true;
    }
    if (cmd == BLADERF_RFIC_COMMAND_GAINMODE) {
        *data = rfic_read_value;
        return true;
    }
    if ((unsigned)cmd < 16) {
        int const slot = rfic_ch_slot(ch);
        if (rfic_shadow_set[cmd][slot]) {
            *data = rfic_shadow[cmd][slot];
            return true;
        }
    }
    *data = rfic_read_value;
    return true;
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
    legion_reg_write(LEGION_REG_SCAN_DWELL_US, 10000);
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

    /* TURN: выдержка от первого det, не от входа во взгляд.
     * Сигнал позже dwell-с-входа всё равно держится dwell, потом hop. */
    legion_reg_write(LEGION_REG_SCAN_CTRL,
                     LEGION_SCAN_CTRL_EN | LEGION_SCAN_CTRL_TURN);
    CHECK("SCAN TURN: ARM", legion_reg_write(LEGION_REG_CTRL, CTRL_ARM_WD_LBG));
    t_status = 0;
    t_tamer = 0;
    legion_work(); /* якорь взгляда, энергии нет */
    rfic_n = 0;
    t_tamer += (uint64_t)28000000 * 2 / 1000; /* 2 мс < quiet 5 мс */
    legion_work();
    CHECK("SCAN: TURN пустой взгляд раньше quiet → hop нет", rfic_n == 0);
    t_status = LEGION_STATUS_DET_ACTIVE;
    t_tamer += 1;
    legion_work(); /* первый det — якорь выдержки */
    rfic_n = 0;
    t_tamer += (uint64_t)28000000 * 400 / 1000000; /* 400 мкс, ещё не dwell 10 мс */
    legion_work();
    CHECK("SCAN: TURN + энергия, выдержка не истекла → hop нет", rfic_n == 0);
    t_tamer += (uint64_t)28000000 * 10 / 1000 + 1; /* 10 мс dwell */
    legion_work();
    CHECK("SCAN: TURN + энергия + dwell от детекта → hop", rfic_n > 0);

    /* 0.4 мс оператора: 400 мкс @ 28 MSPS */
    legion_reg_write(LEGION_REG_SCAN_DWELL_US, 400);
    legion_reg_write(LEGION_REG_SCAN_CTRL,
                     LEGION_SCAN_CTRL_EN | LEGION_SCAN_CTRL_TURN);
    CHECK("SCAN TURN 0.4мс: ARM", legion_reg_write(LEGION_REG_CTRL, CTRL_ARM_WD_LBG));
    t_status = 0;
    t_tamer = 0;
    legion_work();
    t_status = LEGION_STATUS_DET_ACTIVE;
    t_tamer += 1;
    legion_work();
    rfic_n = 0;
    t_tamer += (uint64_t)28000000 * 400 / 1000000 + 1;
    legion_work();
    CHECK("SCAN: TURN 400 мкс от детекта → hop", rfic_n > 0);

    /* deadman по-прежнему важнее walker */
    t_status = LEGION_STATUS_WD_FIRED;
    pio_n = 0; rfic_n = 0;
    legion_work();
    CHECK("SCAN: wd_fired → DISARM, не hop",
          pio_wrote_reg(LEGION_REG_CTRL, 0));
    legion_reg_write(LEGION_REG_SCAN_CTRL, 0);
    legion_reg_write(LEGION_REG_CTRL, 0);

    /* --- U5: чтение SCAN_* = последние записи, не STATUS --- */
    legion_reg_write(LEGION_REG_SCAN_F1_KHZ, 2445000);
    legion_reg_write(LEGION_REG_SCAN_F2_KHZ, 2455000);
    legion_reg_write(LEGION_REG_SCAN_DWELL_US, 400);
    legion_reg_write(LEGION_REG_SCAN_CTRL, LEGION_SCAN_CTRL_EN | LEGION_SCAN_CTRL_TURN);
    t_status = 0x00A50004u;
    {
        uint32_t v = 0;
        legion_reg_read(LEGION_REG_SCAN_F1_KHZ, &v);
        CHECK("U5: SCAN_F1 readback", v == 2445000);
        legion_reg_read(LEGION_REG_SCAN_F2_KHZ, &v);
        CHECK("U5: SCAN_F2 readback", v == 2455000);
        legion_reg_read(LEGION_REG_SCAN_DWELL_US, &v);
        CHECK("U5: SCAN_DWELL readback 400", v == 400);
        legion_reg_read(LEGION_REG_SCAN_CTRL, &v);
        CHECK("U5: SCAN_CTRL readback",
              v == (LEGION_SCAN_CTRL_EN | LEGION_SCAN_CTRL_TURN));
        legion_reg_read(0, &v);
        CHECK("U5: addr 0 по-прежнему STATUS", (v & 0x4u) != 0);
    }

    /* --- R1/R5: FILTER 4x до SAMPLERATE на 2e6 и 520834 --- */
    rfic_n = 0;
    rfic_read_value = BLADERF_GAIN_MGC;
    legion_reg_write(LEGION_REG_AIR_FREQ_KHZ, 2450000);
    legion_reg_write(LEGION_REG_AIR_FS_HZ, 2000000);
    legion_reg_write(LEGION_REG_AIR_BW_HZ, 2000000);
    CHECK("R5: AIR 2e6 ok", legion_reg_write(LEGION_REG_AIR_PREP, 0x7));
    {
        int i_frx = rfic_idx(BLADERF_RFIC_COMMAND_FILTER, BLADERF_CHANNEL_RX(0),
                             BLADERF_RFIC_RXFIR_DEC4);
        int i_ftx = rfic_idx(BLADERF_RFIC_COMMAND_FILTER, BLADERF_CHANNEL_TX(0),
                             BLADERF_RFIC_TXFIR_INT4);
        int i_srx = rfic_idx(BLADERF_RFIC_COMMAND_SAMPLERATE, BLADERF_CHANNEL_RX(0),
                             2000000);
        int i_stx = rfic_idx(BLADERF_RFIC_COMMAND_SAMPLERATE, BLADERF_CHANNEL_TX(0),
                             2000000);
        CHECK("R1/R5: FILTER RX DEC4 до SAMPLERATE RX @ 2e6",
              i_frx >= 0 && i_srx > i_frx);
        CHECK("R1/R5: FILTER TX INT4 до SAMPLERATE TX @ 2e6",
              i_ftx >= 0 && i_stx > i_ftx);
    }
    legion_reg_write(LEGION_REG_AIR_PREP, 0);

    rfic_n = 0;
    legion_reg_write(LEGION_REG_AIR_FS_HZ, 520834);
    legion_reg_write(LEGION_REG_AIR_BW_HZ, 200000);
    CHECK("R1: AIR 520834 ok", legion_reg_write(LEGION_REG_AIR_PREP, 0x7));
    {
        int i_frx = rfic_idx(BLADERF_RFIC_COMMAND_FILTER, BLADERF_CHANNEL_RX(0),
                             BLADERF_RFIC_RXFIR_DEC4);
        int i_srx = rfic_idx(BLADERF_RFIC_COMMAND_SAMPLERATE, BLADERF_CHANNEL_RX(0),
                             520834);
        CHECK("R1: FILTER DEC4 до SAMPLERATE @ 520834",
              i_frx >= 0 && i_srx > i_frx);
    }
    legion_reg_write(LEGION_REG_AIR_PREP, 0);

    rfic_n = 0;
    legion_reg_write(LEGION_REG_AIR_FS_HZ, 10000000);
    legion_reg_write(LEGION_REG_AIR_BW_HZ, 10000000);
    CHECK("R1: AIR 10e6 ok (вне 4x)", legion_reg_write(LEGION_REG_AIR_PREP, 0x7));
    {
        int i_frx = rfic_idx(BLADERF_RFIC_COMMAND_FILTER, BLADERF_CHANNEL_RX(0),
                             BLADERF_RFIC_RXFIR_DEFAULT);
        int i_ftx = rfic_idx(BLADERF_RFIC_COMMAND_FILTER, BLADERF_CHANNEL_TX(0),
                             BLADERF_RFIC_TXFIR_DEFAULT);
        int i_srx = rfic_idx(BLADERF_RFIC_COMMAND_SAMPLERATE, BLADERF_CHANNEL_RX(0),
                             10000000);
        int i_stx = rfic_idx(BLADERF_RFIC_COMMAND_SAMPLERATE, BLADERF_CHANNEL_TX(0),
                             10000000);
        CHECK("R1: 10e6 FILTER RX default после SAMPLERATE (Nuand leave-4x)",
              i_frx >= 0 && i_srx >= 0 && i_frx > i_srx);
        CHECK("R1: 10e6 FILTER TX default после SAMPLERATE",
              i_ftx >= 0 && i_stx >= 0 && i_ftx > i_stx);
    }
    /* leftover DEC4 @ 0.2 → 10e6: rate сначала, затем default (стенд E). */
    rfic_n = 0;
    legion_reg_write(LEGION_REG_AIR_FS_HZ, 520834);
    legion_reg_write(LEGION_REG_AIR_BW_HZ, 200000);
    CHECK("R1: leftover 0.2 AIR", legion_reg_write(LEGION_REG_AIR_PREP, 0x7));
    legion_reg_write(LEGION_REG_AIR_PREP, 0);
    rfic_n = 0;
    legion_reg_write(LEGION_REG_AIR_FS_HZ, 10000000);
    legion_reg_write(LEGION_REG_AIR_BW_HZ, 10000000);
    CHECK("R1: 0.2→10e6 AIR ok", legion_reg_write(LEGION_REG_AIR_PREP, 0x7));
    {
        int i_frx = rfic_idx(BLADERF_RFIC_COMMAND_FILTER, BLADERF_CHANNEL_RX(0),
                             BLADERF_RFIC_RXFIR_DEFAULT);
        int i_srx = rfic_idx(BLADERF_RFIC_COMMAND_SAMPLERATE, BLADERF_CHANNEL_RX(0),
                             10000000);
        int i_dec4 = rfic_idx(BLADERF_RFIC_COMMAND_FILTER, BLADERF_CHANNEL_RX(0),
                              BLADERF_RFIC_RXFIR_DEC4);
        CHECK("R1: 0.2→10e6 SAMPLERATE до FILTER default",
              i_frx >= 0 && i_srx >= 0 && i_frx > i_srx);
        CHECK("R1: 0.2→10e6 не оставляет DEC4 последним",
              i_dec4 < 0 || i_frx > i_dec4);
    }
    legion_reg_write(LEGION_REG_AIR_PREP, 0);

    /* --- R2/R3: подмена actual fs → AIR отказ, не тихо 2e6 --- */
    rfic_n = 0;
    rfic_read_override[BLADERF_RFIC_COMMAND_SAMPLERATE] = 2000000;
    rfic_read_override_set[BLADERF_RFIC_COMMAND_SAMPLERATE] = true;
    legion_reg_write(LEGION_REG_AIR_FS_HZ, 520834);
    legion_reg_write(LEGION_REG_AIR_BW_HZ, 200000);
    CHECK("R2/R3: actual 2e6 при запросе 520834 → AIR отказ",
          !legion_reg_write(LEGION_REG_AIR_PREP, 0x7));
    CHECK("R2: отказ → STANDBY, unmute не ушёл",
          rfic_idx(BLADERF_RFIC_COMMAND_INIT, RFIC_SYSTEM_CHANNEL,
                   BLADERF_RFIC_INIT_STATE_STANDBY) >= 0 &&
          rfic_idx(BLADERF_RFIC_COMMAND_TXMUTE, BLADERF_CHANNEL_TX(0), 0) < 0);
    rfic_read_override_set[BLADERF_RFIC_COMMAND_SAMPLERATE] = false;
    {
        uint32_t prep = 0;
        legion_reg_read(LEGION_REG_AIR_PREP, &prep);
        CHECK("R2: AIR_PREP readback down", (prep & 0x1u) == 0);
    }

    /* --- U2: ENABLE TX fail → STANDBY; dirty down не silent --- */
    rfic_n = 0;
    rfic_fail_enable_tx = true;
    rfic_fail_standby = true;
    legion_reg_write(LEGION_REG_AIR_FS_HZ, 2000000);
    legion_reg_write(LEGION_REG_AIR_BW_HZ, 2000000);
    CHECK("U2: ENABLE TX fail → air_up false",
          !legion_reg_write(LEGION_REG_AIR_PREP, 0x7));
    CHECK("U2: STANDBY попытка после частичного ENABLE",
          rfic_idx(BLADERF_RFIC_COMMAND_INIT, RFIC_SYSTEM_CHANNEL,
                   BLADERF_RFIC_INIT_STATE_STANDBY) >= 0);
    CHECK("U2: dirty down не silent-success", !legion_air_down());
    rfic_fail_standby = false;
    rfic_fail_enable_tx = false;
    CHECK("U2: повторный down шлёт STANDBY и проходит", legion_air_down());

    /* --- U3: STANDBY fail → DISARM write false, повтор шлёт STANDBY --- */
    rfic_n = 0;
    CHECK("U3: AIR для DISARM", legion_reg_write(LEGION_REG_AIR_PREP, 0x7));
    CHECK("U3: ARM", legion_reg_write(LEGION_REG_CTRL, CTRL_ARM_WD_LBG));
    rfic_fail_standby = true;
    rfic_n = 0;
    pio_n = 0;
    CHECK("U3: DISARM при STANDBY fail → write false",
          !legion_reg_write(LEGION_REG_CTRL, 0));
    CHECK("U3: CTRL=0 всё же записан в HDL", pio_wrote_reg(LEGION_REG_CTRL, 0));
    CHECK("U3: STANDBY ушёл",
          rfic_idx(BLADERF_RFIC_COMMAND_INIT, RFIC_SYSTEM_CHANNEL,
                   BLADERF_RFIC_INIT_STATE_STANDBY) >= 0);
    rfic_fail_standby = false;
    rfic_n = 0;
    CHECK("U3: повторный DISARM шлёт STANDBY и ok",
          legion_reg_write(LEGION_REG_CTRL, 0) &&
          rfic_idx(BLADERF_RFIC_COMMAND_INIT, RFIC_SYSTEM_CHANNEL,
                   BLADERF_RFIC_INIT_STATE_STANDBY) >= 0);

    /* --- U4: отказ TX FREQUENCY — mute остаётся, unmute запрещён --- */
    rfic_n = 0;
    legion_reg_write(LEGION_REG_AIR_FREQ_KHZ, 2414000);
    legion_reg_write(LEGION_REG_AIR_FS_HZ, 28000000);
    legion_reg_write(LEGION_REG_AIR_BW_HZ, 28000000);
    CHECK("U4: AIR", legion_reg_write(LEGION_REG_AIR_PREP, 0x7));
    CHECK("U4: ARM", legion_reg_write(LEGION_REG_CTRL, CTRL_ARM_WD_LBG));
    legion_reg_write(LEGION_REG_SCAN_F1_KHZ, 2400000);
    legion_reg_write(LEGION_REG_SCAN_F2_KHZ, 2500000);
    legion_reg_write(LEGION_REG_SCAN_CTRL, LEGION_SCAN_CTRL_EN);
    t_status = 0;
    t_tamer = 1000;
    legion_work();
    rfic_fail_tx_freq = true;
    rfic_n = 0;
    t_tamer += 140001;
    legion_work();
    CHECK("U4: hop пытался TX FREQUENCY",
          rfic_idx(BLADERF_RFIC_COMMAND_FREQUENCY, BLADERF_CHANNEL_TX(0),
                   2442000ULL * 1000ULL) >= 0);
    CHECK("U4: mute остался (TXMUTE 1 есть)",
          rfic_idx(BLADERF_RFIC_COMMAND_TXMUTE, BLADERF_CHANNEL_TX(0), 1) >= 0);
    CHECK("U4: unmute=0 запрещён при отказе TX freq",
          rfic_idx(BLADERF_RFIC_COMMAND_TXMUTE, BLADERF_CHANNEL_TX(0), 0) < 0);
    {
        uint32_t khz = 0;
        legion_reg_read(LEGION_REG_AIR_FREQ_KHZ, &khz);
        CHECK("U4: AIR_FREQ не сменилась на чужую стоянку", khz == 2414000);
    }
    rfic_fail_tx_freq = false;
    /* U4b: отказ RX FREQUENCY после удачной записи TX — откатить TX. */
    CHECK("U4b: AIR", legion_reg_write(LEGION_REG_AIR_PREP, 0x7));
    CHECK("U4b: ARM", legion_reg_write(LEGION_REG_CTRL, CTRL_ARM_WD_LBG));
    legion_reg_write(LEGION_REG_SCAN_F1_KHZ, 2400000);
    legion_reg_write(LEGION_REG_SCAN_F2_KHZ, 2500000);
    legion_reg_write(LEGION_REG_SCAN_CTRL, LEGION_SCAN_CTRL_EN);
    t_status = 0;
    t_tamer = 1000;
    legion_work();
    rfic_fail_rx_freq = true;
    rfic_n = 0;
    t_tamer += 140001;
    legion_work();
    CHECK("U4b: hop пытался RX FREQUENCY",
          rfic_idx(BLADERF_RFIC_COMMAND_FREQUENCY, BLADERF_CHANNEL_RX(0),
                   2442000ULL * 1000ULL) >= 0);
    CHECK("U4b: hop записал TX на новую",
          rfic_idx(BLADERF_RFIC_COMMAND_FREQUENCY, BLADERF_CHANNEL_TX(0),
                   2442000ULL * 1000ULL) >= 0);
    CHECK("U4b: TX откатили на старый LO",
          rfic_idx(BLADERF_RFIC_COMMAND_FREQUENCY, BLADERF_CHANNEL_TX(0),
                   2414000ULL * 1000ULL) >
          rfic_idx(BLADERF_RFIC_COMMAND_FREQUENCY, BLADERF_CHANNEL_TX(0),
                   2442000ULL * 1000ULL));
    CHECK("U4b: unmute=0 запрещён при отказе RX freq",
          rfic_idx(BLADERF_RFIC_COMMAND_TXMUTE, BLADERF_CHANNEL_TX(0), 0) < 0);
    {
        uint32_t khz = 0;
        legion_reg_read(LEGION_REG_AIR_FREQ_KHZ, &khz);
        CHECK("U4b: AIR_FREQ не сменилась на чужую стоянку", khz == 2414000);
    }
    rfic_fail_rx_freq = false;
    legion_reg_write(LEGION_REG_SCAN_CTRL, 0);
    legion_reg_write(LEGION_REG_CTRL, 0);

    /* --- FFT: mux 0x15 и SEARCH→FIRE. FFT_CTRL=0 выше не тронут. --- */
    t_status = 0x00A50004u;
    t_peak_word = 0x81AB3410u;
    t_aws = 0;
    {
        uint32_t v = 0;
        legion_reg_read(LEGION_REG_PEAK_BIN, &v);
        CHECK("FFT: PEAK_BIN mux, не STATUS", v == 0x81AB3410u);
        legion_reg_read(0, &v);
        CHECK("FFT: addr 0 после mux — снова STATUS", (v & 0x4u) != 0);
    }

    legion_reg_write(LEGION_REG_AIR_FREQ_KHZ, 2450000);
    legion_reg_write(LEGION_REG_AIR_FS_HZ, 56000000);
    legion_reg_write(LEGION_REG_AIR_BW_HZ, 56000000);
    legion_reg_write(LEGION_REG_SEARCH_BW_HZ, 56000000);
    legion_reg_write(LEGION_REG_FIRE_BW_HZ, 2000000);
    legion_reg_write(LEGION_REG_SETTLE_N, 8);
    legion_reg_write(LEGION_REG_SCAN_F1_KHZ, 2436000);
    legion_reg_write(LEGION_REG_SCAN_F2_KHZ, 2464000);
    legion_reg_write(LEGION_REG_SCAN_CTRL, LEGION_SCAN_CTRL_EN);
    legion_reg_write(LEGION_REG_FFT_CTRL, LEGION_FFT_CTRL_EN);
    CHECK("FFT n==1: AIR", legion_reg_write(LEGION_REG_AIR_PREP, 0x7));
    CHECK("FFT n==1: ARM", legion_reg_write(LEGION_REG_CTRL, CTRL_ARM_WD_LBG));
    t_status = 0;
    t_tamer = 1000;
    t_peak_word = 0;
    rfic_n = 0;
    legion_work(); /* SEARCH: тот же LO, mute */
    CHECK("FFT n==1: SEARCH глушит TX",
          rfic_idx(BLADERF_RFIC_COMMAND_TXMUTE, BLADERF_CHANNEL_TX(0), 1) >= 0);
    CHECK("FFT n==1: SEARCH не unmute",
          rfic_idx(BLADERF_RFIC_COMMAND_TXMUTE, BLADERF_CHANNEL_TX(0), 0) < 0);
    CHECK("FFT n==1: SEARCH не hop на пик",
          rfic_idx(BLADERF_RFIC_COMMAND_FREQUENCY, BLADERF_CHANNEL_RX(0),
                   2453500ULL * 1000ULL) < 0);
    t_tamer += 8;
    legion_work(); /* SETTLE → FRAME + unmute */
    CHECK("FFT n==1: SETTLE unmute (открытие — HDL)",
          rfic_idx(BLADERF_RFIC_COMMAND_TXMUTE, BLADERF_CHANNEL_TX(0), 0) >= 0);
    rfic_n = 0;
    t_peak_word = mk_peak(1, 3, 0x1000, 16);
    legion_work();
    CHECK("FFT: без энергии шумовой bin не шагает", rfic_n == 0);
    t_status = LEGION_STATUS_DET_ACTIVE;
    t_peak_word = mk_peak(1, 0, 0x2000, 16); /* frame=0 валиден (обёртка 7 бит) */
    legion_work(); /* запомнить кадр */
    CHECK("FFT: ждём новый кадр (в т.ч. после frame=0)", rfic_n == 0);
    t_peak_word = mk_peak(1, 1, 0x2000, 16);
    rfic_n = 0;
    legion_work(); /* FIRE: bin16 @ 56e6 = +3500 кГц → PEAK 2453.5, LO 2450 */
    CHECK("FFT n==1: FIRE без hop PLL на пик",
          rfic_idx(BLADERF_RFIC_COMMAND_FREQUENCY, BLADERF_CHANNEL_RX(0),
                   2453500ULL * 1000ULL) < 0);
    CHECK("FFT n==1: FIRE unmute",
          rfic_idx(BLADERF_RFIC_COMMAND_TXMUTE, BLADERF_CHANNEL_TX(0), 0) >= 0);
    CHECK("FFT n==1: analog не узжаем, fs не трогаем",
          rfic_idx(BLADERF_RFIC_COMMAND_BANDWIDTH, BLADERF_CHANNEL_RX(0),
                   2000000) < 0 &&
          rfic_idx(BLADERF_RFIC_COMMAND_SAMPLERATE, BLADERF_CHANNEL_RX(0),
                   56000000) < 0);
    {
        uint32_t khz = 0;
        legion_reg_read(LEGION_REG_AIR_FREQ_KHZ, &khz);
        CHECK("FFT n==1: AIR_FREQ = центр взгляда", khz == 2450000);
        legion_reg_read(LEGION_REG_PEAK_KHZ, &khz);
        CHECK("FFT n==1: PEAK_KHZ = пик", khz == 2453500);
    }
    rfic_n = 0;
    t_status = LEGION_STATUS_DET_ACTIVE;
    t_tamer += 10000000; /* >> SETTLE_N: старый resense глушил бы TX */
    legion_work();
    CHECK("FFT PRIORITY + энергия → LO не шагает", rfic_n == 0);
    t_status = 0;
    rfic_n = 0;
    t_tamer += (uint64_t)56000000 * 6 / 1000;
    legion_work();
    CHECK("FFT n==1 тишина: не mute/SETTLE на том же LO", rfic_n == 0);

    /* xA4 края каталога: hop uint64 на 5.8 ГГц; clip RX 70–6000. */
    legion_reg_write(LEGION_REG_AIR_FREQ_KHZ, 5800000);
    legion_reg_write(LEGION_REG_AIR_FS_HZ, 56000000);
    legion_reg_write(LEGION_REG_AIR_BW_HZ, 56000000);
    legion_reg_write(LEGION_REG_SEARCH_BW_HZ, 56000000);
    legion_reg_write(LEGION_REG_FIRE_BW_HZ, 2000000);
    legion_reg_write(LEGION_REG_SETTLE_N, 8);
    legion_reg_write(LEGION_REG_SCAN_F1_KHZ, 5772000);
    legion_reg_write(LEGION_REG_SCAN_F2_KHZ, 5828000);
    legion_reg_write(LEGION_REG_SCAN_CTRL, LEGION_SCAN_CTRL_EN);
    legion_reg_write(LEGION_REG_FFT_CTRL, LEGION_FFT_CTRL_EN);
    CHECK("FFT 5.8G: AIR", legion_reg_write(LEGION_REG_AIR_PREP, 0x7));
    CHECK("FFT 5.8G: ARM", legion_reg_write(LEGION_REG_CTRL, CTRL_ARM_WD_LBG));
    t_status = 0;
    t_tamer = 1000;
    t_peak_word = 0;
    rfic_n = 0;
    legion_work(); /* SEARCH same LO */
    t_tamer += 8;
    legion_work(); /* FRAME */
    t_status = LEGION_STATUS_DET_ACTIVE;
    t_peak_word = mk_peak(1, 0, 0x2000, 16);
    legion_work();
    t_peak_word = mk_peak(1, 1, 0x2000, 16);
    rfic_n = 0;
    legion_work();
    CHECK("FFT 5.8G: FIRE без hop 5803.5",
          rfic_idx(BLADERF_RFIC_COMMAND_FREQUENCY, BLADERF_CHANNEL_RX(0),
                   5803500ULL * 1000ULL) < 0);
    {
        uint32_t khz = 0;
        legion_reg_read(LEGION_REG_AIR_FREQ_KHZ, &khz);
        CHECK("FFT 5.8G: AIR_FREQ = центр 5800000", khz == 5800000);
        legion_reg_read(LEGION_REG_PEAK_KHZ, &khz);
        CHECK("FFT 5.8G: PEAK_KHZ = 5803500", khz == 5803500);
    }

    legion_reg_write(LEGION_REG_AIR_FREQ_KHZ, 75000);
    legion_reg_write(LEGION_REG_SCAN_F1_KHZ, 70000);
    legion_reg_write(LEGION_REG_SCAN_F2_KHZ, 80000);
    CHECK("FFT clip70: AIR", legion_reg_write(LEGION_REG_AIR_PREP, 0x7));
    CHECK("FFT clip70: ARM", legion_reg_write(LEGION_REG_CTRL, CTRL_ARM_WD_LBG));
    t_status = 0;
    t_tamer = 1000;
    t_peak_word = 0;
    rfic_n = 0;
    legion_work(); /* SEARCH 75 */
    t_tamer += 8;
    legion_work();
    t_status = LEGION_STATUS_DET_ACTIVE;
    t_peak_word = mk_peak(1, 2, 0x2000, 128); /* k=−128 @ 56e6 = −28 МГц → 47 */
    legion_work();
    t_peak_word = mk_peak(1, 3, 0x2000, 128);
    rfic_n = 0;
    legion_work();
    CHECK("FFT clip70: FIRE без hop на 70",
          rfic_idx(BLADERF_RFIC_COMMAND_FREQUENCY, BLADERF_CHANNEL_RX(0),
                   70000ULL * 1000ULL) < 0);
    {
        uint32_t khz = 0;
        legion_reg_read(LEGION_REG_AIR_FREQ_KHZ, &khz);
        CHECK("FFT clip70: AIR_FREQ = центр 75000", khz == 75000);
        legion_reg_read(LEGION_REG_PEAK_KHZ, &khz);
        CHECK("FFT clip70: PEAK_KHZ clip RX min 70", khz == 70000);
    }

    legion_reg_write(LEGION_REG_AIR_FREQ_KHZ, 98000);
    legion_reg_write(LEGION_REG_SCAN_F1_KHZ, 70000);
    legion_reg_write(LEGION_REG_SCAN_F2_KHZ, 6000000);
    CHECK("FFT 70-6000: AIR", legion_reg_write(LEGION_REG_AIR_PREP, 0x7));
    CHECK("FFT 70-6000: ARM", legion_reg_write(LEGION_REG_CTRL, CTRL_ARM_WD_LBG));
    t_status = 0;
    t_tamer = 1000;
    t_peak_word = 0;
    rfic_n = 0;
    legion_work(); /* SEARCH same 98 */
    t_tamer += 8;
    legion_work(); /* FRAME */
    rfic_n = 0;
    t_tamer += 280001; /* quiet = 56e6 × 5 мс */
    legion_work();
    CHECK("FFT 70-6000: тишина → взгляд 154 МГц (106 стоянок)",
          rfic_idx(BLADERF_RFIC_COMMAND_FREQUENCY, BLADERF_CHANNEL_RX(0),
                   154000ULL * 1000ULL) >= 0);

    /* n>1: тишина после SETTLE → следующий взгляд, mute */
    legion_reg_write(LEGION_REG_AIR_FREQ_KHZ, 2414000);
    legion_reg_write(LEGION_REG_AIR_FS_HZ, 28000000);
    legion_reg_write(LEGION_REG_AIR_BW_HZ, 28000000);
    legion_reg_write(LEGION_REG_SEARCH_BW_HZ, 28000000);
    legion_reg_write(LEGION_REG_FIRE_BW_HZ, 2000000);
    legion_reg_write(LEGION_REG_SETTLE_N, 8);
    legion_reg_write(LEGION_REG_SCAN_F1_KHZ, 2400000);
    legion_reg_write(LEGION_REG_SCAN_F2_KHZ, 2500000);
    legion_reg_write(LEGION_REG_SCAN_CTRL, LEGION_SCAN_CTRL_EN);
    legion_reg_write(LEGION_REG_FFT_CTRL, LEGION_FFT_CTRL_EN);
    CHECK("FFT n>1: AIR", legion_reg_write(LEGION_REG_AIR_PREP, 0x7));
    CHECK("FFT n>1: ARM", legion_reg_write(LEGION_REG_CTRL, CTRL_ARM_WD_LBG));
    t_status = 0;
    t_tamer = 1000;
    t_peak_word = mk_peak(1, 1, 0x00ff, 16);
    rfic_n = 0;
    legion_work(); /* SEARCH 2414 */
    t_tamer += 8;
    legion_work(); /* FRAME */
    rfic_n = 0;
    t_tamer += 140001;
    legion_work();
    CHECK("FFT n>1: тишина → hop на центр 1, mute",
          rfic_idx(BLADERF_RFIC_COMMAND_FREQUENCY, BLADERF_CHANNEL_RX(0),
                   2442000ULL * 1000ULL) >= 0 &&
          rfic_idx(BLADERF_RFIC_COMMAND_TXMUTE, BLADERF_CHANNEL_TX(0), 1) >= 0 &&
          rfic_idx(BLADERF_RFIC_COMMAND_TXMUTE, BLADERF_CHANNEL_TX(0), 0) < 0);

    /* FFT TURN: 2400–2500 @ 56 МГц. Не PRIORITY («пока жив — сидим»).
     * Выдержка 400 мкс от первого HOLD-det, затем следующий взгляд.
     * bin 73 @ 56e6 / центр 2428 → 2443.969 МГц (ближайший бин к 2444). */
    legion_reg_write(LEGION_REG_BAND_COUNT, 0);
    legion_reg_write(LEGION_REG_AIR_FREQ_KHZ, 2428000);
    legion_reg_write(LEGION_REG_AIR_FS_HZ, 56000000);
    legion_reg_write(LEGION_REG_AIR_BW_HZ, 56000000);
    legion_reg_write(LEGION_REG_SEARCH_BW_HZ, 56000000);
    legion_reg_write(LEGION_REG_FIRE_BW_HZ, 2000000);
    legion_reg_write(LEGION_REG_SETTLE_N, 8);
    legion_reg_write(LEGION_REG_SCAN_F1_KHZ, 2400000);
    legion_reg_write(LEGION_REG_SCAN_F2_KHZ, 2500000);
    legion_reg_write(LEGION_REG_SCAN_DWELL_US, 400);
    legion_reg_write(LEGION_REG_SCAN_CTRL,
                     LEGION_SCAN_CTRL_EN | LEGION_SCAN_CTRL_TURN);
    legion_reg_write(LEGION_REG_FFT_CTRL, LEGION_FFT_CTRL_EN);
    CHECK("FFT TURN 2400-2500: AIR", legion_reg_write(LEGION_REG_AIR_PREP, 0x7));
    CHECK("FFT TURN 2400-2500: ARM", legion_reg_write(LEGION_REG_CTRL, CTRL_ARM_WD_LBG));
    t_status = 0;
    t_tamer = 1000;
    t_peak_word = 0;
    rfic_n = 0;
    legion_work(); /* SEARCH 2428, mute */
    CHECK("FFT TURN: SEARCH глушит TX",
          rfic_idx(BLADERF_RFIC_COMMAND_TXMUTE, BLADERF_CHANNEL_TX(0), 1) >= 0);
    t_tamer += 8;
    legion_work(); /* FRAME */
    t_status = LEGION_STATUS_DET_ACTIVE;
    t_peak_word = mk_peak(1, 0, 0x2000, 73);
    legion_work(); /* snap frame */
    t_peak_word = mk_peak(1, 1, 0x2000, 73);
    rfic_n = 0;
    legion_work(); /* FIRE ~2444 цифрой, LO 2428 */
    CHECK("FFT TURN: FIRE без hop PLL на ~2444",
          rfic_idx(BLADERF_RFIC_COMMAND_FREQUENCY, BLADERF_CHANNEL_RX(0),
                   2443969ULL * 1000ULL) < 0);
    CHECK("FFT TURN: FIRE unmute",
          rfic_idx(BLADERF_RFIC_COMMAND_TXMUTE, BLADERF_CHANNEL_TX(0), 0) >= 0);
    {
        uint32_t khz = 0;
        legion_reg_read(LEGION_REG_AIR_FREQ_KHZ, &khz);
        CHECK("FFT TURN: AIR_FREQ = центр 2428", khz == 2428000);
        legion_reg_read(LEGION_REG_PEAK_KHZ, &khz);
        CHECK("FFT TURN: PEAK_KHZ = 2443969", khz == 2443969);
    }
    rfic_n = 0;
    legion_work(); /* HOLD: якорь выдержки от первого det */
    t_tamer += (uint64_t)56000000 * 400 / 1000000 - 1; /* 22399 < dwell 22400 */
    legion_work();
    CHECK("FFT TURN: энергия есть, выдержка не истекла → hop нет", rfic_n == 0);
    t_tamer += 2;
    legion_work();
    CHECK("FFT TURN: dwell 400 мкс → следующий взгляд 2484, mute",
          rfic_idx(BLADERF_RFIC_COMMAND_FREQUENCY, BLADERF_CHANNEL_RX(0),
                   2484000ULL * 1000ULL) >= 0 &&
          rfic_idx(BLADERF_RFIC_COMMAND_TXMUTE, BLADERF_CHANNEL_TX(0), 1) >= 0 &&
          rfic_idx(BLADERF_RFIC_COMMAND_TXMUTE, BLADERF_CHANNEL_TX(0), 0) < 0);

    /* FFT PARK: ICE9 — один LO на середине 2400–2487. Dwell не гоняет PLL. */
    legion_reg_write(LEGION_REG_BAND_COUNT, 0);
    legion_reg_write(LEGION_REG_AIR_FREQ_KHZ, 2443500);
    legion_reg_write(LEGION_REG_AIR_FS_HZ, 56000000);
    legion_reg_write(LEGION_REG_AIR_BW_HZ, 56000000);
    legion_reg_write(LEGION_REG_SEARCH_BW_HZ, 56000000);
    legion_reg_write(LEGION_REG_SETTLE_N, 8);
    legion_reg_write(LEGION_REG_SCAN_F1_KHZ, 2400000);
    legion_reg_write(LEGION_REG_SCAN_F2_KHZ, 2487000);
    legion_reg_write(LEGION_REG_SCAN_DWELL_US, 400);
    legion_reg_write(LEGION_REG_SCAN_CTRL,
                     LEGION_SCAN_CTRL_EN | LEGION_SCAN_CTRL_PARK);
    legion_reg_write(LEGION_REG_FFT_CTRL, LEGION_FFT_CTRL_EN);
    CHECK("FFT PARK 2400-2487: AIR", legion_reg_write(LEGION_REG_AIR_PREP, 0x7));
    CHECK("FFT PARK 2400-2487: ARM", legion_reg_write(LEGION_REG_CTRL, CTRL_ARM_WD_LBG));
    t_status = 0;
    t_tamer = 1000;
    t_peak_word = 0;
    rfic_n = 0;
    legion_work(); /* SEARCH 2443.5 */
    t_tamer += 8;
    legion_work(); /* FRAME */
    t_status = LEGION_STATUS_DET_ACTIVE;
    t_peak_word = mk_peak(1, 0, 0x2000, 16);
    legion_work();
    t_peak_word = mk_peak(1, 1, 0x2000, 16);
    rfic_n = 0;
    legion_work(); /* FIRE */
    {
        uint32_t khz = 0;
        legion_reg_read(LEGION_REG_AIR_FREQ_KHZ, &khz);
        CHECK("FFT PARK: AIR_FREQ = середина 2443.5", khz == 2443500);
    }
    rfic_n = 0;
    legion_work();
    t_tamer += (uint64_t)56000000 * 400 / 1000000 + 8;
    legion_work();
    CHECK("FFT PARK: dwell+энергия → PLL не гоняем", rfic_n == 0);
    t_status = 0;
    t_tamer += (uint64_t)56000000 * 6 / 1000;
    rfic_n = 0;
    legion_work();
    CHECK("FFT PARK: тишина → не mute/SETTLE на том же LO", rfic_n == 0);

    /* FFT SURVEY: 2000–3000 @ 56. Глухой проход 0…17, TX mute.
     * Клетка 7 = 2420, bin 64 → 2434. После прохода LO=2434, не 2500. */
    legion_reg_write(LEGION_REG_BAND_COUNT, 0);
    legion_reg_write(LEGION_REG_AIR_FREQ_KHZ, 2028000);
    legion_reg_write(LEGION_REG_AIR_FS_HZ, 56000000);
    legion_reg_write(LEGION_REG_AIR_BW_HZ, 56000000);
    legion_reg_write(LEGION_REG_SEARCH_BW_HZ, 56000000);
    legion_reg_write(LEGION_REG_SETTLE_N, 8);
    legion_reg_write(LEGION_REG_SCAN_F1_KHZ, 2000000);
    legion_reg_write(LEGION_REG_SCAN_F2_KHZ, 3000000);
    legion_reg_write(LEGION_REG_SCAN_DWELL_US, 400);
    legion_reg_write(LEGION_REG_SCAN_SURVEY_US, 400);
    legion_reg_write(LEGION_REG_SCAN_CTRL,
                     LEGION_SCAN_CTRL_EN | LEGION_SCAN_CTRL_SURVEY);
    legion_reg_write(LEGION_REG_FFT_CTRL, LEGION_FFT_CTRL_EN);
    CHECK("FFT SURVEY 2000-3000: AIR", legion_reg_write(LEGION_REG_AIR_PREP, 0x7));
    CHECK("FFT SURVEY 2000-3000: ARM", legion_reg_write(LEGION_REG_CTRL, CTRL_ARM_WD_LBG));
    t_status = 0;
    t_tamer = 1000;
    t_peak_word = 0;
    rfic_n = 0;
    {
        int li;
        for (li = 0; li < 18; li++) {
            legion_work(); /* SEARCH */
            if (li == 0) {
                uint32_t ev = 0;
                legion_reg_read(LEGION_REG_SCAN_EVENT, &ev);
                CHECK("FFT SURVEY: первый проход — событие PASS",
                      (ev & 0xffu) == LEGION_EVT_PASS);
            }
            t_tamer += 8;
            legion_work(); /* SETTLE → FRAME, mute */
            if (li == 7) {
                t_status = LEGION_STATUS_DET_ACTIVE;
                t_peak_word = mk_peak(1, 0, 0x2000, 64);
                legion_work();
                t_peak_word = mk_peak(1, 1, 0x2000, 64);
                legion_work();
            } else {
                t_status = 0;
                t_peak_word = 0;
            }
            t_tamer += (uint64_t)56000000 * 5 / 1000;
            legion_work(); /* next / pick */
        }
    }
    CHECK("FFT SURVEY: 18 клеток без unmute",
          rfic_idx(BLADERF_RFIC_COMMAND_TXMUTE, BLADERF_CHANNEL_TX(0), 0) < 0);
    {
        uint32_t khz = 0;
        legion_reg_read(LEGION_REG_AIR_FREQ_KHZ, &khz);
        CHECK("FFT SURVEY: после прохода AIR = 2434, не 2500",
              khz == 2434000);
        legion_reg_read(LEGION_REG_SCAN_EVENT, &khz);
        CHECK("FFT SURVEY: взгляд — событие STARE",
              (khz & 0xffu) == LEGION_EVT_STARE);
        legion_reg_read(LEGION_REG_SCAN_F1_KHZ, &khz);
        CHECK("FFT SURVEY: F1 конверт 2000", khz == 2000000);
        legion_reg_read(LEGION_REG_SCAN_F2_KHZ, &khz);
        CHECK("FFT SURVEY: F2 конверт 3000", khz == 3000000);
    }
    t_tamer += 8;
    rfic_n = 0;
    legion_work(); /* STARE SETTLE unmute */
    CHECK("FFT SURVEY: стоянка unmute после SETTLE",
          rfic_idx(BLADERF_RFIC_COMMAND_TXMUTE, BLADERF_CHANNEL_TX(0), 0) >= 0);
    rfic_n = 0;
    t_tamer += (uint64_t)56000000 * 400 / 1000000 + 1;
    legion_work(); /* T → снова обзор, клетка 0 = 2028, mute */
    CHECK("FFT SURVEY: после T hop на 2028, mute",
          rfic_idx(BLADERF_RFIC_COMMAND_FREQUENCY, BLADERF_CHANNEL_RX(0),
                   2028000ULL * 1000ULL) >= 0 &&
          rfic_idx(BLADERF_RFIC_COMMAND_TXMUTE, BLADERF_CHANNEL_TX(0), 1) >= 0 &&
          rfic_idx(BLADERF_RFIC_COMMAND_TXMUTE, BLADERF_CHANNEL_TX(0), 0) < 0);
    {
        uint32_t khz = 0;
        legion_reg_read(LEGION_REG_SCAN_F1_KHZ, &khz);
        CHECK("FFT SURVEY: F1 после T не стёрт", khz == 2000000);
        legion_reg_read(LEGION_REG_SCAN_F2_KHZ, &khz);
        CHECK("FFT SURVEY: F2 после T не стёрт", khz == 3000000);
        legion_reg_read(LEGION_REG_SCAN_EVENT, &khz);
        CHECK("FFT SURVEY: после T — событие RESURVEY, не PASS",
              (khz & 0xffu) == LEGION_EVT_RESURVEY);
    }

    /* После T hop на 2028 отказал: без сброса look_set/HOLD PASS молчит навсегда. */
    legion_reg_write(LEGION_REG_AIR_FREQ_KHZ, 2028000);
    legion_reg_write(LEGION_REG_SETTLE_N, 8);
    legion_reg_write(LEGION_REG_SCAN_F1_KHZ, 2000000);
    legion_reg_write(LEGION_REG_SCAN_F2_KHZ, 3000000);
    legion_reg_write(LEGION_REG_SCAN_DWELL_US, 400);
    legion_reg_write(LEGION_REG_SCAN_SURVEY_US, 400);
    legion_reg_write(LEGION_REG_SCAN_CTRL,
                     LEGION_SCAN_CTRL_EN | LEGION_SCAN_CTRL_SURVEY);
    legion_reg_write(LEGION_REG_FFT_CTRL, LEGION_FFT_CTRL_EN);
    CHECK("FFT SURVEY Tretry: AIR", legion_reg_write(LEGION_REG_AIR_PREP, 0x7));
    CHECK("FFT SURVEY Tretry: ARM", legion_reg_write(LEGION_REG_CTRL, CTRL_ARM_WD_LBG));
    t_status = 0;
    t_tamer = 1000;
    t_peak_word = 0;
    {
        int li;
        for (li = 0; li < 18; li++) {
            legion_work();
            t_tamer += 8;
            legion_work();
            if (li == 7) {
                t_status = LEGION_STATUS_DET_ACTIVE;
                t_peak_word = mk_peak(1, 0, 0x2000, 64);
                legion_work();
                t_peak_word = mk_peak(1, 1, 0x2000, 64);
                legion_work();
            } else {
                t_status = 0;
                t_peak_word = 0;
            }
            t_tamer += (uint64_t)56000000 * 5 / 1000;
            legion_work();
        }
    }
    t_tamer += 8;
    legion_work(); /* stare unmute */
    rfic_fail_tx_freq = true;
    rfic_n = 0;
    t_tamer += (uint64_t)56000000 * 400 / 1000000 + 1;
    legion_work(); /* T → hop 2028 отказ */
    {
        uint32_t khz = 0;
        legion_reg_read(LEGION_REG_AIR_FREQ_KHZ, &khz);
        CHECK("FFT SURVEY Tretry: отказ — AIR остался 2434", khz == 2434000);
    }
    CHECK("FFT SURVEY Tretry: отказ — mute, не unmute",
          rfic_idx(BLADERF_RFIC_COMMAND_TXMUTE, BLADERF_CHANNEL_TX(0), 1) >= 0 &&
          rfic_idx(BLADERF_RFIC_COMMAND_TXMUTE, BLADERF_CHANNEL_TX(0), 0) < 0);
    rfic_fail_tx_freq = false;
    rfic_n = 0;
    legion_work(); /* повтор enter_look(0) */
    CHECK("FFT SURVEY Tretry: повтор hop 2028, mute",
          rfic_idx(BLADERF_RFIC_COMMAND_FREQUENCY, BLADERF_CHANNEL_RX(0),
                   2028000ULL * 1000ULL) >= 0 &&
          rfic_idx(BLADERF_RFIC_COMMAND_TXMUTE, BLADERF_CHANNEL_TX(0), 1) >= 0 &&
          rfic_idx(BLADERF_RFIC_COMMAND_TXMUTE, BLADERF_CHANNEL_TX(0), 0) < 0);

    /* Два hit: 2084 mag меньше, 2812 больше. Первый круг — 2812; после T — 2084. */
    legion_reg_write(LEGION_REG_AIR_FREQ_KHZ, 2028000);
    legion_reg_write(LEGION_REG_AIR_FS_HZ, 56000000);
    legion_reg_write(LEGION_REG_AIR_BW_HZ, 56000000);
    legion_reg_write(LEGION_REG_SEARCH_BW_HZ, 56000000);
    legion_reg_write(LEGION_REG_SETTLE_N, 8);
    legion_reg_write(LEGION_REG_SCAN_F1_KHZ, 2000000);
    legion_reg_write(LEGION_REG_SCAN_F2_KHZ, 3000000);
    legion_reg_write(LEGION_REG_SCAN_DWELL_US, 400);
    legion_reg_write(LEGION_REG_SCAN_SURVEY_US, 400);
    legion_reg_write(LEGION_REG_SCAN_CTRL,
                     LEGION_SCAN_CTRL_EN | LEGION_SCAN_CTRL_SURVEY);
    legion_reg_write(LEGION_REG_FFT_CTRL, LEGION_FFT_CTRL_EN);
    CHECK("FFT SURVEY 2hit: AIR", legion_reg_write(LEGION_REG_AIR_PREP, 0x7));
    CHECK("FFT SURVEY 2hit: ARM", legion_reg_write(LEGION_REG_CTRL, CTRL_ARM_WD_LBG));
    t_status = 0;
    t_tamer = 1000;
    t_peak_word = 0;
    {
        int li;
        for (li = 0; li < 18; li++) {
            legion_work();
            t_tamer += 8;
            legion_work();
            if (li == 1) {
                t_status = LEGION_STATUS_DET_ACTIVE;
                t_peak_word = mk_peak(1, 0, 0x1000, 0);
                legion_work();
                t_peak_word = mk_peak(1, 1, 0x1000, 0);
                legion_work();
            } else if (li == 14) {
                t_status = LEGION_STATUS_DET_ACTIVE;
                t_peak_word = mk_peak(1, 0, 0x2000, 0);
                legion_work();
                t_peak_word = mk_peak(1, 1, 0x2000, 0);
                legion_work();
            } else {
                t_status = 0;
                t_peak_word = 0;
            }
            t_tamer += (uint64_t)56000000 * 5 / 1000;
            legion_work();
        }
    }
    {
        uint32_t khz = 0;
        legion_reg_read(LEGION_REG_AIR_FREQ_KHZ, &khz);
        CHECK("FFT SURVEY 2hit: первый круг AIR = 2812", khz == 2812000);
    }
    t_tamer += 8;
    legion_work(); /* stare unmute */
    t_tamer += (uint64_t)56000000 * 400 / 1000000 + 1;
    legion_work(); /* restart pass */
    t_status = 0;
    t_peak_word = 0;
    {
        int li;
        for (li = 0; li < 18; li++) {
            legion_work();
            t_tamer += 8;
            legion_work();
            if (li == 1) {
                t_status = LEGION_STATUS_DET_ACTIVE;
                t_peak_word = mk_peak(1, 0, 0x1000, 0);
                legion_work();
                t_peak_word = mk_peak(1, 1, 0x1000, 0);
                legion_work();
            } else if (li == 14) {
                t_status = LEGION_STATUS_DET_ACTIVE;
                t_peak_word = mk_peak(1, 0, 0x2000, 0);
                legion_work();
                t_peak_word = mk_peak(1, 1, 0x2000, 0);
                legion_work();
            } else {
                t_status = 0;
                t_peak_word = 0;
            }
            t_tamer += (uint64_t)56000000 * 5 / 1000;
            legion_work();
        }
    }
    {
        uint32_t khz = 0;
        legion_reg_read(LEGION_REG_AIR_FREQ_KHZ, &khz);
        CHECK("FFT SURVEY 2hit: после T AIR = 2084 (следующий hit)", khz == 2084000);
    }

    /* Пустой 2000–3000: unmute нет, после прохода не 2500. */
    legion_reg_write(LEGION_REG_AIR_FREQ_KHZ, 2028000);
    legion_reg_write(LEGION_REG_SETTLE_N, 8);
    legion_reg_write(LEGION_REG_SCAN_F1_KHZ, 2000000);
    legion_reg_write(LEGION_REG_SCAN_F2_KHZ, 3000000);
    legion_reg_write(LEGION_REG_SCAN_DWELL_US, 400);
    legion_reg_write(LEGION_REG_SCAN_SURVEY_US, 400);
    legion_reg_write(LEGION_REG_SCAN_CTRL,
                     LEGION_SCAN_CTRL_EN | LEGION_SCAN_CTRL_SURVEY);
    legion_reg_write(LEGION_REG_FFT_CTRL, LEGION_FFT_CTRL_EN);
    CHECK("FFT SURVEY empty: AIR", legion_reg_write(LEGION_REG_AIR_PREP, 0x7));
    CHECK("FFT SURVEY empty: ARM", legion_reg_write(LEGION_REG_CTRL, CTRL_ARM_WD_LBG));
    t_status = 0;
    t_tamer = 1000;
    t_peak_word = 0;
    rfic_n = 0;
    {
        int li;
        for (li = 0; li < 18; li++) {
            legion_work();
            t_tamer += 8;
            legion_work();
            t_tamer += (uint64_t)56000000 * 5 / 1000;
            legion_work();
        }
    }
    CHECK("FFT SURVEY empty: unmute нет",
          rfic_idx(BLADERF_RFIC_COMMAND_TXMUTE, BLADERF_CHANNEL_TX(0), 0) < 0);
    {
        uint32_t khz = 0;
        legion_reg_read(LEGION_REG_AIR_FREQ_KHZ, &khz);
        CHECK("FFT SURVEY empty: AIR ≠ 2500", khz != 2500000);
        legion_reg_read(LEGION_REG_SCAN_EVENT, &khz);
        CHECK("FFT SURVEY empty: снова глухой — событие PASS",
              (khz & 0xffu) == LEGION_EVT_PASS);
    }

    /* 2300–2500: 4 взгляда. Пик bin128 @ 2328 → ~2300, clip LO=2328. */
    legion_reg_write(LEGION_REG_AIR_FREQ_KHZ, 2328000);
    legion_reg_write(LEGION_REG_AIR_FS_HZ, 56000000);
    legion_reg_write(LEGION_REG_AIR_BW_HZ, 56000000);
    legion_reg_write(LEGION_REG_SEARCH_BW_HZ, 56000000);
    legion_reg_write(LEGION_REG_SETTLE_N, 8);
    legion_reg_write(LEGION_REG_SCAN_F1_KHZ, 2300000);
    legion_reg_write(LEGION_REG_SCAN_F2_KHZ, 2500000);
    legion_reg_write(LEGION_REG_SCAN_DWELL_US, 400);
    legion_reg_write(LEGION_REG_SCAN_SURVEY_US, 400);
    legion_reg_write(LEGION_REG_SCAN_CTRL,
                     LEGION_SCAN_CTRL_EN | LEGION_SCAN_CTRL_SURVEY);
    legion_reg_write(LEGION_REG_FFT_CTRL, LEGION_FFT_CTRL_EN);
    CHECK("FFT SURVEY 2300-2500: AIR", legion_reg_write(LEGION_REG_AIR_PREP, 0x7));
    CHECK("FFT SURVEY 2300-2500: ARM", legion_reg_write(LEGION_REG_CTRL, CTRL_ARM_WD_LBG));
    t_status = 0;
    t_tamer = 1000;
    t_peak_word = 0;
    {
        int li;
        for (li = 0; li < 4; li++) {
            legion_work();
            t_tamer += 8;
            legion_work();
            if (li == 0) {
                t_status = LEGION_STATUS_DET_ACTIVE;
                t_peak_word = mk_peak(1, 0, 0x2000, 128);
                legion_work();
                t_peak_word = mk_peak(1, 1, 0x2000, 128);
                legion_work();
            } else {
                t_status = 0;
                t_peak_word = 0;
            }
            t_tamer += (uint64_t)56000000 * 5 / 1000;
            legion_work();
        }
    }
    {
        uint32_t khz = 0;
        legion_reg_read(LEGION_REG_AIR_FREQ_KHZ, &khz);
        CHECK("FFT SURVEY 2300-2500: clip пика 2310 → LO 2328", khz == 2328000);
    }

    /* Хост ARM шлёт FFT_CTRL enable|notch. Стоянка на 2434 = bin 0.
     * HDL skip_dc спрятал бы тон — на стоянке notch должен уйти из HDL,
     * тень NIOS (readback) остаётся как писал хост. */
    legion_reg_write(LEGION_REG_BAND_COUNT, 0);
    legion_reg_write(LEGION_REG_AIR_FREQ_KHZ, 2028000);
    legion_reg_write(LEGION_REG_AIR_FS_HZ, 56000000);
    legion_reg_write(LEGION_REG_AIR_BW_HZ, 56000000);
    legion_reg_write(LEGION_REG_SEARCH_BW_HZ, 56000000);
    legion_reg_write(LEGION_REG_SETTLE_N, 8);
    legion_reg_write(LEGION_REG_SCAN_F1_KHZ, 2000000);
    legion_reg_write(LEGION_REG_SCAN_F2_KHZ, 3000000);
    legion_reg_write(LEGION_REG_SCAN_DWELL_US, 400);
    legion_reg_write(LEGION_REG_SCAN_SURVEY_US, 400);
    legion_reg_write(LEGION_REG_SCAN_CTRL,
                     LEGION_SCAN_CTRL_EN | LEGION_SCAN_CTRL_SURVEY);
    legion_reg_write(LEGION_REG_FFT_CTRL,
                     LEGION_FFT_CTRL_EN | LEGION_FFT_CTRL_DC_NOTCH);
    CHECK("FFT SURVEY notch: AIR", legion_reg_write(LEGION_REG_AIR_PREP, 0x7));
    CHECK("FFT SURVEY notch: ARM", legion_reg_write(LEGION_REG_CTRL, CTRL_ARM_WD_LBG));
    t_status = 0;
    t_tamer = 1000;
    t_peak_word = 0;
    {
        int li;
        for (li = 0; li < 18; li++) {
            legion_work();
            t_tamer += 8;
            legion_work();
            if (li == 7) {
                t_status = LEGION_STATUS_DET_ACTIVE;
                t_peak_word = mk_peak(1, 0, 0x2000, 64);
                legion_work();
                t_peak_word = mk_peak(1, 1, 0x2000, 64);
                legion_work();
            } else {
                t_status = 0;
                t_peak_word = 0;
            }
            t_tamer += (uint64_t)56000000 * 5 / 1000;
            if (li == 17) {
                pio_n = 0;
            }
            legion_work();
        }
    }
    CHECK("FFT SURVEY notch: HDL stare без skip_dc",
          pio_wrote_reg(LEGION_REG_FFT_CTRL, LEGION_FFT_CTRL_EN));
    {
        uint32_t v = 0;
        legion_reg_read(LEGION_REG_FFT_CTRL, &v);
        CHECK("FFT SURVEY notch: тень хоста enable|notch",
              v == (LEGION_FFT_CTRL_EN | LEGION_FFT_CTRL_DC_NOTCH));
    }
    t_tamer += 8;
    legion_work(); /* stare unmute */
    pio_n = 0;
    t_tamer += (uint64_t)56000000 * 400 / 1000000 + 1;
    legion_work(); /* T → обзор, invalidate вернёт notch */
    CHECK("FFT SURVEY notch: после T HDL снова enable|notch",
          pio_wrote_reg(LEGION_REG_FFT_CTRL,
                        LEGION_FFT_CTRL_EN | LEGION_FFT_CTRL_DC_NOTCH));

    /* Отказ hop на stare: не FIRE/unmute на последней клетке обзора. */
    legion_reg_write(LEGION_REG_AIR_FREQ_KHZ, 2328000);
    legion_reg_write(LEGION_REG_SETTLE_N, 8);
    legion_reg_write(LEGION_REG_SCAN_F1_KHZ, 2300000);
    legion_reg_write(LEGION_REG_SCAN_F2_KHZ, 2500000);
    legion_reg_write(LEGION_REG_SCAN_DWELL_US, 400);
    legion_reg_write(LEGION_REG_SCAN_SURVEY_US, 400);
    legion_reg_write(LEGION_REG_SCAN_CTRL,
                     LEGION_SCAN_CTRL_EN | LEGION_SCAN_CTRL_SURVEY);
    legion_reg_write(LEGION_REG_FFT_CTRL, LEGION_FFT_CTRL_EN);
    CHECK("FFT SURVEY hopfail: AIR", legion_reg_write(LEGION_REG_AIR_PREP, 0x7));
    CHECK("FFT SURVEY hopfail: ARM", legion_reg_write(LEGION_REG_CTRL, CTRL_ARM_WD_LBG));
    t_status = 0;
    t_tamer = 1000;
    t_peak_word = 0;
    rfic_fail_tx_freq = false;
    {
        int li;
        for (li = 0; li < 4; li++) {
            legion_work();
            t_tamer += 8;
            legion_work();
            if (li == 0) {
                t_status = LEGION_STATUS_DET_ACTIVE;
                t_peak_word = mk_peak(1, 0, 0x2000, 128);
                legion_work();
                t_peak_word = mk_peak(1, 1, 0x2000, 128);
                legion_work();
            } else {
                t_status = 0;
                t_peak_word = 0;
            }
            t_tamer += (uint64_t)56000000 * 5 / 1000;
            if (li == 3) {
                rfic_fail_tx_freq = true;
                rfic_n = 0;
            }
            legion_work();
        }
    }
    CHECK("FFT SURVEY hopfail: unmute нет",
          rfic_idx(BLADERF_RFIC_COMMAND_TXMUTE, BLADERF_CHANNEL_TX(0), 0) < 0);
    {
        uint32_t khz = 0;
        legion_reg_read(LEGION_REG_AIR_FREQ_KHZ, &khz);
        CHECK("FFT SURVEY hopfail: LO остался на последней клетке 2496",
              khz == 2496000);
    }
    rfic_fail_tx_freq = false;
    rfic_n = 0;
    legion_work();
    {
        uint32_t khz = 0;
        legion_reg_read(LEGION_REG_AIR_FREQ_KHZ, &khz);
        CHECK("FFT SURVEY hopfail: повтор → clip LO 2328", khz == 2328000);
    }

    /* PARK+SURVEY: плитка 18 клеток, не середина 2500. */
    legion_reg_write(LEGION_REG_BAND_COUNT, 0);
    legion_reg_write(LEGION_REG_AIR_FREQ_KHZ, 2028000);
    legion_reg_write(LEGION_REG_AIR_FS_HZ, 56000000);
    legion_reg_write(LEGION_REG_AIR_BW_HZ, 56000000);
    legion_reg_write(LEGION_REG_SEARCH_BW_HZ, 56000000);
    legion_reg_write(LEGION_REG_SETTLE_N, 8);
    legion_reg_write(LEGION_REG_SCAN_F1_KHZ, 2000000);
    legion_reg_write(LEGION_REG_SCAN_F2_KHZ, 3000000);
    legion_reg_write(LEGION_REG_SCAN_DWELL_US, 400);
    legion_reg_write(LEGION_REG_SCAN_SURVEY_US, 5000000);
    legion_reg_write(LEGION_REG_SCAN_CTRL,
                     LEGION_SCAN_CTRL_EN | LEGION_SCAN_CTRL_PARK |
                     LEGION_SCAN_CTRL_SURVEY | LEGION_SCAN_CTRL_TURN);
    legion_reg_write(LEGION_REG_FFT_CTRL, LEGION_FFT_CTRL_EN);
    CHECK("FFT SURVEY ИИ 18: AIR", legion_reg_write(LEGION_REG_AIR_PREP, 0x7));
    CHECK("FFT SURVEY ИИ 18: ARM", legion_reg_write(LEGION_REG_CTRL, CTRL_ARM_WD_LBG));
    t_status = 0;
    t_tamer = 1000;
    t_peak_word = 0;
    {
        int li;
        for (li = 0; li < 18; li++) {
            legion_work();
            t_tamer += 8;
            legion_work();
            if (li == 7) {
                t_status = LEGION_STATUS_DET_ACTIVE;
                t_peak_word = mk_peak(1, 0, 0x2000, 64);
                legion_work();
                t_peak_word = mk_peak(1, 1, 0x2000, 64);
                legion_work();
            } else {
                t_status = 0;
                t_peak_word = 0;
            }
            t_tamer += (uint64_t)56000000 * 5 / 1000;
            legion_work();
        }
    }
    {
        uint32_t khz = 0;
        legion_reg_read(LEGION_REG_AIR_FREQ_KHZ, &khz);
        CHECK("FFT SURVEY ИИ: PARK не схлопнул — LO 2434, не 2500", khz == 2434000);
    }
    t_tamer += 8;
    legion_work(); /* stare unmute */
    t_status = LEGION_STATUS_DET_ACTIVE;
    t_peak_word = mk_peak(1, 0, 0x2000, 16);
    legion_work();
    t_peak_word = mk_peak(1, 1, 0x2000, 16);
    pio_n = 0;
    legion_work(); /* ordinary LOCK */
    {
        uint32_t khz = 0;
        uint32_t ev = 0;
        legion_reg_read(LEGION_REG_PEAK_KHZ, &khz);
        CHECK("FFT SURVEY ordinary: захват bin16 → 2437.5", khz == 2437500);
        legion_reg_read(LEGION_REG_SCAN_EVENT, &ev);
        CHECK("FFT SURVEY ordinary: событие LOCK", (ev & 0xffu) == LEGION_EVT_LOCK);
        CHECK("FFT SURVEY ordinary: HDL lock",
              pio_wrote_reg(LEGION_REG_FFT_CTRL,
                            LEGION_FFT_CTRL_EN | LEGION_FFT_CTRL_LOCK));
    }
    t_peak_word = mk_peak(1, 2, 0x4000, 32);
    legion_work();
    t_peak_word = mk_peak(1, 3, 0x4000, 32);
    legion_work();
    {
        uint32_t khz = 0;
        legion_reg_read(LEGION_REG_PEAK_KHZ, &khz);
        CHECK("FFT SURVEY ordinary: сильнее в выдержке не сбивает", khz == 2437500);
    }
    t_tamer += (uint64_t)56000000 * 400 / 1000000 + 1;
    t_peak_word = mk_peak(1, 4, 0x4000, 32);
    legion_work();
    {
        uint32_t khz = 0;
        uint32_t ev = 0;
        legion_reg_read(LEGION_REG_PEAK_KHZ, &khz);
        CHECK("FFT SURVEY ordinary: после выдержки берёт текущий пик", khz == 2441000);
        legion_reg_read(LEGION_REG_SCAN_EVENT, &ev);
        CHECK("FFT SURVEY ordinary: событие SWITCH", (ev & 0xffu) == LEGION_EVT_SWITCH);
    }
    t_tamer += (uint64_t)56000000 * 5000000 / 1000000 + 1;
    legion_work();
    {
        uint32_t ev = 0;
        legion_reg_read(LEGION_REG_SCAN_EVENT, &ev);
        CHECK("FFT SURVEY ordinary: после периода — RESURVEY",
              (ev & 0xffu) == LEGION_EVT_RESURVEY);
    }

    /* Приоритет: сильнее в выдержке — перескок и новая выдержка. */
    legion_reg_write(LEGION_REG_AIR_FREQ_KHZ, 2028000);
    legion_reg_write(LEGION_REG_SETTLE_N, 8);
    legion_reg_write(LEGION_REG_SCAN_F1_KHZ, 2000000);
    legion_reg_write(LEGION_REG_SCAN_F2_KHZ, 3000000);
    legion_reg_write(LEGION_REG_SCAN_DWELL_US, 400);
    legion_reg_write(LEGION_REG_SCAN_SURVEY_US, 5000000);
    legion_reg_write(LEGION_REG_SCAN_CTRL,
                     LEGION_SCAN_CTRL_EN | LEGION_SCAN_CTRL_PARK |
                     LEGION_SCAN_CTRL_SURVEY);
    legion_reg_write(LEGION_REG_FFT_CTRL, LEGION_FFT_CTRL_EN);
    CHECK("FFT SURVEY priority: AIR", legion_reg_write(LEGION_REG_AIR_PREP, 0x7));
    CHECK("FFT SURVEY priority: ARM", legion_reg_write(LEGION_REG_CTRL, CTRL_ARM_WD_LBG));
    t_status = 0;
    t_tamer = 1000;
    t_peak_word = 0;
    {
        int li;
        for (li = 0; li < 18; li++) {
            legion_work();
            t_tamer += 8;
            legion_work();
            if (li == 7) {
                t_status = LEGION_STATUS_DET_ACTIVE;
                t_peak_word = mk_peak(1, 0, 0x2000, 64);
                legion_work();
                t_peak_word = mk_peak(1, 1, 0x2000, 64);
                legion_work();
            } else {
                t_status = 0;
                t_peak_word = 0;
            }
            t_tamer += (uint64_t)56000000 * 5 / 1000;
            legion_work();
        }
    }
    t_tamer += 8;
    legion_work();
    t_status = LEGION_STATUS_DET_ACTIVE;
    t_peak_word = mk_peak(1, 0, 0x2000, 16);
    legion_work();
    t_peak_word = mk_peak(1, 1, 0x2000, 16);
    pio_n = 0;
    legion_work();
    {
        uint32_t khz = 0;
        uint32_t ev = 0;
        legion_reg_read(LEGION_REG_PEAK_KHZ, &khz);
        CHECK("FFT SURVEY priority: захват bin16", khz == 2437500);
        legion_reg_read(LEGION_REG_SCAN_EVENT, &ev);
        CHECK("FFT SURVEY priority: событие LOCK", (ev & 0xffu) == LEGION_EVT_LOCK);
        CHECK("FFT SURVEY priority: HDL lock",
              pio_wrote_reg(LEGION_REG_FFT_CTRL,
                            LEGION_FFT_CTRL_EN | LEGION_FFT_CTRL_LOCK));
    }
    pio_n = 0;
    t_peak_word = mk_peak(1, 2, 0x4000, 32);
    legion_work();
    {
        uint32_t khz = 0;
        uint32_t ev = 0;
        legion_reg_read(LEGION_REG_PEAK_KHZ, &khz);
        CHECK("FFT SURVEY priority: перескок на сильнее в выдержке", khz == 2441000);
        legion_reg_read(LEGION_REG_SCAN_EVENT, &ev);
        CHECK("FFT SURVEY priority: событие SWITCH", (ev & 0xffu) == LEGION_EVT_SWITCH);
        CHECK("FFT SURVEY priority: после перескока HDL lock",
              pio_wrote_reg(LEGION_REG_FFT_CTRL,
                            LEGION_FFT_CTRL_EN | LEGION_FFT_CTRL_LOCK));
    }
    t_peak_word = mk_peak(1, 4, 0x1000, 8);
    legion_work();
    t_peak_word = mk_peak(1, 5, 0x1000, 8);
    legion_work();
    {
        uint32_t khz = 0;
        legion_reg_read(LEGION_REG_PEAK_KHZ, &khz);
        CHECK("FFT SURVEY priority: слабее в новой выдержке не сбивает",
              khz == 2441000);
    }
    t_tamer += (uint64_t)56000000 * 400 / 1000000 + 1;
    t_peak_word = mk_peak(1, 6, 0x2000, 64);
    legion_work();
    {
        uint32_t khz = 0;
        uint32_t ev = 0;
        legion_reg_read(LEGION_REG_PEAK_KHZ, &khz);
        CHECK("FFT SURVEY priority: после выдержки не берёт слабее",
              khz == 2441000);
        legion_reg_read(LEGION_REG_SCAN_EVENT, &ev);
        CHECK("FFT SURVEY priority: после выдержки не SWITCH на слабее",
              (ev & 0xffu) == LEGION_EVT_SWITCH);
    }
    t_peak_word = mk_peak(1, 7, 0x5000, 80);
    legion_work();
    t_peak_word = mk_peak(1, 8, 0x5000, 80);
    legion_work();
    {
        uint32_t khz = 0;
        uint32_t ev = 0;
        legion_reg_read(LEGION_REG_PEAK_KHZ, &khz);
        CHECK("FFT SURVEY priority: сильнее после выдержки — снова перескок",
              khz == 2451500);
        legion_reg_read(LEGION_REG_SCAN_EVENT, &ev);
        CHECK("FFT SURVEY priority: снова SWITCH",
              (ev & 0xffu) == LEGION_EVT_SWITCH);
    }
    t_tamer += (uint64_t)56000000 * 5000000 / 1000000 + 1;
    legion_work();
    {
        uint32_t ev = 0;
        legion_reg_read(LEGION_REG_SCAN_EVENT, &ev);
        CHECK("FFT SURVEY priority: после периода — RESURVEY",
              (ev & 0xffu) == LEGION_EVT_RESURVEY);
    }

    /* U5: FFT/BAND readback не STATUS */
    legion_reg_write(LEGION_REG_SEARCH_BW_HZ, 56000000);
    legion_reg_write(LEGION_REG_FIRE_BW_HZ, 2000000);
    legion_reg_write(LEGION_REG_SETTLE_N, 16);
    legion_reg_write(LEGION_REG_BAND_IDX, 0);
    legion_reg_write(LEGION_REG_BAND_F1_KHZ, 2400000);
    legion_reg_write(LEGION_REG_BAND_F2_KHZ, 2410000);
    legion_reg_write(LEGION_REG_BAND_COUNT, 1);
    t_status = 0x00A50004u;
    {
        uint32_t v = 0;
        legion_reg_read(LEGION_REG_SEARCH_BW_HZ, &v);
        CHECK("U5: SEARCH_BW readback", v == 56000000);
        legion_reg_read(LEGION_REG_FIRE_BW_HZ, &v);
        CHECK("U5: FIRE_BW readback", v == 2000000);
        legion_reg_read(LEGION_REG_SETTLE_N, &v);
        CHECK("U5: SETTLE_N readback", v == 16);
        legion_reg_write(LEGION_REG_SCAN_SURVEY_US, 5000000);
        legion_reg_read(LEGION_REG_SCAN_SURVEY_US, &v);
        CHECK("U5: SCAN_SURVEY_US readback", v == 5000000);
        legion_reg_read(LEGION_REG_SCAN_EVENT, &v);
        CHECK("U5: SCAN_EVENT не STATUS", v != t_status);
        legion_reg_read(LEGION_REG_BAND_F1_KHZ, &v);
        CHECK("U5: BAND_F1 readback", v == 2400000);
        legion_reg_read(LEGION_REG_BAND_COUNT, &v);
        CHECK("U5: BAND_COUNT readback", v == 1);
        legion_reg_read(LEGION_REG_FFT_CTRL, &v);
        CHECK("U5: FFT_CTRL readback enable", (v & LEGION_FFT_CTRL_EN) != 0);
    }

    /* FFT выкл: n==1 снова «LO не шагает» */
    legion_reg_write(LEGION_REG_FFT_CTRL, 0);
    legion_reg_write(LEGION_REG_BAND_COUNT, 0);
    legion_reg_write(LEGION_REG_AIR_FREQ_KHZ, 2450000);
    legion_reg_write(LEGION_REG_AIR_FS_HZ, 56000000);
    legion_reg_write(LEGION_REG_AIR_BW_HZ, 56000000);
    legion_reg_write(LEGION_REG_SCAN_F1_KHZ, 2436000);
    legion_reg_write(LEGION_REG_SCAN_F2_KHZ, 2464000);
    legion_reg_write(LEGION_REG_SCAN_CTRL, LEGION_SCAN_CTRL_EN);
    CHECK("FFT off n==1: AIR", legion_reg_write(LEGION_REG_AIR_PREP, 0x7));
    CHECK("FFT off n==1: ARM", legion_reg_write(LEGION_REG_CTRL, CTRL_ARM_WD_LBG));
    t_status = 0;
    t_tamer = 1000;
    legion_work();
    rfic_n = 0;
    t_tamer += 10000000;
    legion_work();
    CHECK("FFT off n==1: LO не шагает", rfic_n == 0);
    legion_reg_write(LEGION_REG_SCAN_CTRL, 0);
    legion_reg_write(LEGION_REG_FFT_CTRL, 0);
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
    lms_tx_off_during_set = false;
    legion_work();
    CHECK("SCAN x40: тишина → lms RX+TX (2) и band_select RX+TX (2)",
          lms_n == 2 && band_n == 2);
    CHECK("SCAN x40: hop глушит LMS TX (bit2) на время PLL", lms_tx_off_during_set);
    CHECK("SCAN x40: CONTROL lms_rx/tx_enable живы", t_control == 0x6);
    {
        uint32_t khz = 0;
        legion_reg_read(LEGION_REG_AIR_FREQ_KHZ, &khz);
        CHECK("SCAN x40: AIR_FREQ после hop", khz == 2442000);
    }
    /* U4 x40: отказ TX PLL — AIR_FREQ не чужая; unmute только после отката RX. */
    lms_fail_tx = true;
    lms_tx_off_during_set = false;
    lms_n = 0;
    t_tamer += 140001;
    legion_work();
    CHECK("U4 x40: hop пытался LMS", lms_n >= 2);
    CHECK("U4 x40: PLL писался при снятом TX enable", lms_tx_off_during_set);
    {
        uint32_t khz = 0;
        legion_reg_read(LEGION_REG_AIR_FREQ_KHZ, &khz);
        CHECK("U4 x40: AIR_FREQ не сменилась на чужую стоянку", khz == 2442000);
    }
    CHECK("U4 x40: после отката RX на старый LO TX enable возвращён",
          (t_control & 0x4u) != 0);
    lms_fail_tx = false;
    lms_n = 0; band_n = 0;
    t_tamer = 50;
    legion_reg_write(LEGION_REG_SCAN_CTRL, LEGION_SCAN_CTRL_EN);
    legion_reg_write(LEGION_REG_CTRL, CTRL_ARM_WD_LBG);
    legion_work();
    lms_n = 0; band_n = 0;
    for (int k = 0; k < 20; k++) legion_work();
    CHECK("SCAN x40: tamer стоит → hop нет", lms_n == 0 && band_n == 0);
    legion_reg_write(LEGION_REG_SCAN_F1_KHZ, 2445000);
    legion_reg_write(LEGION_REG_SCAN_F2_KHZ, 2455000);
    legion_reg_write(LEGION_REG_SCAN_DWELL_US, 400);
    {
        uint32_t v = 0;
        legion_reg_read(LEGION_REG_SCAN_F1_KHZ, &v);
        CHECK("U5 x40: SCAN_F1 readback", v == 2445000);
        legion_reg_read(LEGION_REG_SCAN_DWELL_US, &v);
        CHECK("U5 x40: SCAN_DWELL readback", v == 400);
    }

    /* FFT x40: SEARCH глушит LMS TX (bit2), FIRE без hop — unmute, AIR=центр. */
    t_peak_word = 0;
    t_aws = 0;
    legion_reg_write(LEGION_REG_AIR_FREQ_KHZ, 2450000);
    legion_reg_write(LEGION_REG_AIR_FS_HZ, 56000000);
    legion_reg_write(LEGION_REG_AIR_BW_HZ, 56000000);
    legion_reg_write(LEGION_REG_SETTLE_N, 8);
    legion_reg_write(LEGION_REG_SCAN_F1_KHZ, 2436000);
    legion_reg_write(LEGION_REG_SCAN_F2_KHZ, 2464000);
    legion_reg_write(LEGION_REG_SCAN_CTRL, LEGION_SCAN_CTRL_EN);
    legion_reg_write(LEGION_REG_FFT_CTRL, LEGION_FFT_CTRL_EN);
    t_control = 0x6;
    CHECK("FFT x40: ARM", legion_reg_write(LEGION_REG_CTRL, CTRL_ARM_WD_LBG));
    t_status = 0;
    t_tamer = 1000;
    lms_n = 0; band_n = 0;
    legion_work(); /* SEARCH same LO → mute bit2 */
    CHECK("FFT x40: SEARCH снял LMS TX enable", (t_control & 0x4u) == 0);
    CHECK("FFT x40: SEARCH same-LO без LMS hop", lms_n == 0);
    t_tamer += 8;
    legion_work(); /* FRAME */
    t_status = LEGION_STATUS_DET_ACTIVE;
    t_peak_word = mk_peak(1, 0, 0x2000, 16);
    legion_work();
    t_peak_word = mk_peak(1, 1, 0x2000, 16);
    lms_n = 0; band_n = 0;
    legion_work();
    CHECK("FFT x40: FIRE без LMS hop", lms_n == 0 && band_n == 0);
    CHECK("FFT x40: FIRE вернул TX enable", (t_control & 0x4u) != 0);
    {
        uint32_t khz = 0;
        legion_reg_read(LEGION_REG_AIR_FREQ_KHZ, &khz);
        CHECK("FFT x40: AIR_FREQ = центр 2450", khz == 2450000);
        legion_reg_read(LEGION_REG_PEAK_KHZ, &khz);
        CHECK("FFT x40: PEAK_KHZ = 2453.5", khz == 2453500);
    }

    /* SURVEY x40: отказ hop на stare не должен вернуть LMS TX (U4 walker). */
    legion_reg_write(LEGION_REG_AIR_FREQ_KHZ, 2414000);
    legion_reg_write(LEGION_REG_AIR_FS_HZ, 28000000);
    legion_reg_write(LEGION_REG_AIR_BW_HZ, 28000000);
    legion_reg_write(LEGION_REG_SEARCH_BW_HZ, 28000000);
    legion_reg_write(LEGION_REG_SETTLE_N, 8);
    legion_reg_write(LEGION_REG_SCAN_F1_KHZ, 2400000);
    legion_reg_write(LEGION_REG_SCAN_F2_KHZ, 2450000);
    legion_reg_write(LEGION_REG_SCAN_DWELL_US, 400);
    legion_reg_write(LEGION_REG_SCAN_SURVEY_US, 400);
    legion_reg_write(LEGION_REG_SCAN_CTRL,
                     LEGION_SCAN_CTRL_EN | LEGION_SCAN_CTRL_SURVEY);
    legion_reg_write(LEGION_REG_FFT_CTRL, LEGION_FFT_CTRL_EN);
    t_control = 0x6;
    CHECK("FFT SURVEY x40 hopfail: ARM",
          legion_reg_write(LEGION_REG_CTRL, CTRL_ARM_WD_LBG));
    t_status = 0;
    t_tamer = 1000;
    t_peak_word = 0;
    lms_fail_tx = false;
    {
        int li;
        for (li = 0; li < 2; li++) {
            legion_work();
            t_tamer += 8;
            legion_work();
            if (li == 0) {
                t_status = LEGION_STATUS_DET_ACTIVE;
                t_peak_word = mk_peak(1, 0, 0x2000, 0);
                legion_work();
                t_peak_word = mk_peak(1, 1, 0x2000, 0);
                legion_work();
            } else {
                t_status = 0;
                t_peak_word = 0;
            }
            t_tamer += (uint64_t)28000000 * 5 / 1000;
            if (li == 1) {
                lms_fail_tx = true;
            }
            legion_work();
        }
    }
    CHECK("FFT SURVEY x40 hopfail: LMS TX остался снят",
          (t_control & 0x4u) == 0);
    lms_fail_tx = false;
    legion_reg_write(LEGION_REG_SCAN_CTRL, 0);
    legion_reg_write(LEGION_REG_FFT_CTRL, 0);
    legion_reg_write(LEGION_REG_CTRL, 0);
#endif

    printf(fails ? "NIOS WORK: %d FAILURES\n" : "NIOS WORK: ALL PASS\n", fails);
    return fails ? 1 : 0;
}
