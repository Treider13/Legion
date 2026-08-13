// ============================================================================
// LEGION — sweep_engine: реализация (SWEEP/HOP/CHIRP/GLIDE/FM).
// Вся математика режимов — в engine_math (чистая, host-тестируемая).
// ============================================================================
#include "sweep_engine.h"

#include "engine_math.h"
#include "net_server.h"
#include "synth.h"

namespace legion {

static PlannerConfig* s_planner = nullptr;
static Stream* s_telem = nullptr;

static CorridorConfig s_cfg;
static volatile bool s_active = false;
static uint64_t s_cur_hz = 0;
static uint32_t s_rand_state = 1;

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

static const char* mode_name(CorridorMode m) {
  switch (m) {
    case CorridorMode::SWEEP: return "SWEEP";
    case CorridorMode::HOP: return "HOP";
    case CorridorMode::CHIRP: return "CHIRP";
    case CorridorMode::GLIDE: return "GLIDE";
    case CorridorMode::FM_SIN: return "FM_SIN";
    case CorridorMode::FM_TRI: return "FM_TRI";
    case CorridorMode::FM_RAND: return "FM_RAND";
    default: return "NONE";
  }
}

static void sweep_task(void*) {
  TickType_t last = xTaskGetTickCount();
  uint64_t f = 0;
  uint32_t glide_step = 0;
  uint32_t fm_t = 0;
  bool was_active = false;

  for (;;) {
    if (!s_active) {
      was_active = false;
      vTaskDelay(pdMS_TO_TICKS(20));
      continue;
    }
    if (!was_active) {  // старт цикла
      f = s_cfg.f1_hz;
      s_rand_state = s_cfg.seed ? s_cfg.seed : 0x9E3779B9UL;
      glide_step = 0;
      fm_t = 0;
      last = xTaskGetTickCount();
      was_active = true;
    }

    corridor_apply_fast(f);

    // Темп: FM — обновление каждый 1 мс (плавная модуляция), остальные — dwell
    const uint32_t tick_ms =
        (s_cfg.mode >= CorridorMode::FM_SIN) ? 1 : s_cfg.dwell_ms;
    vTaskDelayUntil(&last, pdMS_TO_TICKS(tick_ms));

    switch (s_cfg.mode) {
      case CorridorMode::SWEEP:
      case CorridorMode::CHIRP:
        f = engine_sweep_next(f, s_cfg.f1_hz, s_cfg.f2_hz, s_cfg.step_hz);
        break;

      case CorridorMode::HOP:
        f = engine_hop_next(s_rand_state, s_cfg.f1_hz, s_cfg.f2_hz,
                            s_cfg.step_hz);
        break;

      case CorridorMode::GLIDE: {
        // Одноразовый переход за dwell_ms с шагом 1 мс
        const uint32_t total = s_cfg.dwell_ms;
        ++glide_step;
        if (glide_step >= total) {
          corridor_apply_fast(s_cfg.f2_hz);
          s_active = false;  // авто-стоп в конце глайда
          s_telem->println(F("{\"t\":0,\"event\":\"GLIDE DONE\"}"));
          break;
        }
        f = engine_glide_at(s_cfg.f1_hz, s_cfg.f2_hz, glide_step, total);
        break;
      }

      case CorridorMode::FM_SIN:
      case CorridorMode::FM_TRI:
      case CorridorMode::FM_RAND: {
        fm_t += 1;
        const int m = s_cfg.mode == CorridorMode::FM_SIN
                          ? 0
                          : s_cfg.mode == CorridorMode::FM_TRI ? 1 : 2;
        const double dev =
            engine_fm_deviation(m, fm_t, s_cfg.dwell_ms,
                                s_cfg.fm_depth_hz, s_rand_state);
        int64_t nf = (int64_t)s_cfg.f1_hz + (int64_t)dev;
        if (nf < (int64_t)ADF_FREQ_MIN_HZ) nf = (int64_t)ADF_FREQ_MIN_HZ;
        if (nf > (int64_t)ADF_FREQ_MAX_HZ) nf = (int64_t)ADF_FREQ_MAX_HZ;
        f = (uint64_t)nf;
        break;
      }

      default:
        s_active = false;
        break;
    }
  }
}

static void telem_task(void*) {
  for (;;) {
    if (s_active && s_telem) {
      // JSON-телеметрия 10 Гц (поле "t" — маркер телеметрии для клиента)
      char line[96];
      snprintf(line, sizeof(line),
               "{\"t\":%lu,\"freq\":%.6f,\"lock\":%d,\"mode\":\"%s\"}",
               (unsigned long)millis(), s_cur_hz / 1e6,
               synth_driver().readLock() ? 1 : 0, mode_name(s_cfg.mode));
      s_telem->println(line);   // UART
      net_broadcast(line);      // WS-клиенты (на H2 — no-op)
    }
    vTaskDelay(pdMS_TO_TICKS(100));
  }
}

bool corridor_start(const CorridorConfig& cfg, char* err, size_t err_len) {
  // Валидация по режимам
  const bool is_fm = (cfg.mode >= CorridorMode::FM_SIN);
  const bool is_glide = (cfg.mode == CorridorMode::GLIDE);

  if (cfg.f1_hz < ADF_FREQ_MIN_HZ || cfg.f1_hz > ADF_FREQ_MAX_HZ) {
    snprintf(err, err_len, "ERR RANGE f1");
    return false;
  }
  if (!is_fm) {
    if (cfg.f2_hz > ADF_FREQ_MAX_HZ || cfg.f1_hz >= cfg.f2_hz) {
      snprintf(err, err_len, "ERR RANGE corridor");
      return false;
    }
  }
  if (cfg.step_hz < CHIRP_MIN_STEP_HZ && !is_glide && !is_fm) {
    snprintf(err, err_len, "ERR RANGE step >= 1 Hz");
    return false;
  }
  if (cfg.dwell_ms < CORRIDOR_MIN_DWELL_MS) {
    snprintf(err, err_len, "ERR DWELL min %lu ms",
             (unsigned long)CORRIDOR_MIN_DWELL_MS);
    return false;
  }
  if (is_fm) {
    // FM: центр ± глубина обязаны оставаться в диапазоне
    if (cfg.fm_depth_hz <= 0.0 ||
        cfg.f1_hz - (uint64_t)cfg.fm_depth_hz < ADF_FREQ_MIN_HZ ||
        cfg.f1_hz + (uint64_t)cfg.fm_depth_hz > ADF_FREQ_MAX_HZ) {
      snprintf(err, err_len, "ERR RANGE fm depth");
      return false;
    }
  }

  // Проверка достижимости крайних точек
  SynthPlan probe;
  if (plan_frequency(cfg.f1_hz, *s_planner, probe) != PlanStatus::OK) {
    snprintf(err, err_len, "ERR PLAN f1");
    return false;
  }
  if (!is_fm && plan_frequency(cfg.f2_hz, *s_planner, probe) != PlanStatus::OK) {
    snprintf(err, err_len, "ERR PLAN f2");
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
