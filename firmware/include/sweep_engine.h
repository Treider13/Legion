// ============================================================================
// LEGION — sweep_engine: автономный коридор частот (SWEEP/HOP).
// Факты из исследования:
//  - Только hardware-таймер/тики FreeRTOS, НИКАКИХ блокирующих delay в логике
//    (баг joseluu: sweep ломался при шаге >10 мс из-за delay-архитектуры).
//  - Перестройка = запись R1/R0 ~40 мкс (E2) + band select 20 мкс (F4) +
//    settling ~0.1–0.3 мс (F5) → dwell ≥ 1 мс — безопасный минимум.
//  - MTLD=1 в коридоре: нет выбросов между шагами (F9, EngineerZone).
//  - Доступ к драйверу под мьютексом — эксклюзивность без гонок cmd↔sweep.
// ============================================================================
#pragma once

#include <Arduino.h>

#include "adf4351.h"
#include "freq_planner.h"

namespace legion {

enum class CorridorMode : uint8_t { NONE = 0, SWEEP, HOP };

struct CorridorConfig {
  uint64_t f1_hz = 2400000000ULL;
  uint64_t f2_hz = 2500000000ULL;
  uint32_t step_khz = 1000;  // шаг сетки, кГц
  uint32_t dwell_ms = 10;    // время на шаге (SWEEP) / темп (HOP), мс
  uint32_t seed = 1;         // seed PRNG (HOP)
  CorridorMode mode = CorridorMode::NONE;
};

// Минимальный dwell: band select + settling с запасом (факты F4/F5)
constexpr uint32_t CORRIDOR_MIN_DWELL_MS = 1;

// Инициализация (вызывается из setup): мьютекс драйвера + задачи.
void corridor_init(Adf4351Driver& drv, PlannerConfig& planner_cfg,
                   Stream& telem_port);

// Управление (потокобезопасно, из cmd-контекста).
// Возвращает false + причину в err при недопустимых параметрах.
bool corridor_start(const CorridorConfig& cfg, char* err, size_t err_len);
void corridor_stop();
bool corridor_active();
CorridorMode corridor_mode();
uint64_t corridor_current_hz();
const CorridorConfig& corridor_config();

// Быстрое применение частоты БЕЗ ожидания LOCK (для коридора; под мьютексом).
// LD сэмплируется асинхронно телеметрией (факт F12: DLD может опережать settle).
PlanStatus corridor_apply_fast(uint64_t freq_hz);

}  // namespace legion
