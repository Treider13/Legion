// ============================================================================
// LEGION — net_server: реализация (только для плат с WiFi).
//  - AP по умолчанию: SSID "LEGION", WPA2 "legion4351", IP 192.168.4.1
//  - WebSocket :81 — тот же ASCII-протокол (один парсер cmd_server)
//  - HTTP :80 — lite-UI из LittleFS (gzip-статика, факт E5: доказано Rf-Test-BJH)
// ============================================================================
#include "net_server.h"

#if LEGION_HAS_WIFI

#include <ArduinoWebsockets.h>
#include <HTTPUpdateServer.h>
#include <LittleFS.h>
#include <WebServer.h>
#include <WiFi.h>

#include "storage.h"

namespace legion {

using websockets::WebsocketsClient;
using websockets::WebsocketsMessage;
using websockets::WebsocketsServer;

static constexpr uint16_t WS_PORT = 81;
static constexpr const char* AP_SSID = "LEGION";
static constexpr const char* AP_PASS = "legion4351";  // WPA2, сменить в проде

static WebServer s_http(80);
static HTTPUpdateServer s_ota;  // OTA: POST /update (firmware.bin) — фаза 9
static WebsocketsServer s_ws;
static CmdServer* s_cmd = nullptr;
static AppState* s_state = nullptr;

// --- Print-адаптер: ответы команд в WS-клиента ------------------------------
class WSPrint : public Print {
 public:
  explicit WSPrint(WebsocketsClient& c) : _c(c) {}
  size_t write(uint8_t ch) override {
    _buf += (char)ch;
    if (ch == '\n') {
      flush();
    }
    return 1;
  }
  void flush() {
    if (_buf.length() > 0) {
      _c.send(_buf);
      _buf = "";
    }
  }

 private:
  WebsocketsClient& _c;
  String _buf;
};

static void onWsMessage(WebsocketsClient& client, WebsocketsMessage msg) {
  String data = msg.data();
  int start = 0;
  WSPrint out(client);
  while (start < (int)data.length()) {
    int nl = data.indexOf('\n', start);
    String line = (nl < 0) ? data.substring(start) : data.substring(start, nl);
    if (line.endsWith("\r")) {
      line.remove(line.length() - 1);
    }
    if (line.length() > 0) {
      char buf[160];
      line.toCharArray(buf, sizeof(buf));
      s_cmd->processLine(buf, out);
    }
    if (nl < 0) {
      break;
    }
    start = nl + 1;
  }
  out.flush();
}

static void startWifi() {
  PersistedState ps;
  storage_load(ps);
  if (ps.wifi_mode == 1 && ps.wifi_ssid[0] != '\0') {
    WiFi.mode(WIFI_STA);
    WiFi.begin(ps.wifi_ssid, ps.wifi_pass);
    Serial.print(F("WiFi STA connecting to "));
    Serial.println(ps.wifi_ssid);
  } else {
    WiFi.mode(WIFI_AP);
    WiFi.softAP(AP_SSID, AP_PASS);
    Serial.print(F("WiFi AP LEGION, ip="));
    Serial.println(WiFi.softAPIP());
  }
}

void net_init(AppState& state, CmdServer& cmd) {
  s_state = &state;
  s_cmd = &cmd;

  startWifi();

  // WebSocket :81
  s_ws.listen(WS_PORT);
  Serial.print(F("WS listen :"));
  Serial.println(WS_PORT);

  // OTA (фаза 9): POST /update с firmware.bin. Регистрируем ДО serveStatic
  // (wildcard), чтобы /update матчился первым. Таблица разделов app0/app1
  // (partitions_legion.csv) — OTA-безопасна.
  s_ota.setup(&s_http, "/update");
  Serial.println(F("OTA /update ready"));

  // HTTP :80 — статика из LittleFS (lite-UI)
  if (LittleFS.begin(true)) {
    s_http.serveStatic("/", LittleFS, "/");
    s_http.onNotFound([]() {
      s_http.send(404, "text/plain", "LEGION: not found");
    });
    s_http.begin();
    Serial.println(F("HTTP :80 (LittleFS)"));
  } else {
    Serial.println(F("LittleFS mount failed — HTTP off"));
  }
}

// Пул WS-клиентов (4 слота; лабораторный инструмент — достаточно)
static WebsocketsClient s_clients[4];
static bool s_used[4] = {false, false, false, false};

void net_loop() {
  s_http.handleClient();

  if (s_ws.poll()) {
    WebsocketsClient client = s_ws.accept();
    int slot = -1;
    for (int i = 0; i < 4; ++i) {
      if (!s_used[i] || !s_clients[i].available()) {
        slot = i;
        break;
      }
    }
    if (slot >= 0) {
      s_clients[slot] = client;
      s_used[slot] = true;
      s_clients[slot].onMessage(onWsMessage);
      Serial.println(F("WS client connected"));
    } else {
      client.close();  // пул полон
      Serial.println(F("WS pool full — rejected"));
    }
  }

  for (int i = 0; i < 4; ++i) {
    if (s_used[i]) {
      if (s_clients[i].available()) {
        s_clients[i].poll();
      } else {
        s_used[i] = false;
        Serial.println(F("WS client disconnected"));
      }
    }
  }
}

void net_broadcast(const char* line) {
  for (int i = 0; i < 4; ++i) {
    if (s_used[i] && s_clients[i].available()) {
      s_clients[i].send(line);
    }
  }
}

void net_wifi_cmd(AppState& s, char* arg, Print& out) {
  (void)s;
  char* save = nullptr;
  char* sub = strtok_r(arg, " ", &save);
  if (!sub) {
    out.println(F("ERR SYNTAX WIFI AP|STA|STATUS?"));
    return;
  }
  if (strcasecmp(sub, "STATUS?") == 0) {
    out.print(F("{\"wifi\":{\"mode\":\""));
    out.print(WiFi.getMode() == WIFI_AP ? F("AP") : F("STA"));
    out.print(F("\",\"ip\":\""));
    out.print(WiFi.getMode() == WIFI_AP ? WiFi.softAPIP().toString()
                                        : WiFi.localIP().toString());
    out.print(F("\",\"ssid\":\""));
    out.print(WiFi.getMode() == WIFI_AP ? F(AP_SSID) : WiFi.SSID());
    out.println(F("\"}}"));
    return;
  }
  if (strcasecmp(sub, "AP") == 0) {
    storage_save_wifi(0, "", "");
    WiFi.mode(WIFI_AP);
    WiFi.softAP(AP_SSID, AP_PASS);
    out.print(F("OK WIFI AP ip="));
    out.println(WiFi.softAPIP());
    return;
  }
  if (strcasecmp(sub, "STA") == 0) {
    char* ssid = strtok_r(nullptr, " ", &save);
    char* pass = strtok_r(nullptr, "", &save);
    if (!ssid || !pass) {
      out.println(F("ERR SYNTAX WIFI STA <ssid> <pass>"));
      return;
    }
    while (*pass == ' ') ++pass;
    storage_save_wifi(1, ssid, pass);
    WiFi.mode(WIFI_STA);
    WiFi.begin(ssid, pass);
    out.print(F("OK WIFI STA connecting "));
    out.println(ssid);
    return;
  }
  out.println(F("ERR SYNTAX WIFI AP|STA|STATUS?"));
}

}  // namespace legion

#endif  // LEGION_HAS_WIFI
