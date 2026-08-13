// ============================================================================
// LEGION — sweep_engine: реализация (SWEEP/HOP/CHIRP/GLIDE/FM).
// Вся математика режимов — в engine_math (чистая, host-тестируемая).
// ============================================================================
#include "sweep_engine.h"

#include "engine_math.h"
#include "ble_server.h"
#include "leveling.h"
#include "net_server.h"
#include "serial_sync.h"
#include "synth.h"

namespace legion {

static PlannerConfig* s_planner = nullptr;
static Stream* s_telem = nullptr;

static CorridorConfig s_cfg;
static volatile bool s_active = false;
static uint64_t s_cur_hz = 0;
static uint32_t s_rand_state = 1;
// Мьютекс конфигурации/текущей частоты: s_cur_hz — 64 бита на 32-битном MCU,
// чтение/запись НЕ атомарны (torn reads между sweep_task и telem_task) —
// найдено при ревизии гонок (п.1). Все доступы под s_cfg_mtx.
static SemaphoreHandle_t s_cfg_mtx = nullptr;

// Fast-scan: предыдущий применённый план для delta-записи (только изменившиеся
// регистры + R0 последним). Сбрасывается на старте сессии коридора → первый
// шаг пишет полный план R5→R0 (известное состояние). См. reg_delta.h.
static SynthPlan s_prev_plan;
static bool s_prev_valid = false;

static void sweep_task(void*);
static void telem_task(void*);

void corridor_init(Adf4351Driver& drv, PlannerConfig& planner_cfg,
                   Stream& telem_port) {
  (void)drv;  // запись идёт через synth_apply (единый мьютекс)
  s_planner = &planner_cfg;
  s_telem = &telem_port;
  s_cfg_mtx = xSemaphoreCreateMutex();
  xTaskCreate(sweep_task, "legion_sweep", 4096, nullptr, 2, nullptr);
  xTaskCreate(telem_task, "legion_telem", 4096, nullptr, 1, nullptr);
}

PlanStatus corridor_apply_fast(uint64_t freq_hz) {
  SynthPlan plan;
  // Delta-запись относительно предыдущего шага (fast-scan); первый шаг сессии
  // (s_prev_valid=false) → полная запись. Физику ФАПЧ не обходит (F5).
  const PlanStatus st =
      synth_apply_fast(freq_hz, s_prev_valid ? &s_prev_plan : nullptr, plan);
  if (st == PlanStatus::OK) {
    s_prev_plan = plan;
    s_prev_valid = true;
    // Выравнивание уровня по калибровке (если включено) — PE43702 (F: dd1us).
    leveling_apply(freq_hz);
    xSemaphoreTake(s_cfg_mtx, portMAX_DELAY);
    s_cur_hz = freq_hz;
    xSemaphoreGive(s_cfg_mtx);
  }
  return st;
}

const char* corridor_mode_name(CorridorMode m) {  // публичная (cmdStatus)

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
  CorridorConfig cfg;  // локальный снимок конфигурации на цикл (анти-гонка)

  for (;;) {
    if (!s_active) {
      was_active = false;
      vTaskDelay(pdMS_TO_TICKS(20));
      continue;
    }
    if (!was_active) {  // старт цикла: снимок конфигурации под мьютексом
      xSemaphoreTake(s_cfg_mtx, portMAX_DELAY);
      cfg = s_cfg;
      xSemaphoreGive(s_cfg_mtx);
      f = cfg.f1_hz;
      s_rand_state = cfg.seed ? cfg.seed : 0x9E3779B9UL;
      glide_step = 0;
      fm_t = 0;
      last = xTaskGetTickCount();
      was_active = true;
    }

    corridor_apply_fast(f);

    // Темп: FM — обновление каждый 1 мс (плавная модуляция), остальные — dwell
    const uint32_t tick_ms = (cfg.mode >= CorridorMode::FM_SIN) ? 1 : cfg.dwell_ms;
    vTaskDelayUntil(&last, pdMS_TO_TICKS(tick_ms));

    switch (cfg.mode) {
      case CorridorMode::SWEEP:
      case CorridorMode::CHIRP:
        f = engine_sweep_next(f, cfg.f1_hz, cfg.f2_hz, cfg.step_hz);
        break;

      case CorridorMode::HOP:
        f = engine_hop_next(s_rand_state, cfg.f1_hz, cfg.f2_hz,
                            cfg.step_hz);
        break;

      case CorridorMode::GLIDE: {
        // Одноразовый переход за dwell_ms с шагом 1 мс
        const uint32_t total = cfg.dwell_ms;
        ++glide_step;
        if (glide_step >= total) {
          corridor_apply_fast(cfg.f2_hz);
          serial_lock();
          s_telem->println(F("{\"t\":0,\"event\":\"GLIDE DONE\"}"));
          serial_unlock();
          corridor_stop();  // полный стоп: флаг + MTLD off (не просто флаг)
          break;
        }
        f = engine_glide_at(cfg.f1_hz, cfg.f2_hz, glide_step, total);
        break;
      }

      case CorridorMode::FM_SIN:
      case CorridorMode::FM_TRI:
      case CorridorMode::FM_RAND: {
        fm_t += 1;
        const int m = cfg.mode == CorridorMode::FM_SIN
                          ? 0
                          : cfg.mode == CorridorMode::FM_TRI ? 1 : 2;
        const double dev =
            engine_fm_deviation(m, fm_t, cfg.dwell_ms,
                                cfg.fm_depth_hz, s_rand_state);
        int64_t nf = (int64_t)cfg.f1_hz + (int64_t)dev;
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
      // Чтение 64-битной частоты и режима под мьютексом (анти-torn-read)
      xSemaphoreTake(s_cfg_mtx, portMAX_DELAY);
      const uint64_t cur = s_cur_hz;
      const CorridorMode mode = s_cfg.mode;
      xSemaphoreGive(s_cfg_mtx);
      // JSON-телеметрия 10 Гц (поле "t" — маркер телеметрии для клиента)
      char line[96];
      snprintf(line, sizeof(line),
               "{\"t\":%lu,\"freq\":%.6f,\"lock\":%d,\"mode\":\"%s\"}",
               (unsigned long)millis(), cur / 1e6,
                   synth_driver().readLock() ? 1 : 0, corridor_mode_name(mode));
      serial_lock();            // UART под мьютексом: нет перемешивания с ответами
      s_telem->println(line);
      serial_unlock();
      net_broadcast(line);      // WS-клиенты (на H2 — no-op)
      ble_broadcast(line);      // BLE notify (на S2 — no-op)
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

  // Запись конфигурации и флага активности — атомарно (анти-гонка со
  // sweep_task); рестарт на ходу = корректная смена конфигурации.
  xSemaphoreTake(s_cfg_mtx, portMAX_DELAY);
  s_cfg = cfg;
  s_active = true;
  s_prev_valid = false;  // новая сессия → первый шаг пишет полный план R5→R0
  xSemaphoreGive(s_cfg_mtx);
  // MTLD в коридоре: гасим выход до захвата на каждом шаге (факт F9)
  s_planner->mute_till_lock = true;
  return true;
}

void corridor_stop() {
  xSemaphoreTake(s_cfg_mtx, portMAX_DELAY);
  s_active = false;
  xSemaphoreGive(s_cfg_mtx);
  if (s_planner) {
    s_planner->mute_till_lock = false;
  }
}

bool corridor_active() { return s_active; }

CorridorMode corridor_mode() {
  xSemaphoreTake(s_cfg_mtx, portMAX_DELAY);
  const CorridorMode m = s_cfg.mode;
  xSemaphoreGive(s_cfg_mtx);
  return m;
}

uint64_t corridor_current_hz() {
  xSemaphoreTake(s_cfg_mtx, portMAX_DELAY);
  const uint64_t v = s_cur_hz;
  xSemaphoreGive(s_cfg_mtx);
  return v;
}

const CorridorConfig& corridor_config() { return s_cfg; }

}  // namespace legion
