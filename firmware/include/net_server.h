// ============================================================================
// LEGION — net_server: WiFi (AP/STA) + WebSocket-сервер + HTTP-статика
// (lite-UI из LittleFS). На ESP32-H2 WiFi нет (факт T5) — стабы-заглушки.
// ============================================================================
#pragma once

#include <Arduino.h>

#include "board_config.h"
#include "cmd_server.h"

namespace legion {

#if LEGION_HAS_WIFI

void net_init(AppState& state, CmdServer& cmd);
void net_loop();
void net_broadcast(const char* line);  // телеметрия → все WS-клиенты
void net_wifi_cmd(AppState& s, char* arg, Print& out);

#else  // ESP32-H2: без WiFi

inline void net_init(AppState&, CmdServer&) {}
inline void net_loop() {}
inline void net_broadcast(const char*) {}
inline void net_wifi_cmd(AppState&, char*, Print& out) {
  out.println(F("ERR STATE no wifi on this board"));
}

#endif

}  // namespace legion
