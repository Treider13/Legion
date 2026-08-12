// ============================================================================
// LEGION — ESP32 → ADF4351 RF synthesizer controller
// Фаза 0: скаффолд. Баннер + проверка компиляции на всех платах.
// Фаза 1: драйвер ADF4351, freq_planner, UART-протокол, SELFTEST.
// ============================================================================
#include <Arduino.h>

#include "board_config.h"
#include "board_pins.h"

#ifndef LEGION_VERSION
#define LEGION_VERSION "0.0.0-dev"
#endif
#ifndef LEGION_BUILD_BOARD
#define LEGION_BUILD_BOARD "unknown"
#endif

void setup() {
  Serial.begin(115200);
  // Платы с native USB CDC: даём хосту время поднять порт
#if LEGION_HAS_NATIVE_USB
  const uint32_t t0 = millis();
  while (!Serial && (millis() - t0 < 2000)) { /* wait for CDC */ }
#endif

  Serial.println();
  Serial.println(F("=============================================="));
  Serial.println(F(" LEGION // RF SYNTH CONTROL"));
  Serial.print(F(" version : ")); Serial.println(LEGION_VERSION);
  Serial.print(F(" board   : ")); Serial.println(LEGION_BUILD_BOARD);
  Serial.print(F(" wifi    : ")); Serial.println(LEGION_HAS_WIFI ? F("yes") : F("no"));
  Serial.print(F(" bt      : ")); Serial.println(LEGION_HAS_BT ? F("yes") : F("no"));
  Serial.print(F(" pins    : CLK=")); Serial.print(PIN_ADF_CLK);
  Serial.print(F(" DATA=")); Serial.print(PIN_ADF_DATA);
  Serial.print(F(" LE=")); Serial.print(PIN_ADF_LE);
  Serial.print(F(" LD=")); Serial.print(PIN_ADF_LD);
  Serial.print(F(" CE=")); Serial.println(PIN_ADF_CE);
  Serial.println(F("=============================================="));
  Serial.println(F("LEGION READY"));
}

void loop() {
  // Фаза 1: здесь появится cmdTask (парсер протокола).
  delay(100);
}
