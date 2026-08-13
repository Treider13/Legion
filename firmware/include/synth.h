// ============================================================================
// LEGION — synth: единая точка доступа к ADF4351 под мьютексом.
// Гарантия эксклюзивности (cmd ↔ коридор) без гонок. Отклонение от первичного
// плана (очередь synthTask) сознательное: мьютекс даёт ту же гарантию с
// меньшим джиттером перестройки — критично для dwell 1 мс.
// ============================================================================
#pragma once

#include <Arduino.h>

#include "adf4351.h"
#include "freq_planner.h"

namespace legion {

void synth_init(Adf4351Driver& drv, PlannerConfig& cfg);

// Применить частоту: план → запись R5→R0 (под мьютексом).
// wait_lock=true: ждать LOCK до 50 мс с debounce (ручной режим).
// wait_lock=false: без ожидания (коридор; LD сэмплируется телеметрией).
// out_plan (опц.): копия применённого плана (для REGS?/диагностики).
PlanStatus synth_apply(uint64_t freq_hz, bool wait_lock, bool& lock,
                       SynthPlan* out_plan = nullptr);

// Быстрый путь для коридора (fast-scan): delta-запись относительно prev.
// prev == nullptr → полная запись R5→R0 (первый шаг сессии, известное
// состояние). Без ожидания LOCK (телеметрия сэмплирует LD отдельно).
// out_plan получает применённый план — вызывающий хранит его как prev.
PlanStatus synth_apply_fast(uint64_t freq_hz, const SynthPlan* prev,
                            SynthPlan& out_plan);

// Доступ к драйверу для read-only операций (LD).
Adf4351Driver& synth_driver();

// Эксклюзивный доступ для многошаговых операций (SELFTEST пишет драйвер
// напрямую — обязан держать мьютекс, иначе гонка с коридором; аудит п.1).
void synth_acquire();
void synth_release();

}  // namespace legion
