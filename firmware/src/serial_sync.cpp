#include "serial_sync.h"

#include <Arduino.h>

namespace legion {

static SemaphoreHandle_t s_serial_mtx = nullptr;
static SemaphoreHandle_t s_cmd_mtx = nullptr;

void serial_sync_init() {
  if (s_serial_mtx == nullptr) {
    s_serial_mtx = xSemaphoreCreateMutex();
  }
  if (s_cmd_mtx == nullptr) {
    s_cmd_mtx = xSemaphoreCreateMutex();
  }
}

void serial_lock() {
  if (s_serial_mtx) {
    xSemaphoreTake(s_serial_mtx, portMAX_DELAY);
  }
}

void serial_unlock() {
  if (s_serial_mtx) {
    xSemaphoreGive(s_serial_mtx);
  }
}

void cmd_lock() {
  if (s_cmd_mtx) {
    xSemaphoreTake(s_cmd_mtx, portMAX_DELAY);
  }
}

void cmd_unlock() {
  if (s_cmd_mtx) {
    xSemaphoreGive(s_cmd_mtx);
  }
}

}  // namespace legion
