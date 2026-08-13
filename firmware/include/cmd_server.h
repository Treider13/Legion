// ============================================================================
// LEGION — cmd_server: парсер ASCII-протокола (docs/protocol.md) поверх UART.
// Фаза 1: HELLO / SET FREQ / SET POWER / RF ON|OFF / STATUS? / REGS? /
//         SELFTEST / CAL REF. (SWEEP/HOP — фаза 3.)
// ============================================================================
#pragma once

#include <Arduino.h>

#include "adf4351.h"
#include "freq_planner.h"
#include "sweep_engine.h"

namespace legion {

struct AppState {
  PlannerConfig cfg;
  SynthPlan plan;
  bool plan_valid = false;
  uint64_t freq_hz = 2475000000ULL;  // стартовая частота
  bool rf_on = false;                // RF выключен до явной команды (compliance)
  Adf4351Driver* drv = nullptr;
};

// Применить частоту: расчёт → запись R5→R0 → ожидание LOCK (debounce, F12).
// Возвращает статус планирования; lock — по ссылке (false, если таймаут).
PlanStatus apply_frequency(AppState& s, uint64_t freq_hz, bool& lock);

class CmdServer {
 public:
  void begin(AppState& state, Stream& port);
  void poll();  // вызывать из loop(); неблокирующий

 private:
  void handleLine(char* line);
  void cmdSetFreq(char* arg);
  void cmdSetPower(char* arg);
  void cmdRf(char* arg);
  void cmdStatus();
  void cmdRegs();
  void cmdCalRef(char* arg);
  void cmdSelftest();
  void cmdCorridor(char* arg, CorridorMode mode);

  AppState* _s = nullptr;
  Stream* _port = nullptr;
  char _buf[160];
  size_t _len = 0;
};

}  // namespace legion
