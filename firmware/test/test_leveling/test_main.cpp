// ============================================================================
// LEGION — юнит-тесты leveling_math (host, native): интерполяция уровня,
// расчёт затухания PE43702, upsert калибровочной таблицы.
// ============================================================================
#include <unity.h>

#include <cmath>
#include <cstdint>

#include "leveling_math.h"

using namespace legion;

// Калибровка по мотивам замера dd1us: выход гуляет ~9 дБ по диапазону,
// пик +4 дБм в 2.4–3.4 ГГц. Значения — правдоподобная модель для тестов.
static LevelPoint g_cal[] = {
    {35.0, -4.0},   {433.92, -0.5}, {915.0, 0.0},
    {2400.0, 4.0},  {3400.0, 4.0},  {4400.0, -1.0},
};
static const int g_cal_n = 6;

void test_interp_endpoints_clamp() {
  // За краями — плато
  TEST_ASSERT_DOUBLE_WITHIN(1e-9, -4.0, lvl_interp_dbm(g_cal, g_cal_n, 10.0));
  TEST_ASSERT_DOUBLE_WITHIN(1e-9, -1.0, lvl_interp_dbm(g_cal, g_cal_n, 5000.0));
  // Точное попадание в узел
  TEST_ASSERT_DOUBLE_WITHIN(1e-9, 4.0, lvl_interp_dbm(g_cal, g_cal_n, 2400.0));
}

void test_interp_midpoint_linear() {
  // Середина между 915 (0 дБм) и 2400 (4 дБм) = 1657.5 МГц → ~2 дБм
  const double mid = lvl_interp_dbm(g_cal, g_cal_n, 1657.5);
  TEST_ASSERT_DOUBLE_WITHIN(1e-6, 2.0, mid);
}

void test_interp_empty_table() {
  TEST_ASSERT_DOUBLE_WITHIN(1e-9, 0.0, lvl_interp_dbm(nullptr, 0, 2400.0));
  TEST_ASSERT_DOUBLE_WITHIN(1e-9, 0.0, lvl_interp_dbm(g_cal, 0, 2400.0));
}

void test_required_atten_basic() {
  // Измерено +4, цель −1 → ослабить на 5 дБ
  TEST_ASSERT_DOUBLE_WITHIN(1e-9, 5.0, lvl_required_atten_db(4.0, -1.0));
  // Цель = измеренному → 0 дБ
  TEST_ASSERT_DOUBLE_WITHIN(1e-9, 0.0, lvl_required_atten_db(4.0, 4.0));
}

void test_required_atten_cannot_amplify() {
  // Цель ВЫШЕ измеренного — усилить нельзя, ослабление 0
  TEST_ASSERT_DOUBLE_WITHIN(1e-9, 0.0, lvl_required_atten_db(-4.0, 0.0));
}

void test_required_atten_clamp_max() {
  // Разница 40 дБ, но PE43702 максимум 31.75
  TEST_ASSERT_DOUBLE_WITHIN(1e-9, 31.75, lvl_required_atten_db(35.0, -5.0));
}

void test_required_atten_quantize() {
  // 5.1 дБ → квант 0.25 → 5.0 ... 5.13 → 5.25 (round)
  TEST_ASSERT_DOUBLE_WITHIN(1e-9, 5.0, lvl_required_atten_db(5.1, 0.0));
  TEST_ASSERT_DOUBLE_WITHIN(1e-9, 5.25, lvl_required_atten_db(5.13, 0.0));
  // Любой результат кратен 0.25
  for (double m = 0.0; m <= 10.0; m += 0.37) {
    const double db = lvl_required_atten_db(m, -5.0);
    const double q = db / 0.25;
    TEST_ASSERT_DOUBLE_WITHIN(1e-9, std::round(q), q);
  }
}

void test_atten_for_flat_output() {
  // Цель −4 дБм (= минимум по полосе). Проверяем, что выровненный уровень
  // (измеренный − затухание) не превышает цель нигде и близок к ней там,
  // где измеренный >= цели.
  const double target = -4.0;
  for (double f = 35.0; f <= 4400.0; f += 53.0) {
    const double measured = lvl_interp_dbm(g_cal, g_cal_n, f);
    const double att = lvl_atten_for(g_cal, g_cal_n, f, target);
    const double leveled = measured - att;
    // Не выше цели (в пределах кванта 0.25)
    TEST_ASSERT(leveled <= target + 0.25 + 1e-9);
    // Не проваливаемся больше чем на квант ниже цели, пока measured>=target
    if (measured >= target) {
      TEST_ASSERT(leveled >= target - 0.25 - 1e-9);
    }
  }
}

void test_upsert_insert_sorted() {
  LevelPoint t[8];
  int n = 0;
  n = lvl_upsert(t, n, 8, 2400.0, 4.0);
  n = lvl_upsert(t, n, 8, 35.0, -4.0);
  n = lvl_upsert(t, n, 8, 915.0, 0.0);
  TEST_ASSERT_EQUAL_INT(3, n);
  TEST_ASSERT_DOUBLE_WITHIN(1e-9, 35.0, t[0].freq_mhz);
  TEST_ASSERT_DOUBLE_WITHIN(1e-9, 915.0, t[1].freq_mhz);
  TEST_ASSERT_DOUBLE_WITHIN(1e-9, 2400.0, t[2].freq_mhz);
}

