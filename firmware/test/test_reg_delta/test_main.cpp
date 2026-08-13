// ============================================================================
// LEGION — юнит-тесты reg_delta (host, native): выбор регистров для fast-scan.
// Инварианты: R0 всегда есть и последний; изменившиеся R5..R1 включены в
// порядке убывания; неизменившиеся (кроме R0) пропущены.
// ============================================================================
#include <unity.h>

#include <cstdint>

#include "reg_delta.h"

using namespace legion;

void test_only_r0_changes() {
  // Типичный шаг свипа: меняется только R0 (INT/FRAC)
  uint32_t prev[6] = {0x00000000, 0x11111111, 0x22222222,
                      0x33333333, 0x44444444, 0x55555555};
  uint32_t cur[6] = {0x0000AAA0, 0x11111111, 0x22222222,
                     0x33333333, 0x44444444, 0x55555555};
  int out[6];
  const int n = plan_delta_regs(prev, cur, out);
  TEST_ASSERT_EQUAL_INT(1, n);
  TEST_ASSERT_EQUAL_INT(0, out[0]);  // только R0
}

void test_r1_and_r0_change() {
  // Меняются R1 (MOD/FRAC) и R0 → пишем R1, потом R0
  uint32_t prev[6] = {0, 0x11111111, 0x22222222, 0x33333333, 0x44444444, 0x55555555};
  uint32_t cur[6] = {0xABCD, 0x1111FFFF, 0x22222222, 0x33333333, 0x44444444, 0x55555555};
  int out[6];
  const int n = plan_delta_regs(prev, cur, out);
  TEST_ASSERT_EQUAL_INT(2, n);
  TEST_ASSERT_EQUAL_INT(1, out[0]);  // R1 первым
  TEST_ASSERT_EQUAL_INT(0, out[1]);  // R0 последним
}

void test_r0_always_last_even_if_unchanged() {
  // Изменился только R4 (мощность) — R0 всё равно должен быть записан последним
  uint32_t prev[6] = {0xDEAD, 0x11111111, 0x22222222, 0x33333333, 0x44444444, 0x55555555};
  uint32_t cur[6] = {0xDEAD, 0x11111111, 0x22222222, 0x33333333, 0x4444FFFF, 0x55555555};
  int out[6];
  const int n = plan_delta_regs(prev, cur, out);
  TEST_ASSERT_EQUAL_INT(2, n);
  TEST_ASSERT_EQUAL_INT(4, out[0]);  // R4
  TEST_ASSERT_EQUAL_INT(0, out[1]);  // R0 последним
}

void test_all_change_descending() {
  uint32_t prev[6] = {0, 0, 0, 0, 0, 0};
  uint32_t cur[6] = {1, 2, 3, 4, 5, 6};
  int out[6];
  const int n = plan_delta_regs(prev, cur, out);
  TEST_ASSERT_EQUAL_INT(6, n);
  // Порядок R5,R4,R3,R2,R1,R0
  TEST_ASSERT_EQUAL_INT(5, out[0]);
  TEST_ASSERT_EQUAL_INT(4, out[1]);
  TEST_ASSERT_EQUAL_INT(3, out[2]);
  TEST_ASSERT_EQUAL_INT(2, out[3]);
  TEST_ASSERT_EQUAL_INT(1, out[4]);
  TEST_ASSERT_EQUAL_INT(0, out[5]);
}

void test_nothing_changes_still_writes_r0() {
  uint32_t prev[6] = {7, 7, 7, 7, 7, 7};
  uint32_t cur[6] = {7, 7, 7, 7, 7, 7};
  int out[6];
  const int n = plan_delta_regs(prev, cur, out);
  TEST_ASSERT_EQUAL_INT(1, n);
  TEST_ASSERT_EQUAL_INT(0, out[0]);  // R0 (band select re-trigger)
}

// «Симулятор чипа»: применяем delta-записи к состоянию чипа (= prev) и
// проверяем, что оно становится равно цели cur. Это ключевой инвариант
// корректности fast-scan: delta относительно РЕАЛЬНОГО состояния чипа всегда
// приводит чип к целевому плану (обоснование единого кэша в synth).
static void apply_delta_to_chip(uint32_t chip[6], const uint32_t cur[6]) {
  int out[6];
  const int n = plan_delta_regs(chip, cur, out);
  for (int i = 0; i < n; ++i) {
    chip[out[i]] = cur[out[i]];
  }
}

void test_delta_converges_to_target() {
  uint32_t chip[6] = {0, 0, 0, 0, 0, 0};
  uint32_t st = 0x1234567u;  // детерминированный xorshift
  for (int iter = 0; iter < 5000; ++iter) {
    uint32_t cur[6];
    for (int i = 0; i < 6; ++i) {
      st ^= st << 13; st ^= st >> 17; st ^= st << 5;
      // Часто повторяем часть регистров (реалистично: R2..R5 стабильны)
      cur[i] = (st % 4 == 0) ? chip[i] : st;
    }
    apply_delta_to_chip(chip, cur);
    TEST_ASSERT_EQUAL_MEMORY(cur, chip, sizeof(cur));  // чип == цель
  }
}

void test_delta_last_write_is_r0_always() {
  uint32_t st = 0xC0FFEEu;
  for (int iter = 0; iter < 2000; ++iter) {
    uint32_t prev[6], cur[6];
    for (int i = 0; i < 6; ++i) {
      st ^= st << 13; st ^= st >> 17; st ^= st << 5; prev[i] = st;
      st ^= st << 13; st ^= st >> 17; st ^= st << 5;
      cur[i] = (st % 3 == 0) ? prev[i] : st;
    }
    int out[6];
    const int n = plan_delta_regs(prev, cur, out);
    TEST_ASSERT(n >= 1 && n <= 6);
    TEST_ASSERT_EQUAL_INT(0, out[n - 1]);  // R0 всегда последний
    // Порядок строго убывающий среди записанных
    for (int i = 1; i < n; ++i) {
      TEST_ASSERT(out[i] < out[i - 1]);
    }
  }
}

int main(int argc, char** argv) {
  (void)argc;
  (void)argv;
  UNITY_BEGIN();
  RUN_TEST(test_only_r0_changes);
  RUN_TEST(test_r1_and_r0_change);
  RUN_TEST(test_r0_always_last_even_if_unchanged);
  RUN_TEST(test_all_change_descending);
  RUN_TEST(test_nothing_changes_still_writes_r0);
  RUN_TEST(test_delta_converges_to_target);
  RUN_TEST(test_delta_last_write_is_r0_always);
  return UNITY_END();
}
