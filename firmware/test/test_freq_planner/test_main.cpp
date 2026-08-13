// ============================================================================
// LEGION — юнит-тесты freq_planner (host, PlatformIO native + Unity).
// Эталонные вектора кросс-проверены с pyadf435x (github.com/jhol/pyadf435x)
// и даташитом ADF4351 Rev. A. Включена «проклятая» частота 2175 МГц (KD0CQ).
// ============================================================================
#include <unity.h>

#include <cmath>
#include <cstdint>

#include "freq_planner.h"

using legion::ADF_FREQ_MIN_HZ;
using legion::PlannerConfig;
using legion::PlanStatus;
using legion::SynthPlan;
using legion::plan_frequency;

static SynthPlan plan_ok(uint64_t hz) {
  PlannerConfig cfg;
  SynthPlan p;
  TEST_ASSERT_EQUAL(PlanStatus::OK, plan_frequency(hz, cfg, p));
  return p;
}

// Декодирование полей из собранных регистров (проверка битовых карт)
static uint32_t dec_INT(const SynthPlan& p) { return (p.regs[0] >> 15) & 0xFFFF; }
static uint32_t dec_FRAC(const SynthPlan& p) { return (p.regs[0] >> 3) & 0xFFF; }
static uint32_t dec_MOD(const SynthPlan& p) { return (p.regs[1] >> 3) & 0xFFF; }
static uint32_t dec_PRESC(const SynthPlan& p) { return (p.regs[1] >> 27) & 1; }
static uint32_t dec_DIVSEL(const SynthPlan& p) { return (p.regs[4] >> 20) & 7; }

// --- Эталонные вектора (сверены с pyadf435x calculate_regs) -----------------

void test_vector_2475() {  // целевая частота пользователя — чистый int-N
  SynthPlan p = plan_ok(2475000000ULL);
  TEST_ASSERT_EQUAL_UINT16(99, p.int_val);
  TEST_ASSERT_EQUAL_UINT16(0, p.frac);
  TEST_ASSERT_EQUAL_UINT16(2, p.mod);
  TEST_ASSERT_EQUAL_UINT8(0, p.rf_div_sel);
  TEST_ASSERT_EQUAL_UINT8(0, p.prescaler_89);  // 2475 < 3600 → 4/5
  TEST_ASSERT_TRUE(p.integer_n);
  TEST_ASSERT_DOUBLE_WITHIN(0.5, 2475000000.0, p.actual_hz);
  TEST_ASSERT_EQUAL_UINT32(0x00318000UL, p.regs[0]);  // 99<<15
  TEST_ASSERT_EQUAL_UINT32(0x00580005UL, p.regs[5]);  // классика (даташит Fig.23)
}

void test_vector_2175() {  // «проклятая» частота KD0CQ: VCO 2175 < 2200 → div=2
  SynthPlan p = plan_ok(2175000000ULL);
  TEST_ASSERT_EQUAL_UINT16(174, p.int_val);  // НЕ 87! VCO=4350 МГц
  TEST_ASSERT_EQUAL_UINT16(0, p.frac);
  TEST_ASSERT_EQUAL_UINT8(1, p.rf_div_sel);
  TEST_ASSERT_DOUBLE_WITHIN(0.5, 2175000000.0, p.actual_hz);
}

void test_vector_corridor_edges() {  // границы коридора пользователя
  SynthPlan a = plan_ok(2400000000ULL);
  TEST_ASSERT_EQUAL_UINT16(96, a.int_val);
  TEST_ASSERT_EQUAL_UINT8(0, a.rf_div_sel);
  SynthPlan b = plan_ok(2500000000ULL);
  TEST_ASSERT_EQUAL_UINT16(100, b.int_val);
  TEST_ASSERT_EQUAL_UINT8(0, b.rf_div_sel);
}

void test_vector_4400_top() {  // верх диапазона → прескалер 8/9
  SynthPlan p = plan_ok(4400000000ULL);
  TEST_ASSERT_EQUAL_UINT16(176, p.int_val);
  TEST_ASSERT_EQUAL_UINT8(1, p.prescaler_89);
  TEST_ASSERT_DOUBLE_WITHIN(0.5, 4400000000.0, p.actual_hz);
}

