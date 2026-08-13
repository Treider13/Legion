// ============================================================================
// LEGION — engine_math: реализация FM-отклонений (sin/tri/rand).
// ============================================================================
#include "engine_math.h"

#include <math.h>

namespace legion {

double engine_fm_deviation(int mode, uint32_t t_ms, uint32_t period_ms,
                           double depth_hz, uint32_t& rand_state) {
  if (period_ms == 0) {
    period_ms = 1;
  }
  const double phase = (double)(t_ms % period_ms) / (double)period_ms;  // 0..1

  switch (mode) {
    case 0: {  // SIN
      return depth_hz * sin(2.0 * M_PI * phase);
    }
    case 1: {  // TRI: /\_/\_  (0→+depth→−depth→0)
      const double tri = phase < 0.5 ? (phase * 4.0 - 1.0) : (3.0 - phase * 4.0);
      return depth_hz * tri;
    }
    default: {  // RAND: случайное смещение каждый период (по тику вызывающего)
      const uint32_t r = engine_xorshift32(rand_state);
      return depth_hz * ((double)(r % 20001) / 10000.0 - 1.0);
    }
  }
}

}  // namespace legion