void test_upsert_replace() {
  LevelPoint t[8];
  int n = 0;
  n = lvl_upsert(t, n, 8, 2400.0, 4.0);
  n = lvl_upsert(t, n, 8, 2400.0, 1.5);  // замена
  TEST_ASSERT_EQUAL_INT(1, n);
  TEST_ASSERT_DOUBLE_WITHIN(1e-9, 1.5, t[0].dbm);
}

void test_upsert_full() {
  LevelPoint t[2];
  int n = 0;
  n = lvl_upsert(t, n, 2, 100.0, 1.0);
  n = lvl_upsert(t, n, 2, 200.0, 2.0);
  TEST_ASSERT_EQUAL_INT(2, n);
  TEST_ASSERT_EQUAL_INT(-1, lvl_upsert(t, n, 2, 300.0, 3.0));  // нет места
}

void test_single_point_flat() {
  // Одна точка → плато на всём диапазоне
  LevelPoint t[1] = {{915.0, 2.0}};
  TEST_ASSERT_DOUBLE_WITHIN(1e-9, 2.0, lvl_interp_dbm(t, 1, 35.0));
  TEST_ASSERT_DOUBLE_WITHIN(1e-9, 2.0, lvl_interp_dbm(t, 1, 4400.0));
  // Затухание до цели −1 дБм всюду = 3 дБ
  TEST_ASSERT_DOUBLE_WITHIN(1e-9, 3.0, lvl_atten_for(t, 1, 100.0, -1.0));
}

void test_atten_monotonic_in_measured() {
  // При фиксированной цели: чем выше измеренный уровень, тем больше затухание
  // (или равно из-за квантования/клампа) — физически обязательное свойство.
  const double target = -4.0;
  double prev = -1.0;
  for (double m = -4.0; m <= 20.0; m += 0.5) {
    const double db = lvl_required_atten_db(m, target);
    TEST_ASSERT(db >= prev - 1e-9);
    prev = db;
  }
}

void test_degenerate_equal_freq_points() {
  // Две точки с одинаковой частотой (после upsert такого не бывает, но
  // интерполятор не должен делить на ноль)
  LevelPoint t[2] = {{2400.0, 4.0}, {2400.0, 1.0}};
  const double v = lvl_interp_dbm(t, 2, 2400.0);
  TEST_ASSERT(v == 4.0 || v == 1.0);  // конечное значение, без NaN/inf
}

void test_interp_bounded_no_nan() {
  // Свойство: интерполяция всегда в пределах [min,max] значений таблицы и
  // конечна (без NaN/inf) для любых частот, включая за краями.
  const double lo = -4.0, hi = 4.0;  // из g_cal
  for (double f = -100.0; f <= 6000.0; f += 37.0) {
    const double v = lvl_interp_dbm(g_cal, g_cal_n, f);
    TEST_ASSERT(std::isfinite(v));
    TEST_ASSERT(v >= lo - 1e-9 && v <= hi + 1e-9);
  }
}

void test_upsert_keeps_sorted_random() {
  static const int CAP = 16;
  LevelPoint t[CAP];
  int n = 0;
  uint32_t st = 0xABCDEF01u;
  for (int i = 0; i < 300; ++i) {
    st ^= st << 13; st ^= st >> 17; st ^= st << 5;
    const double f = 35.0 + (double)(st % 4365000) / 1000.0;  // 35..4400 МГц
    st ^= st << 13; st ^= st >> 17; st ^= st << 5;
    const double d = -10.0 + (double)(st % 2000) / 100.0;
    const int r = lvl_upsert(t, n, CAP, f, d);
    if (r >= 0) n = r;
    // Инвариант: строго возрастающая по частоте (upsert заменяет дубликаты)
    for (int k = 1; k < n; ++k) {
      TEST_ASSERT(t[k].freq_mhz > t[k - 1].freq_mhz);
    }
    TEST_ASSERT(n <= CAP);
  }
}

int main(int argc, char** argv) {
  (void)argc;
  (void)argv;
  UNITY_BEGIN();
  RUN_TEST(test_interp_endpoints_clamp);
  RUN_TEST(test_interp_midpoint_linear);
  RUN_TEST(test_interp_empty_table);
  RUN_TEST(test_required_atten_basic);
  RUN_TEST(test_required_atten_cannot_amplify);
  RUN_TEST(test_required_atten_clamp_max);
  RUN_TEST(test_required_atten_quantize);
  RUN_TEST(test_atten_for_flat_output);
  RUN_TEST(test_upsert_insert_sorted);
  RUN_TEST(test_upsert_replace);
  RUN_TEST(test_upsert_full);
  RUN_TEST(test_single_point_flat);
  RUN_TEST(test_atten_monotonic_in_measured);
  RUN_TEST(test_degenerate_equal_freq_points);
  RUN_TEST(test_interp_bounded_no_nan);
  RUN_TEST(test_upsert_keeps_sorted_random);
  return UNITY_END();
}
