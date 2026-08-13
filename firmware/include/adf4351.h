// ============================================================================
// LEGION — драйвер ADF4351: SPI bit-bang на SFR (факт E1: ~10 МГц через
// GPIO.out_w1ts/w1tc против ~1–2 мкс у digitalWrite), порядок записи R5→R0
// (факт F3: R0 последним — double-buffered поля и band select).
// ============================================================================
#pragma once

#include <Arduino.h>

#include "board_pins.h"
#include "freq_planner.h"

namespace legion {

class Adf4351Driver {
 public:
  // Инициализация пинов. CE=LOW на старте (RF гашен до явной команды —
  // compliance: нет излучения после подачи питания).
  void begin();

  // Записать готовый план: строго R5, R4, R3, R2, R1, R0.
  void writePlan(const SynthPlan& plan);

  // Быстрая delta-запись: только изменившиеся регистры относительно prev,
  // R0 всегда последним (защёлка + band select). Логика выбора — reg_delta.h
  // (host-тест). Срезает время SPI-записи, физику ФАПЧ не обходит (fast-scan).
  void writePlanDelta(const SynthPlan& prev, const SynthPlan& cur);

  // Записать один регистр (32 бита, MSB first, LE-импульс).
  void writeRegister(uint32_t word);

  // Перезаписать только R2 (MUXOUT и пр.) — для SELFTEST без смены частоты.
  void writeR2(uint32_t r2) { writeRegister(r2); }

  // Lock Detect (MUXOUT в режиме digital LD).
  bool readLock();

  // Chip Enable.
  void setChipEnable(bool on);

 private:
  static inline void fastWrite(uint8_t pin, uint8_t level);
  bool _ce = false;
};

}  // namespace legion
