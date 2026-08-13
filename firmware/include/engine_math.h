// ============================================================================
// LEGION — engine_math: чистая математика движка частот (без Arduino) —
// host-тестируемо (pio test -e native).
// Режимы: SWEEP (линейный цикл), HOP (xorshift32 по сетке), CHIRP (мелкий шаг
// — FMCW-аппроксимация, факт S1: IEEE Access 2019), GLIDE (плавный переход,
// наследие Electro-resonance), FM SIN/TRI/RAND (ЧМ-паттерны, там же).
// ============================================================================
#pragma once

#include <cstdint>

namespace legion {

// --- SWEEP/CHIRP: следующая частота линейного цикла (с wrap-around) ---------
inline uint64_t engine_sweep_next(uint64_t cur, uint64_t f1, uint64_t f2,
                                  uint64_t step_hz) {
  cur += step_hz;
  return (cur > f2) ? f1 : cur;
}

// --- HOP: xorshift32 PRNG (детерминизм по seed — воспроизводимые тесты) -----
inline uint32_t engine_xorshift32(uint32_t& state) {
  state ^= state << 13;
  state ^= state >> 17;
  state ^= state << 5;
  return state;
}

// Следующая точка сетки [f1..f2] с шагом step_hz
inline uint64_t engine_hop_next(uint32_t& state, uint64_t f1, uint64_t f2,
                                uint64_t step_hz) {
  const uint64_t span_steps = (f2 - f1) / step_hz;
  const uint32_t r = engine_xorshift32(state);
  return f1 + (uint64_t)(r % (uint32_t)(span_steps + 1)) * step_hz;
}

// --- GLIDE: линейная интерполяция current→target за duration_ms -------------
// step_idx: 0..steps_total. Возвращает частоту на шаге.
inline uint64_t engine_glide_at(uint64_t from, uint64_t to, uint32_t step_idx,
                                uint32_t steps_total) {
  if (step_idx >= steps_total) {
    return to;
  }
  const int64_t delta = (int64_t)to - (int64_t)from;
  const int64_t v = (int64_t)from + (delta * (int64_t)step_idx) / (int64_t)steps_total;
  return (uint64_t)v;
}

// --- FM: мгновенное отклонение от центра ------------------------------------
// mode: 0=sin, 1=tri, 2=rand. t_ms — время, period_ms — период LFO.
// Возвращает отклонение в Гц в диапазоне [-depth_hz, +depth_hz].
double engine_fm_deviation(int mode, uint32_t t_ms, uint32_t period_ms,
                           double depth_hz, uint32_t& rand_state);

}  // namespace legion
