// ============================================================================
// LEGION — sweep_engine: автономный движок частот.
// Режимы (фаза 3 + фаза 6):
//   SWEEP  — линейный коридор f1→f2, шаг, бесконечный цикл
//   HOP    — псевдослучайный хоппинг по сетке (xorshift32, seed)
//   CHIRP  — мелкий шаг (от 1 Гц) — FMCW-аппроксимация рампы (факт S1)
//   GLIDE  — плавный одноразовый переход current→target за duration
//            (наследие Electro-resonance/ADF4351-USB-Serial)
//   FM_SIN / FM_TRI / FM_RAND — ЧМ вокруг центральной (наследие там же)
// Факты: hw-тики FreeRTOS (баг joseluu >10мс — урок), перестройка ~40 мкс (E2),
// band select 20 мкс (F4), settling ~0.3 мс (F5) → dwell ≥ 1 мс; MTLD (F9).
// ============================================================================
#pragma once

#include <Arduino.h>

#include "adf4351.h"
#include "freq_planner.h"

namespace legion {

enum class CorridorMode : uint8_t {
  NONE = 0,
  SWEEP,
  HOP,
  CHIRP,
  GLIDE,
  FM_SIN,
  FM_TRI,
  FM_RAND,
};

struct CorridorConfig {
  uint64_t f1_hz = 2400000000ULL;   // начало / центр (FM)
  uint64_t f2_hz = 2500000000ULL;   // конец / цель (GLIDE)
  uint32_t step_hz = 1000000;       // шаг сетки (Гц)
  uint32_t dwell_ms = 10;           // темп шага; GLIDE: длительность; FM: период LFO
  uint32_t seed = 1;                // HOP/FM_RAND
  double fm_depth_hz = 100000.0;    // FM: глубина девиации (Гц)
  CorridorMode mode = CorridorMode::NONE;
};

constexpr uint32_t CORRIDOR_MIN_DWELL_MS = 1;  // band select + settling (F4/F5)
constexpr uint32_t CHIRP_MIN_STEP_HZ = 1;

void corridor_init(Adf4351Driver& drv, PlannerConfig& planner_cfg,
                   Stream& telem_port);

bool corridor_start(const CorridorConfig& cfg, char* err, size_t err_len);
void corridor_stop();
bool corridor_active();
CorridorMode corridor_mode();
uint64_t corridor_current_hz();
const CorridorConfig& corridor_config();

PlanStatus corridor_apply_fast(uint64_t freq_hz);

}  // namespace legion