void test_vector_100mhz() {  // div=32, VCO=3200
  SynthPlan p = plan_ok(100000000ULL);
  TEST_ASSERT_EQUAL_UINT8(5, p.rf_div_sel);
  TEST_ASSERT_EQUAL_UINT16(128, p.int_val);
  TEST_ASSERT_DOUBLE_WITHIN(0.5, 100000000.0, p.actual_hz);
}

void test_vector_35mhz() {  // низ диапазона: div=64, VCO=2240, frac-N
  SynthPlan p = plan_ok(35000000ULL);
  TEST_ASSERT_EQUAL_UINT8(6, p.rf_div_sel);
  TEST_ASSERT_EQUAL_UINT16(89, p.int_val);
  TEST_ASSERT_EQUAL_UINT16(3, p.frac);
  TEST_ASSERT_EQUAL_UINT16(5, p.mod);
  TEST_ASSERT_FALSE(p.integer_n);
  TEST_ASSERT_DOUBLE_WITHIN(0.5, 35000000.0, p.actual_hz);
}

void test_vector_146_835() {  // пример kb3gtn/STM32_ADF4351
  SynthPlan p = plan_ok(146835000ULL);
  TEST_ASSERT_EQUAL_UINT8(4, p.rf_div_sel);  // div=16, VCO=2349.36
  TEST_ASSERT_EQUAL_UINT16(93, p.int_val);
  TEST_ASSERT_EQUAL_UINT16(609, p.frac);
  TEST_ASSERT_EQUAL_UINT16(625, p.mod);
  TEST_ASSERT_DOUBLE_WITHIN(0.5, 146835000.0, p.actual_hz);
}

void test_vector_1296_5() {
  SynthPlan p = plan_ok(1296500000ULL);
  TEST_ASSERT_EQUAL_UINT16(103, p.int_val);
  TEST_ASSERT_EQUAL_UINT16(18, p.frac);
  TEST_ASSERT_EQUAL_UINT16(25, p.mod);
  TEST_ASSERT_DOUBLE_WITHIN(0.5, 1296500000.0, p.actual_hz);
}

// --- Битовые карты: декодирование регистров совпадает с полями плана --------

void test_register_field_decode() {
  SynthPlan p = plan_ok(2468241000ULL);  // «неудобная» частота
  TEST_ASSERT_EQUAL_UINT32(p.int_val, dec_INT(p));
  TEST_ASSERT_EQUAL_UINT32(p.frac, dec_FRAC(p));
  TEST_ASSERT_EQUAL_UINT32(p.mod, dec_MOD(p));
  TEST_ASSERT_EQUAL_UINT32(p.prescaler_89, dec_PRESC(p));
  TEST_ASSERT_EQUAL_UINT32(p.rf_div_sel, dec_DIVSEL(p));
  // Адресные биты (C3C2C1) каждого регистра
  for (int i = 0; i < 6; ++i) {
    TEST_ASSERT_EQUAL_UINT32(i, p.regs[i] & 0x7);
  }
}

// --- int-N биты по даташиту: LDF=1, LDP=1, ABP=1, charge cancel=1 -----------

void test_intn_bits() {
  SynthPlan pi = plan_ok(2475000000ULL);   // int-N
  TEST_ASSERT_TRUE(pi.regs[2] & (1UL << 8));   // LDF
  TEST_ASSERT_TRUE(pi.regs[2] & (1UL << 7));   // LDP
  TEST_ASSERT_TRUE(pi.regs[3] & (1UL << 22));  // ABP
  TEST_ASSERT_TRUE(pi.regs[3] & (1UL << 21));  // charge cancel
  // frac-N: 2475.01 МГц → rem=10000 Гц, gcd=10000 → MOD=2500, FRAC=1
  SynthPlan pf = plan_ok(2475010000ULL);
  TEST_ASSERT_EQUAL_UINT16(1, pf.frac);
  TEST_ASSERT_EQUAL_UINT16(2500, pf.mod);
  TEST_ASSERT_FALSE(pf.regs[2] & (1UL << 8));
  TEST_ASSERT_FALSE(pf.regs[2] & (1UL << 7));
  TEST_ASSERT_FALSE(pf.regs[3] & (1UL << 22));
  TEST_ASSERT_FALSE(pf.regs[3] & (1UL << 21));
}

