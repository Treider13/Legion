// ============================================================================
// LEGION — юнит-тесты engine_math (host, native): SWEEP wrap, HOP
// детерминизм, GLIDE достижение цели, FM границы. Фаза 6.
// ============================================================================
#include <unity.h>

#include <cstdint>
#include <cstring>

#include "engine_math.h"

using namespace legion;

void test_sweep_next_wraps() {
  // 2400→2403 МГц шаг 1 МГц: 2400→2401→2402→2403→2400...
  uint64_t f = 2400000000ULL;
  f = engine_sweep_next(f, 2400000000ULL, 2403000000ULL, 1000000ULL);
  TEST_ASSERT_EQUAL_UINT64(2401000000ULL, f);
  f = engine_sweep_next(f, 2400000000ULL, 2403000000ULL, 1000000ULL);
  f = engine_sweep_next(f, 2400000000ULL, 2403000000ULL, 1000000ULL);
  TEST_ASSERT_EQUAL_UINT64(2403000000ULL, f);
  f = engine_sweep_next(f, 2400000000ULL, 2403000000ULL, 1000000ULL);
  TEST_ASSERT_EQUAL_UINT64(2400000000ULL, f);  // wrap
}

void test_chirp_fine_step() {  // шаг 100 Гц (FMCW-аппроксимация, S1)
  uint64_t f = engine_sweep_next(2400000000ULL, 2400000000ULL, 2401000000ULL,
                                 100ULL);
  TEST_ASSERT_EQUAL_UINT64(2400000100ULL, f);
}

void test_hop_deterministic_seed() {
  uint32_t s1 = 1337, s2 = 1337, s3 = 42;
  uint64_t seq1[8], seq2[8], seq3[8];
  for (int i = 0; i < 8; ++i) {
    seq1[i] = engine_hop_next(s1, 2400000000ULL, 2500000000ULL, 1000000ULL);
    seq2[i] = engine_hop_next(s2, 2400000000ULL, 2500000000ULL, 1000000ULL);
    seq3[i] = engine_hop_next(s3, 2400000000ULL, 2500000000ULL, 1000000ULL);
  }
  for (int i = 0; i < 8; ++i) {
    TEST_ASSERT_EQUAL_UINT64(seq1[i], seq2[i]);  // один seed → одна серия
    // все точки в коридоре и на сетке
    TEST_ASSERT(seq3[i] >= 2400000000ULL && seq3[i] <= 2500000000ULL);
    TEST_ASSERT_EQUAL_UINT64(0, (seq3[i] - 2400000000ULL) % 1000000ULL);
  }
  // разные seed → разные серии (с вероятностью ~1)
  TEST_ASSERT_FALSE(memcmp(seq1, seq3, sizeof(seq1)) == 0);
}

void test_glide_reaches_target() {
  const uint64_t from = 2400000000ULL, to = 2500000000ULL;
  const uint32_t total = 1000;  // 1000 мс
  TEST_ASSERT_EQUAL_UINT64(from, engine_glide_at(from, to, 0, total));
  TEST_ASSERT_EQUAL_UINT64(to, engine_glide_at(from, to, total, total));
  TEST_ASSERT_EQUAL_UINT64(to, engine_glide_at(from, to, total + 5, total));
  const uint64_t mid = engine_glide_at(from, to, total / 2, total);
  TEST_ASSERT_UINT64_WITHIN(1000000ULL, 2450000000ULL, mid);  // ±1 МГц
  // Монотонность
  uint64_t prev = from;
  for (uint32_t i = 1; i <= total; i += 100) {
    const uint64_t v = engine_glide_at(from, to, i, total);
    TEST_ASSERT(v >= prev);
    prev = v;
  }
}

void test_glide_down() {  // глайд вниз
  const uint64_t from = 2500000000ULL, to = 2400000000ULL;
  TEST_ASSERT_EQUAL_UINT64(from, engine_glide_at(from, to, 0, 100));
  TEST_ASSERT_EQUAL_UINT64(to, engine_glide_at(from, to, 100, 100));
  TEST_ASSERT(engine_glide_at(from, to, 50, 100) < from);
}

void test_fm_sin_bounds() {
  uint32_t rs = 1;
  const double depth = 100000.0;  // 100 кГц
  for (uint32_t t = 0; t < 1000; t += 7) {
    const double d = engine_fm_deviation(0, t, 100, depth, rs);
    TEST_ASSERT_DOUBLE_WITHIN(0.6, depth * sin(2.0 * M_PI * (t % 100) / 100.0), d);
    TEST_ASSERT(fabs(d) <= depth + 1e-6);
  }
  // t=0 → 0; t=period/4 → +depth
  TEST_ASSERT_DOUBLE_WITHIN(1.0, 0.0, engine_fm_deviation(0, 0, 100, depth, rs));
  TEST_ASSERT_DOUBLE_WITHIN(1.0, depth, engine_fm_deviation(0, 25, 100, depth, rs));
}

void test_fm_tri_bounds() {
  uint32_t rs = 1;
  const double depth = 50000.0;
  TEST_ASSERT_DOUBLE_WITHIN(1.0, -depth, engine_fm_deviation(1, 0, 100, depth, rs));
  TEST_ASSERT_DOUBLE_WITHIN(1.0, depth, engine_fm_deviation(1, 50, 100, depth, rs));
  TEST_ASSERT_DOUBLE_WITHIN(1.0, -depth,
                            engine_fm_deviation(1, 100, 100, depth, rs));
}

void test_fm_rand_bounds() {
  uint32_t rs = 1337;
  const double depth = 75000.0;
  for (int i = 0; i < 100; ++i) {
    const double d = engine_fm_deviation(2, i, 100, depth, rs);
    TEST_ASSERT(fabs(d) <= depth + 1e-6);
  }
}

int main(int argc, char** argv) {
  (void)argc; (void)argv;
  UNITY_BEGIN();
  RUN_TEST(test_sweep_next_wraps);
  RUN_TEST(test_chirp_fine_step);
  RUN_TEST(test_hop_deterministic_seed);
  RUN_TEST(test_glide_reaches_target);
  RUN_TEST(test_glide_down);
  RUN_TEST(test_fm_sin_bounds);
  RUN_TEST(test_fm_tri_bounds);
  RUN_TEST(test_fm_rand_bounds);
  return UNITY_END();
}
