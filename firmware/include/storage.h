// ============================================================================
// LEGION — storage: NVS-персистентность (паттерн joseluu: после reboot
// устройство восстанавливает режим автономно, ПК нужен только для изменений).
// NVS wear: пишем только по изменению (команды пользователя), не по тикам.
// ============================================================================
#pragma once

#include <Arduino.h>

#include "sweep_engine.h"

namespace legion {

struct PersistedState {
  uint64_t freq_hz;
  uint8_t power_code;
  bool rf_on;
  int32_t ref_ppm_milli;
  bool corridor_active;
  CorridorConfig corridor;
  // WiFi: 0=AP (дефолт), 1=STA
  uint8_t wifi_mode;
  char wifi_ssid[32];
  char wifi_pass[64];
};

void storage_init();
void storage_load(PersistedState& out);

void storage_save_freq(uint64_t hz);
void storage_save_power(uint8_t code);
void storage_save_rf(bool on);
void storage_save_ppm(int32_t ppm_milli);
void storage_save_corridor(bool active, const CorridorConfig& cfg);
void storage_save_wifi(uint8_t mode, const char* ssid, const char* pass);

}  // namespace legion