// --- Fast band select: R3.DB23=1, divider=50 (500 кГц @ 25 МГц, факт F4) ----

void test_fast_band_select() {
  SynthPlan p = plan_ok(2475000000ULL);
  TEST_ASSERT_TRUE(p.regs[3] & (1UL << 23));
  TEST_ASSERT_EQUAL_UINT32(50, (p.regs[4] >> 12) & 0xFF);
}

// --- Свойство на сетке: точность и инварианты -------------------------------

void test_grid_accuracy() {
  PlannerConfig cfg;
  for (uint64_t mhz = 35; mhz <= 4400; mhz += 1) {
    SynthPlan p;
    TEST_ASSERT_EQUAL(PlanStatus::OK, plan_frequency(mhz * 1000000ULL, cfg, p));
    // Допуск: половина шага сетки MOD + 1 Гц
    const double tol = (double)p.pfd_hz / (2.0 * p.mod) + 1.0;
    TEST_ASSERT_DOUBLE_WITHIN(tol, (double)(mhz * 1000000ULL), p.actual_hz);
    TEST_ASSERT(p.mod >= 2 && p.mod <= 4095);
    TEST_ASSERT(p.frac < p.mod);
    TEST_ASSERT_EQUAL_UINT32(0x00580005UL, p.regs[5]);
    const uint32_t int_min = p.prescaler_89 ? 75 : 23;
    TEST_ASSERT(p.int_val >= int_min);
  }
}

void test_grid_odd_frequencies() {  // «неудобные» значения с кГц/Гц хвостами
  const uint64_t cases[] = {2475000123ULL, 86399999ULL, 123456789ULL,
                            2400000500ULL, 3999999999ULL, 34375000ULL};
  for (uint64_t hz : cases) {
    SynthPlan p = plan_ok(hz);
    const double tol = (double)p.pfd_hz / (2.0 * p.mod) + 1.0;
    TEST_ASSERT_DOUBLE_WITHIN(tol, (double)hz, p.actual_hz);
  }
}

// --- Ошибки диапазона --------------------------------------------------------

void test_range_errors() {
  PlannerConfig cfg;
  SynthPlan p;
  TEST_ASSERT_EQUAL(PlanStatus::ERR_RANGE,
                    plan_frequency(34000000ULL, cfg, p));  // < 34.375 МГц
  TEST_ASSERT_EQUAL(PlanStatus::ERR_RANGE,
                    plan_frequency(4400000001ULL, cfg, p));
  TEST_ASSERT_EQUAL(PlanStatus::OK,
                    plan_frequency(ADF_FREQ_MIN_HZ, cfg, p));  // ровно минимум
}

// --- Калибровка опорника (CAL REF) ------------------------------------------

void test_ppm_calibration() {
  PlannerConfig cfg;
  cfg.ref_ppm_milli = -1500;  // −1.5 ppm → 25 МГц × (−1.5e-6) = −37.5 Гц
  // Целочисленное усечение к нулю: −37 Гц
  TEST_ASSERT_EQUAL_UINT64(24999963ULL, legion::effective_ref_hz(cfg));
}

int main(int argc, char** argv) {
  (void)argc; (void)argv;
  UNITY_BEGIN();
  RUN_TEST(test_vector_2475);
  RUN_TEST(test_vector_2175);
  RUN_TEST(test_vector_corridor_edges);
  RUN_TEST(test_vector_4400_top);
  RUN_TEST(test_vector_100mhz);
  RUN_TEST(test_vector_35mhz);
  RUN_TEST(test_vector_146_835);
  RUN_TEST(test_vector_1296_5);
  RUN_TEST(test_register_field_decode);
  RUN_TEST(test_intn_bits);
  RUN_TEST(test_fast_band_select);
  RUN_TEST(test_grid_accuracy);
  RUN_TEST(test_grid_odd_frequencies);
  RUN_TEST(test_range_errors);
  RUN_TEST(test_ppm_calibration);
  return UNITY_END();
}
