// ============================================================================
// LEGION — PE43702: реализация. Код = round(dB / 0.25), 8 бит MSB first.
// ============================================================================
#include "attenuator.h"

#include <hal/gpio_ll.h>

#include "board_pins.h"

namespace legion {

static inline void attWrite(uint8_t pin, uint8_t level) {
  gpio_ll_set_level(&GPIO, (gpio_num_t)pin, level);
}

void Attenuator::begin() {
  pinMode(PIN_ATT_CLK, OUTPUT);
  pinMode(PIN_ATT_DATA, OUTPUT);
  pinMode(PIN_ATT_LE, OUTPUT);
  attWrite(PIN_ATT_CLK, 0);
  attWrite(PIN_ATT_DATA, 0);
  attWrite(PIN_ATT_LE, 0);
  setDb(0.0f);  // минимальное затухание при старте
}

float Attenuator::setDb(float db) {
  if (db < 0.0f) db = 0.0f;
  if (db > 31.75f) db = 31.75f;
  const uint8_t code = (uint8_t)(db / 0.25f + 0.5f);  // квантование 0.25 дБ
  _db = code * 0.25f;

  attWrite(PIN_ATT_LE, 0);
  for (int i = 7; i >= 0; --i) {  // MSB first
    attWrite(PIN_ATT_DATA, (code >> i) & 1U);
    attWrite(PIN_ATT_CLK, 1);
    attWrite(PIN_ATT_CLK, 0);
  }
  attWrite(PIN_ATT_LE, 1);  // защёлка
  ets_delay_us(1);
  attWrite(PIN_ATT_LE, 0);
  return _db;
}

}  // namespace legion
