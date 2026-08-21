// ============================================================================
// LEGION — host-тесты policy_math: allowlist, CUE, ток PA, интерлок нагрузки.
// Факты: пустой allowlist не ломает старый RF ON; CUE требует полосу.
// ============================================================================
#include <unity.h>

#include "policy_math.h"

using namespace legion;

static AllowBand ism[] = {{2400000000ULL, 2500000000ULL}};

void test_empty_allowlist_compat() {
  TEST_ASSERT_TRUE(hz_in_allowlist(2475000000ULL, nullptr, 0));
  TEST_ASSERT_TRUE(range_in_allowlist(2400000000ULL, 2500000000ULL, nullptr, 0));
  TEST_ASSERT_FALSE(cue_freq_allowed(2475000000ULL, nullptr, 0));
}

void test_hz_inside_band() {
  TEST_ASSERT_TRUE(hz_in_allowlist(2475000000ULL, ism, 1));
  TEST_ASSERT_TRUE(hz_in_allowlist(2400000000ULL, ism, 1));
  TEST_ASSERT_TRUE(hz_in_allowlist(2500000000ULL, ism, 1));
  TEST_ASSERT_FALSE(hz_in_allowlist(915000000ULL, ism, 1));
}

void test_range_must_fit_one_band() {
  TEST_ASSERT_TRUE(range_in_allowlist(2412000000ULL, 2484000000ULL, ism, 1));
  TEST_ASSERT_FALSE(range_in_allowlist(2300000000ULL, 2500000000ULL, ism, 1));
  TEST_ASSERT_FALSE(range_in_allowlist(2500000000ULL, 2400000000ULL, ism, 1));
}

void test_cue_requires_nonempty_hit() {
  TEST_ASSERT_TRUE(cue_freq_allowed(2440000000ULL, ism, 1));
  TEST_ASSERT_FALSE(cue_freq_allowed(433000000ULL, ism, 1));
}

void test_band_valid() {
  TEST_ASSERT_TRUE(allow_band_valid(1, 1));
  TEST_ASSERT_FALSE(allow_band_valid(0, 10));
  TEST_ASSERT_FALSE(allow_band_valid(20, 10));
}

void test_pa_current_range() {
  TEST_ASSERT_TRUE(pa_current_in_range(0));
  TEST_ASSERT_TRUE(pa_current_in_range(250));
  TEST_ASSERT_TRUE(pa_current_in_range(1500));
  TEST_ASSERT_FALSE(pa_current_in_range(1501));
}

void test_load_interlock() {
  TEST_ASSERT_TRUE(actuator_enable_allowed(true));
  TEST_ASSERT_FALSE(actuator_enable_allowed(false));
}

int main(int argc, char** argv) {
  (void)argc;
  (void)argv;
  UNITY_BEGIN();
  RUN_TEST(test_empty_allowlist_compat);
  RUN_TEST(test_hz_inside_band);
  RUN_TEST(test_range_must_fit_one_band);
  RUN_TEST(test_cue_requires_nonempty_hit);
  RUN_TEST(test_band_valid);
  RUN_TEST(test_pa_current_range);
  RUN_TEST(test_load_interlock);
  return UNITY_END();
}
