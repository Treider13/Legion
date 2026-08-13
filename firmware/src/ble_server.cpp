// ============================================================================
// LEGION — ble_server: реализация на NimBLE (h2zero/NimBLE-Arduino 2.5.x).
// NUS UUIDs (Nordic UART Service — стандарт для nRF Connect и прочих).
// ============================================================================
#include "ble_server.h"

#if LEGION_HAS_BT

#include <NimBLEDevice.h>

namespace legion {

// Nordic UART Service
static constexpr const char* NUS_SERVICE = "6E400001-B5A3-F393-E0A9-E50E24DCCA9E";
static constexpr const char* NUS_RX = "6E400002-B5A3-F393-E0A9-E50E24DCCA9E";  // write → нас
static constexpr const char* NUS_TX = "6E400003-B5A3-F393-E0A9-E50E24DCCA9E";  // notify → клиенту

static CmdServer* s_cmd = nullptr;
static NimBLECharacteristic* s_tx = nullptr;
static bool s_subscribed = false;

// Print-адаптер: ответы команд → TX notify
class BlePrint : public Print {
 public:
  size_t write(uint8_t ch) override {
    _buf += (char)ch;
    if (ch == '\n') {
      flush();
    }
    return 1;
  }
  void flush() {
    if (_buf.length() > 0 && s_tx && s_subscribed) {
      s_tx->notify((const uint8_t*)_buf.c_str(), _buf.length());
    }
    _buf = "";
  }

 private:
  String _buf;
};

class RxCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* pChar, NimBLEConnInfo& /*conn*/) override {
    const std::string val = pChar->getValue();
    if (val.empty() || !s_cmd) {
      return;
    }
    BlePrint out;
    // Кадр может содержать несколько строк
    String data(val.c_str());
    int start = 0;
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
};

class TxCallbacks : public NimBLECharacteristicCallbacks {
  void onSubscribe(NimBLECharacteristic*, NimBLEConnInfo&, uint16_t sub) override {
    s_subscribed = (sub != 0);
  }
};

class ServerCallbacks : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer*, NimBLEConnInfo&) override {
    Serial.println(F("BLE client connected"));
  }
  void onDisconnect(NimBLEServer*, NimBLEConnInfo&, int) override {
    Serial.println(F("BLE client disconnected"));
    s_subscribed = false;
    NimBLEDevice::startAdvertising();  // ре-адвертайзинг после отключения
  }
};

void ble_init(AppState& state, CmdServer& cmd) {
  (void)state;
  s_cmd = &cmd;

  NimBLEDevice::init("LEGION");
  NimBLEDevice::setPower(ESP_PWR_LVL_P3);  // +3 dBm — умеренно

  NimBLEServer* server = NimBLEDevice::createServer();
  server->setCallbacks(new ServerCallbacks());

  NimBLEService* service = server->createService(NUS_SERVICE);
  s_tx = service->createCharacteristic(NUS_TX, NIMBLE_PROPERTY::NOTIFY);
  s_tx->setCallbacks(new TxCallbacks());
  NimBLECharacteristic* rx =
      service->createCharacteristic(NUS_RX, NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR);
  rx->setCallbacks(new RxCallbacks());

  service->start();
  NimBLEAdvertising* adv = NimBLEDevice::getAdvertising();
  adv->addServiceUUID(NUS_SERVICE);
  adv->start();

  Serial.println(F("BLE NUS advertising (LEGION)"));
}

void ble_broadcast(const char* line) {
  if (s_tx && s_subscribed) {
    s_tx->notify((const uint8_t*)line, strlen(line));
  }
}

}  // namespace legion

#endif  // LEGION_HAS_BT
