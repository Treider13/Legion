// ============================================================================
// LEGION — synth: реализация единой точки доступа.
// ============================================================================
#include "synth.h"

namespace legion {

static Adf4351Driver* s_drv = nullptr;
static PlannerConfig* s_cfg = nullptr;
static SemaphoreHandle_t s_mtx = nullptr;

static constexpr uint32_t LOCK_TIMEOUT_MS = 50;
static constexpr uint8_t LOCK_DEBOUNCE = 5;

void synth_init(Adf4351Driver& drv, PlannerConfig& cfg) {
  s_drv = &drv;
  s_cfg = &cfg;
  s_mtx = xSemaphoreCreateMutex();
}

PlanStatus synth_apply(uint64_t freq_hz, bool wait_lock, bool& lock,
                       SynthPlan* out_plan) {
  SynthPlan plan;
  const PlanStatus st = plan_frequency(freq_hz, *s_cfg, plan);
  if (st != PlanStatus::OK) {
    return st;
  }

  xSemaphoreTake(s_mtx, portMAX_DELAY);
  s_drv->writePlan(plan);
  xSemaphoreGive(s_mtx);

  if (out_plan) {
    *out_plan = plan;
  }

  lock = false;
  if (wait_lock) {
    // band select 20 мкс (F4) + settling ~0.1–0.3 мс (F5); опрос до 50 мс,
    // 5 подряд HIGH — debounce (F12: DLD может сработать до полного settle)
    uint8_t streak = 0;
    const uint32_t t0 = millis();
    while (millis() - t0 < LOCK_TIMEOUT_MS) {
      if (s_drv->readLock()) {
        if (++streak >= LOCK_DEBOUNCE) {
          lock = true;
          break;
        }
      } else {
        streak = 0;
      }
      delay(1);
    }
  }
  return PlanStatus::OK;
}

Adf4351Driver& synth_driver() { return *s_drv; }

}  // namespace legion
