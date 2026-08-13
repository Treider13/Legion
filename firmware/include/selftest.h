// ============================================================================
// LEGION — SELFTEST: диагностика SPI без приборов (методика EngineerZone, F13)
//   Шаг 1: MUXOUT=DGND  → пин LD должен читать LOW
//   Шаг 2: MUXOUT=DVdd  → пин LD должен читать HIGH
//   Шаг 3: MUXOUT=DLD + частота 2475 МГц → LOCK=HIGH (только с реальным модулем)
// Шаги 1–2 ловят перепутанные пины модуля (факт M1) без осциллографа.
// ============================================================================
#pragma once

#include <Arduino.h>

#include "cmd_server.h"

namespace legion {

void selftest_run(AppState& s, Stream& out);

}  // namespace legion
