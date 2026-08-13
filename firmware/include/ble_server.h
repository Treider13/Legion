// ============================================================================
// LEGION — ble_server: BLE GATT-сервер (Nordic UART Service) — управление
// со смартфона (наследие joseluu/ADF_4351_BT_Smartphone, но NimBLE вместо
// классического BT и с нашим протоколом). Нет на ESP32-S2 (факт T5).
// ============================================================================
#pragma once

#include <Arduino.h>

#include "board_config.h"
#include "cmd_server.h"

namespace legion {

#if LEGION_HAS_BT

void ble_init(AppState& state, CmdServer& cmd);
void ble_broadcast(const char* line);  // телеметрия → notify подписчикам

#else  // ESP32-S2: без Bluetooth

inline void ble_init(AppState&, CmdServer&) {}
inline void ble_broadcast(const char*) {}

#endif

}  // namespace legion
