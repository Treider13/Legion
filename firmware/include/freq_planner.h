// ============================================================================
// LEGION — freq_planner: частота (Гц) → шесть 32-битных регистров ADF4351
// Чистый C++ без Arduino-зависимостей — компилируется и на хосте (юнит-тесты).
//
// Битовые карты сверены с первичным источником — даташитом ADF4351 Rev. A
// (Figure 23, Register Summary) и эталоном pyadf435x (github.com/jhol/pyadf435x):
//   R0 = INT<<15 | FRAC<<3 | 0
//   R1 = PHADJ<<28 | PRESC<<27 | PHASE<<15 | MOD<<3 | 1
//   R2 = LNSPUR<<29 | MUX<<26 | DBLR<<25 | RDIV2<<24 | R<<14 | DBB<<13
//        | CP<<9 | LDF<<8 | LDP<<7 | PDPOL<<6 | PD<<5 | CP3S<<4 | CRST<<3 | 2
//   R3 = BSCMODE<<23 | ABP<<22 | CHGCANCEL<<21 | CSR<<18 | CDIVMODE<<15
//        | CDIV<<3 | 3
//   R4 = FBSEL<<23 | DIVSEL<<20 | BSDIV<<12 | VCOPD<<11 | MTLD<<10
//        | AUXSEL<<9 | AUXEN<<8 | AUXPWR<<6 | RFEN<<5 | PWR<<3 | 4
//   R5 = LDPIN<<22 | 3<<19 | 5   (= 0x00580005 при LDPIN=1 — классика)
// ============================================================================
#pragma once

#include <cstdint>

namespace legion {

// Пределы ADF4351 (даташит)
constexpr uint64_t ADF_FREQ_MIN_HZ = 34375000ULL;    // 2200 МГц / 64
constexpr uint64_t ADF_FREQ_MAX_HZ = 4400000000ULL;  // 4.4 ГГц
constexpr uint64_t ADF_VCO_MIN_HZ = 2200000000ULL;
constexpr uint64_t ADF_VCO_MAX_HZ = 4400000000ULL;
constexpr uint64_t ADF_PFD_MAX_FRAC_HZ = 32000000ULL;  // frac-N
constexpr uint64_t ADF_PFD_MAX_INT_HZ = 90000000ULL;   // int-N
constexpr uint64_t ADF_PRESCALER_89_ABOVE_HZ = 3600000000ULL;  // >3.6 ГГц → 8/9
constexpr uint16_t ADF_INT_MIN_45 = 23;  // прескалер 4/5
constexpr uint16_t ADF_INT_MIN_89 = 75;  // прескалер 8/9

struct PlannerConfig {
  uint64_t ref_hz = 25000000ULL;  // опорник модуля (TCXO 25 МГц)
  int32_t ref_ppm_milli = 0;      // калибровка опорника в милли-ppm (CAL REF)
  uint16_t r_counter = 1;         // R: 1..1023
  bool ref_doubler = false;       // D
  bool ref_div2 = false;          // T
  uint8_t cp_current_code = 7;    // 2.50 мА — середина, рекомендация cheatsheet
  uint8_t output_power_code = 3;  // +5 дБм (0=−4, 1=−1, 2=+2, 3=+5)
  bool rf_output_enable = true;
  bool mute_till_lock = false;  // MTLD — включаем в режиме коридора (факт F9)
};

struct SynthPlan {
  uint32_t regs[6];     // R0..R5, готовые 32-битные слова
  uint16_t int_val;     // 16 бит
  uint16_t frac;        // 12 бит
  uint16_t mod;         // 12 бит
  uint8_t rf_div_sel;   // 0..6 → делитель 2^sel (1..64)
  uint8_t prescaler_89;  // 0 = 4/5, 1 = 8/9
  bool integer_n;       // финальный FRAC == 0
  uint64_t pfd_hz;      // фактическая частота сравнения фазового детектора
  uint64_t vco_hz;      // частота VCO до выходного делителя
  double actual_hz;     // фактическая выходная частота
  double error_hz;      // actual_hz − requested_hz
};

enum class PlanStatus : uint8_t {
  OK = 0,
  ERR_RANGE,      // частота вне 34.375–4400 МГц
  ERR_INT_RANGE,  // INT вне пределов для выбранного прескалера
  ERR_PFD,        // fPFD вне допустимого диапазона режима
  ERR_CONFIG,     // некорректная конфигурация (R=0 и т.п.)
};

// Главная функция: freq_hz → SynthPlan (регистры + диагностика).
PlanStatus plan_frequency(uint64_t freq_hz, const PlannerConfig& cfg,
                          SynthPlan& out);

// Точный обратный расчёт выходной частоты из полей плана (для тестов/логов).
double plan_output_hz(const SynthPlan& p);

// Эффективная частота опорника с учётом ppm-калибровки.
uint64_t effective_ref_hz(const PlannerConfig& cfg);

}  // namespace legion
