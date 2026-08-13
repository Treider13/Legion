// ============================================================================
// LEGION — synth: реализация единой точки доступа.
// ============================================================================
#include "synth.h"

namespace legion {

static Adf4351Driver* s_drv = nullptr;
static PlannerConfig* s_cfg = nullptr;
static SemaphoreHandle_t s_mtx = nullptr;

// Кэш последнего ЗАПИСАННОГО в чип плана — источник истины для delta-записи
// (fast-scan). Обновляется ВСЕМИ путями записи через synth (полными и delta),
// поэтому delta всегда сравнивается с реальным состоянием чипа. Прямые записи
// драйвера мимо synth (SELFTEST) обязаны звать synth_invalidate_cache().
// Иначе — расхождение: delta пропустит регистр, реально отличающийся на чипе
// (даташит: все определяющие частоту регистры должны соответствовать цели).
static SynthPlan s_last_plan;
static bool s_last_valid = false;

static constexpr uint32_t LOCK_TIMEOUT_MS = 50;
static constexpr uint8_t LOCK_DEBOUNCE = 5;

void synth_init(Adf4351Driver& drv, PlannerConfig& cfg) {
  s_drv = &drv;
  s_cfg = &cfg;
  // Рекурсивный мьютекс: SELFTEST держит его и вызывает apply_frequency →
  // synth_apply (тот же мьютекс) из того же таска — нерекурсивный дал бы
  // дедлок (найдено при ревизии гонок, п.1).
  s_mtx = xSemaphoreCreateRecursiveMutex();
}

PlanStatus synth_apply(uint64_t freq_hz, bool wait_lock, bool& lock,
                       SynthPlan* out_plan) {
  SynthPlan plan;
  const PlanStatus st = plan_frequency(freq_hz, *s_cfg, plan);
  if (st != PlanStatus::OK) {
    return st;
  }

  xSemaphoreTakeRecursive(s_mtx, portMAX_DELAY);
  s_drv->writePlan(plan);
  s_last_plan = plan;  // кэш = реальное состояние чипа (под мьютексом)
  s_last_valid = true;
  xSemaphoreGiveRecursive(s_mtx);

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

PlanStatus synth_apply_fast(uint64_t freq_hz, SynthPlan& out_plan) {
  SynthPlan plan;
  const PlanStatus st = plan_frequency(freq_hz, *s_cfg, plan);
  if (st != PlanStatus::OK) {
    return st;
  }
  xSemaphoreTakeRecursive(s_mtx, portMAX_DELAY);
  if (s_last_valid) {
    // fast-scan: пишем только изменившиеся регистры относительно РЕАЛЬНОГО
    // состояния чипа (кэш), R0 всегда последним (reg_delta.h).
    s_drv->writePlanDelta(s_last_plan, plan);
  } else {
    s_drv->writePlan(plan);  // состояние чипа неизвестно → полная запись R5→R0
  }
  s_last_plan = plan;
  s_last_valid = true;
  xSemaphoreGiveRecursive(s_mtx);
  out_plan = plan;
  return PlanStatus::OK;
}

void synth_invalidate_cache() {
  xSemaphoreTakeRecursive(s_mtx, portMAX_DELAY);
  s_last_valid = false;  // следующий synth_apply_fast сделает полную запись
  xSemaphoreGiveRecursive(s_mtx);
}

Adf4351Driver& synth_driver() { return *s_drv; }

void synth_acquire() { xSemaphoreTakeRecursive(s_mtx, portMAX_DELAY); }
void synth_release() { xSemaphoreGiveRecursive(s_mtx); }

}  // namespace legion
