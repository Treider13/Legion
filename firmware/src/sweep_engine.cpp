// ============================================================================
// LEGION — sweep_engine: реализация.
// Задачи FreeRTOS:
//   sweepTask — тики vTaskDelayUntil (tick = 1 кГц на Arduino-ESP32),
//               SWEEP: линейный перебор f1→f2 с шагом; HOP: xorshift32 по сетке.
//   telemTask — 10 Гц JSON-телеметрия в UART, пока коридор активен.
// ============================================================================
#include "sweep_engine.h"

#include "synth.h"

namespace legion {

static PlannerConfig* s_planner = nullptr;
static Stream* s_telem = nullptr;

static CorridorConfig s_cfg;
static volatile bool s_active = false;
static uint64_t s_cur_hz = 0;
static uint32_t s_hop_state = 1;

static void sweep_task(void*);
static void telem_task(void*);

void corridor_init(Adf4351Driver& drv, PlannerConfig& planner_cfg,
                   Stream& telem_port) {
  (void)drv;  // запись идёт через synth_apply (единый мьютекс)
  s_planner = &planner_cfg;
  s_telem = &telem_port;
  xTaskCreate(sweep_task, "legion_sweep", 4096, nullptr, 2, nullptr);
  xTaskCreate(telem_task, "legion_telem", 4096, nullptr, 1, nullptr);
}

PlanStatus corridor_apply_fast(uint64_t freq_hz) {
  bool lock_unused;
  const PlanStatus st = synth_apply(freq_hz, false, lock_unused);
  if (st == PlanStatus::OK) {
    s_cur_hz = freq_hz;
  }
  return st;
}

// xorshift32 — детерминированный PRNG с seed (воспроизводимый хоппинг)
static uint32_t xorshift32(uint32_t& state) {
  state ^= state << 13;
  state ^= state >> 17;
  state ^= state << 5;
  return state;
}

static void sweep_task(void*) {
  TickType_t last = xTaskGetTickCount();
  uint64_t f = 0;
  bool was_active = false;

  for (;;) {
    if (!s_active) {
      was_active = false;
      vTaskDelay(pdMS_TO_TICKS(20));
      continue;
    }
    if (!was_active) {  // старт цикла
      f = s_cfg.f1_hz;
      s_hop_state = s_cfg.seed ? s_cfg.seed : 0x9E3779B9UL;
      last = xTaskGetTickCount();
      was_active = true;
    }

    corridor_apply_fast(f);

    // Точный темп: vTaskDelayUntil от прошлого тика (без дрейфа)
    vTaskDelayUntil(&last, pdMS_TO_TICKS(s_cfg.dwell_ms));

    if (s_cfg.mode == CorridorMode::SWEEP) {
      f += (uint64_t)s_cfg.step_khz * 1000ULL;
      if (f > s_cfg.f2_hz) {
        f = s_cfg.f1_hz;  // бесконечный цикл (ТЗ)
      }
    } else {  // HOP: псевдослучайная точка сетки
      const uint64_t span_steps =
          (s_cfg.f2_hz - s_cfg.f1_hz) / ((uint64_t)s_cfg.step_khz * 1000ULL);
      const uint32_t r = xorshift32(s_hop_state);
      f = s_cfg.f1_hz + (uint64_t)(r % (uint32_t)(span_steps + 1)) *
                            (uint64_t)s_cfg.step_khz * 1000ULL;
    }
  }
}

static void telem_task(void*) {
  for (;;) {
    if (s_active && s_telem) {
      // JSON-телеметрия 10 Гц (поле "t" — маркер телеметрии для клиента)
      s_telem->print(F("{\"t\":"));
      s_telem->print(millis());
      s_telem->print(F(",\"freq\":"));
      s_telem->print(s_cur_hz / 1e6, 6);
      s_telem->print(F(",\"lock\":"));
      s_telem->print(synth_driver().readLock() ? 1 : 0);
      s_telem->print(F(",\"mode\":\""));
      s_telem->print(s_cfg.mode == CorridorMode::SWEEP ? F("SWEEP") : F("HOP"));
      s_telem->println(F("\"}"));
    }
    vTaskDelay(pdMS_TO_TICKS(100));
  }
}

bool corridor_start(const CorridorConfig& cfg, char* err, size_t err_len) {
  // Валидация (порядок — от дешёвых проверок к дорогим)
  if (cfg.f1_hz < ADF_FREQ_MIN_HZ || cfg.f2_hz > ADF_FREQ_MAX_HZ ||
      cfg.f1_hz >= cfg.f2_hz) {
    snprintf(err, err_len, "ERR RANGE corridor");
    return false;
  }
  if (cfg.step_khz < 1) {
    snprintf(err, err_len, "ERR RANGE step >= 1 kHz");
    return false;
  }
  if (cfg.dwell_ms < CORRIDOR_MIN_DWELL_MS) {
    snprintf(err, err_len, "ERR DWELL min %lu ms",
             (unsigned long)CORRIDOR_MIN_DWELL_MS);
    return false;
  }
  // Проверка достижимости крайних точек
  SynthPlan probe;
  if (plan_frequency(cfg.f1_hz, *s_planner, probe) != PlanStatus::OK ||
      plan_frequency(cfg.f2_hz, *s_planner, probe) != PlanStatus::OK) {
    snprintf(err, err_len, "ERR PLAN corridor edge");
    return false;
  }

  s_cfg = cfg;
  // MTLD в коридоре: гасим выход до захвата на каждом шаге (факт F9)
  s_planner->mute_till_lock = true;
  s_active = true;
  return true;
}

void corridor_stop() {
  s_active = false;
  if (s_planner) {
    s_planner->mute_till_lock = false;
  }
}

bool corridor_active() { return s_active; }
CorridorMode corridor_mode() { return s_cfg.mode; }
uint64_t corridor_current_hz() { return s_cur_hz; }
const CorridorConfig& corridor_config() { return s_cfg; }

}  // namespace legion
