// ============================================================================
// LEGION — policy_math: allowlist / нагрузка / ток PA / решение CUE.
// Чистый C++, без Arduino — host-тестируемо (pio test -e native).
//
// Совместимость (не ломаем фазу 1–10):
//   пустой allowlist → SET FREQ / RF ON / SWEEP без доп. ограничений;
//   load_ok по умолчанию true (как сейчас: RF ON не требует LOAD OK);
//   CUE — новый путь: требует НЕпустой allowlist и попадание в полосу.
// ============================================================================
#pragma once

#include <cstdint>

namespace legion {

struct AllowBand {
  uint64_t f1_hz;
  uint64_t f2_hz;  // включительно
};

static constexpr int ALLOW_MAX_BANDS = 8;
static constexpr uint32_t PA_I_MIN_MA = 0;
static constexpr uint32_t PA_I_MAX_MA = 1500;  // команда задатчику, не физика MMIC

inline bool allow_band_valid(uint64_t f1_hz, uint64_t f2_hz) {
  return f1_hz > 0 && f2_hz >= f1_hz;
}

inline bool hz_in_band(uint64_t hz, const AllowBand& b) {
  return hz >= b.f1_hz && hz <= b.f2_hz;
}

// Пустой список = без ограничения (обратная совместимость протокола).
inline bool hz_in_allowlist(uint64_t hz, const AllowBand* bands, int n) {
  if (n <= 0 || bands == nullptr) {
    return true;
  }
  for (int i = 0; i < n; ++i) {
    if (hz_in_band(hz, bands[i])) {
      return true;
    }
  }
  return false;
}

// Коридор целиком лежит хотя бы в одной полосе (консервативно).
inline bool range_in_allowlist(uint64_t f1_hz, uint64_t f2_hz,
                               const AllowBand* bands, int n) {
  if (n <= 0 || bands == nullptr) {
    return true;
  }
  if (f2_hz < f1_hz) {
    return false;
  }
  for (int i = 0; i < n; ++i) {
    if (f1_hz >= bands[i].f1_hz && f2_hz <= bands[i].f2_hz) {
      return true;
    }
  }
  return false;
}

// CUE — только заранее разрешённые полосы. Пустой список = отказ.
inline bool cue_freq_allowed(uint64_t hz, const AllowBand* bands, int n) {
  if (n <= 0 || bands == nullptr) {
    return false;
  }
  return hz_in_allowlist(hz, bands, n);
}

inline bool pa_current_in_range(uint32_t ma) {
  return ma >= PA_I_MIN_MA && ma <= PA_I_MAX_MA;
}

// PA ON / RF ON при явном LOAD FAULT — отказ. Пустой/OK — разрешено.
inline bool actuator_enable_allowed(bool load_ok) { return load_ok; }

}  // namespace legion
