// ============================================================================
// LEGION — драйвер ADF4351: реализация.
// Тайминги: даташит требует CLK high/low ≥ 25 нс; одна SFR-запись ~50 нс
// (факт E1) → бит ~100 нс ≈ 10 МГц, запас ×4 к пределу 20 МГц (факт F2).
// Между регистрами 1 мкс — полная перезапись ≈ 40 мкс (факт E2).
// ============================================================================
#include "adf4351.h"

#include <hal/gpio_ll.h>

namespace legion {

// Все наши пины < 32 на всех платах (board_pins.h).
static_assert(PIN_ADF_CLK < 32 && PIN_ADF_DATA < 32 && PIN_ADF_LE < 32,
              "fastWrite рассчитан на GPIO < 32");

inline void Adf4351Driver::fastWrite(uint8_t pin, uint8_t level) {
  // Официальный LL-путь IDF: одна запись в W1TS/W1TC на всех вариантах
  // (Xtensa и RISC-V). Проверено: прямое GPIO.out_w1ts= не компилируется
  // на RISC-V (C3/C6/H2) — там union-тип; gpio_ll_* портируемо.
  gpio_ll_set_level(&GPIO, (gpio_num_t)pin, level);
}

void Adf4351Driver::begin() {
  pinMode(PIN_ADF_CLK, OUTPUT);
  pinMode(PIN_ADF_DATA, OUTPUT);
  pinMode(PIN_ADF_LE, OUTPUT);
  pinMode(PIN_ADF_CE, OUTPUT);
  pinMode(PIN_ADF_LD, INPUT);

  // Исходное состояние: CLK=0, DATA=0, LE=0, CE=0 (RF выключен)
  fastWrite(PIN_ADF_CLK, 0);
  fastWrite(PIN_ADF_DATA, 0);
  fastWrite(PIN_ADF_LE, 0);
  fastWrite(PIN_ADF_CE, 0);
  _ce = false;
}

void Adf4351Driver::writeRegister(uint32_t word) {
  fastWrite(PIN_ADF_LE, 0);
  for (int i = 31; i >= 0; --i) {  // MSB first (даташит)
    fastWrite(PIN_ADF_DATA, (word >> i) & 1U);
    fastWrite(PIN_ADF_CLK, 1);
    fastWrite(PIN_ADF_CLK, 0);
  }
  fastWrite(PIN_ADF_DATA, 0);
  // LE-импульс: защёлка регистра по фронту (даташит Figure 2)
  fastWrite(PIN_ADF_LE, 1);
  ets_delay_us(1);
  fastWrite(PIN_ADF_LE, 0);
  ets_delay_us(1);
}

void Adf4351Driver::writePlan(const SynthPlan& plan) {
  // Строго R5→R0: R0 последний — double-buffered поля применяются записью R0,
  // и R0 триггерит VCO band select (факт F3, даташит Program Modes).
  for (int i = 5; i >= 0; --i) {
    writeRegister(plan.regs[i]);
  }
}

bool Adf4351Driver::readLock() { return digitalRead(PIN_ADF_LD) == HIGH; }

void Adf4351Driver::setChipEnable(bool on) {
  fastWrite(PIN_ADF_CE, on ? 1 : 0);
  _ce = on;
}

}  // namespace legion
