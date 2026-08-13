// ============================================================================
// LEGION — ESP32 → ADF4351 RF synthesizer controller
// Фаза 1: драйвер ADF4351 + freq_planner + UART-протокол + SELFTEST.
// ============================================================================
#include <Arduino.h>

#include "adf4351.h"
#include "ble_server.h"
#include "board_config.h"
#include "board_pins.h"
#include "cmd_server.h"
#include "net_server.h"
#include "storage.h"
#include "sweep_engine.h"
#include "synth.h"

#ifndef LEGION_VERSION
#define LEGION_VERSION "0.0.0-dev"
#endif
#ifndef LEGION_BUILD_BOARD
#define LEGION_BUILD_BOARD "unknown"
#endif

static legion::Adf4351Driver g_adf;
static legion::AppState g_state;
static legion::CmdServer g_cmd;

void setup() {
  Serial.begin(115200);
#if LEGION_HAS_NATIVE_USB
  const uint32_t t0 = millis();
  while (!Serial && (millis() - t0 < 2000)) { /* ждём USB CDC */ }
#endif

  g_adf.begin();  // CE=LOW: RF гашен до явной команды (compliance)
  g_state.drv = &g_adf;
  legion::synth_init(g_adf, g_state.cfg);
  legion::corridor_init(g_adf, g_state.cfg, Serial);
  g_cmd.begin(g_state, Serial);

  // --- NVS: восстановление состояния (автономность, паттерн joseluu) ---
  legion::storage_init();
  legion::PersistedState ps;
  legion::storage_load(ps);
  g_state.cfg.ref_ppm_milli = ps.ref_ppm_milli;
  g_state.cfg.output_power_code = ps.power_code;
  g_state.freq_hz = ps.freq_hz;
  {
    bool lock = false;
    legion::apply_frequency(g_state, ps.freq_hz, lock);  // частота с прошлого сеанса
    Serial.print(F("NVS restore freq="));
    Serial.print(ps.freq_hz / 1e6, 6);
    Serial.print(F(" LOCK="));
    Serial.println(lock ? 1 : 0);
  }
  // RF on/off НЕ восстанавливаем в ON — compliance: излучение только по команде.
  // Коридор — восстанавливаем (это и есть сценарий автономного коридора):
  if (ps.corridor_active) {
    char err[64];
    if (legion::corridor_start(ps.corridor, err, sizeof(err))) {
      Serial.println(F("NVS restore: corridor RUNNING"));
    } else {
      Serial.println(err);
    }
  }

  // --- WiFi + WebSocket + HTTP (нет на H2) ---
  legion::net_init(g_state, g_cmd);

  // --- BLE NUS (нет на S2) ---
  legion::ble_init(g_state, g_cmd);

  Serial.println();
  Serial.println(F("=============================================="));
  Serial.println(F(" LEGION // RF SYNTH CONTROL"));
  Serial.print(F(" version : "));
  Serial.println(LEGION_VERSION);
  Serial.print(F(" board   : "));
  Serial.println(LEGION_BUILD_BOARD);
  Serial.print(F(" pins    : CLK="));
  Serial.print(PIN_ADF_CLK);
  Serial.print(F(" DATA="));
  Serial.print(PIN_ADF_DATA);
  Serial.print(F(" LE="));
  Serial.print(PIN_ADF_LE);
  Serial.print(F(" LD="));
  Serial.print(PIN_ADF_LD);
  Serial.print(F(" CE="));
  Serial.println(PIN_ADF_CE);
  Serial.println(F("=============================================="));
  Serial.println(F("LEGION READY"));
}

void loop() {
  g_cmd.poll();
  legion::net_loop();
}
