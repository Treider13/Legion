// ============================================================================
// LEGION — freq_planner: реализация. Вся математика в uint64_t (факт: на
// ESP32 нативный 64-бит, BigNumber не нужен — отличие от dfannin/adf4351).
//
// Метод MOD/FRAC: точный через gcd(fPFD, rem) — если MOD ≤ 4095, частота
// достигается БЕЗ ошибки; иначе fallback MOD=4095 с округлением и честным
// error_hz. Строго лучше pyadf435x (там MOD=round(1000×fPFD_MHz) мог
// превысить 4095 и упасть в make_regs).
// ============================================================================
#include "freq_planner.h"

namespace legion {

static uint64_t gcd64(uint64_t a, uint64_t b) {
  while (b) {
    uint64_t t = a % b;
    a = b;
    b = t;
  }
  return a;
}

uint64_t effective_ref_hz(const PlannerConfig& cfg) {
  // ref × (1 + ppm_milli / 1e9). ВАЖНО: сначала приводим ref к int64 —
  // иначе uint64 × int64 молча уходит в unsigned (убыток знака, переполнение).
  const int64_t corr =
      (((int64_t)cfg.ref_hz * (int64_t)cfg.ref_ppm_milli) / 1000000000LL);
  return (uint64_t)((int64_t)cfg.ref_hz + corr);
}

static uint64_t pfd_hz_of(const PlannerConfig& cfg) {
  const uint64_t ref = effective_ref_hz(cfg);
  const uint64_t num = ref * (cfg.ref_doubler ? 2ULL : 1ULL);
  const uint64_t den = (uint64_t)cfg.r_counter * (cfg.ref_div2 ? 2ULL : 1ULL);
  return den ? (num / den) : 0;
}

double plan_output_hz(const SynthPlan& p) {
  const double n = (double)p.int_val + (double)p.frac / (double)p.mod;
  return (double)p.pfd_hz * n / (double)(1ULL << p.rf_div_sel);
}

PlanStatus plan_frequency(uint64_t freq_hz, const PlannerConfig& cfg,
                          SynthPlan& out) {
  // --- Валидация диапазона (даташит: 34.375 МГц – 4.4 ГГц) ---
  if (freq_hz < ADF_FREQ_MIN_HZ || freq_hz > ADF_FREQ_MAX_HZ) {
    return PlanStatus::ERR_RANGE;
  }
  if (cfg.r_counter < 1 || cfg.r_counter > 1023) {
    return PlanStatus::ERR_CONFIG;
  }

  const uint64_t pfd = pfd_hz_of(cfg);
  if (pfd == 0) {
    return PlanStatus::ERR_CONFIG;
  }

  // --- Выходной делитель: минимальный, чтобы VCO попал в 2200–4400 МГц ---
  uint8_t div_sel = 0;
  uint64_t vco = freq_hz;
  while (vco < ADF_VCO_MIN_HZ && div_sel < 6) {
    vco <<= 1;
    ++div_sel;
  }
  if (vco < ADF_VCO_MIN_HZ || vco > ADF_VCO_MAX_HZ) {
    return PlanStatus::ERR_RANGE;  // не должно случиться после проверки выше
  }

  // --- INT / остаток ---
  const uint64_t n_int = vco / pfd;
  const uint64_t rem = vco % pfd;  // остаток в Гц
  if (n_int > 65535ULL) {
    return PlanStatus::ERR_INT_RANGE;
  }
  uint32_t int_val = (uint32_t)n_int;
  uint32_t frac = 0;
  uint32_t mod = 2;

  if (rem != 0) {
    // Точный путь: MOD = fPFD / gcd(fPFD, rem)
    const uint64_t g = gcd64(pfd, rem);
    const uint64_t mod_exact = pfd / g;
    if (mod_exact >= 2 && mod_exact <= 4095) {
      mod = (uint32_t)mod_exact;
      frac = (uint32_t)(rem / g);
    } else {
      // Fallback: максимальный MOD=4095, округление, честная ошибка
      mod = 4095;
      frac = (uint32_t)((rem * 4095ULL + pfd / 2) / pfd);
      if (frac >= mod) {  // перенос при округлении
        frac = 0;
        int_val += 1;
      }
    }
  }

  // --- Прескалер по частоте VCO (fundamental feedback, факт F6) ---
  const uint8_t presc89 = (vco > ADF_PRESCALER_89_ABOVE_HZ) ? 1 : 0;
  const uint32_t int_min = presc89 ? ADF_INT_MIN_89 : ADF_INT_MIN_45;
  if (int_val < int_min || int_val > 65535) {
    return PlanStatus::ERR_INT_RANGE;
  }

  const bool integer_n = (frac == 0);

  // --- Проверка fPFD для режима (даташит: 32 МГц frac / 90 МГц int) ---
  if (!integer_n && pfd > ADF_PFD_MAX_FRAC_HZ) {
    return PlanStatus::ERR_PFD;
  }
  if (integer_n && pfd > ADF_PFD_MAX_INT_HZ) {
    return PlanStatus::ERR_PFD;
  }

  // --- Сборка регистров (карты — даташит Figure 23) ---
  // Мode-зависимые биты (даташит): int-N → LDF=1 (5 PFD циклов), LDP=1 (6 нс),
  // ABP=1 (3 нс), charge cancel=1; frac-N → всё 0.
  const uint32_t ldf = integer_n ? 1U : 0U;
  const uint32_t ldp = integer_n ? 1U : 0U;
  const uint32_t abp = integer_n ? 1U : 0U;
  const uint32_t charge_cancel = integer_n ? 1U : 0U;

  uint32_t* r = out.regs;

  // R0: INT[30:15], FRAC[14:3], addr 000
  r[0] = (int_val << 15) | (frac << 3) | 0x0U;

  // R1: PHASE_ADJ=0[28], PRESC[27], PHASE=1[26:15] (1 — рекомендовано даташитом),
  //     MOD[14:3], addr 001
  r[1] = ((uint32_t)presc89 << 27) | (1U << 15) | (mod << 3) | 0x1U;

  // R2: low-noise(0)[30:29], MUXOUT=6 digital lock detect[28:26],
  //     doubler[25], div2[24], R[23:14], double-buf=0[13], CP[12:9],
  //     LDF[8], LDP[7], PD polarity=1 positive[6], powerdown=0[5],
  //     CP 3-state=0[4], counter reset=0[3], addr 010
  r[2] = (6U << 26) | ((uint32_t)(cfg.ref_doubler ? 1 : 0) << 25) |
         ((uint32_t)(cfg.ref_div2 ? 1 : 0) << 24) |
         ((uint32_t)cfg.r_counter << 14) | ((uint32_t)cfg.cp_current_code << 9) |
         (ldf << 8) | (ldp << 7) | (1U << 6) | 0x2U;

  // R3: band select clock mode=1 (fast, факт F4)[23], ABP[22],
  //     charge cancel[21], CSR=0[18], clk div mode=00 (off)[16:15],
  //     clk div=1[14:3], addr 011
  r[3] = (1U << 23) | (abp << 22) | (charge_cancel << 21) | (1U << 3) | 0x3U;

  // R4: feedback=1 fundamental[23], div sel[22:20],
  //     band select clock divider=50 → 500 кГц при fPFD 25 МГц (20 мкс, F4)
  //     [19:12], VCO pd=0[11], MTLD[10], aux sel=0[9], aux en=0[8],
  //     aux pwr=0[7:6], RF out en[5], out power[4:3], addr 100
  const uint32_t bs_div = 50;  // допустимо ≤254 в fast mode; 25 МГц/50 = 500 кГц
  r[4] = (1U << 23) | ((uint32_t)div_sel << 20) | (bs_div << 12) |
         ((uint32_t)(cfg.mute_till_lock ? 1 : 0) << 10) |
         ((uint32_t)(cfg.rf_output_enable ? 1 : 0) << 5) |
         ((uint32_t)cfg.output_power_code << 3) | 0x4U;

  // R5: LD pin mode=01 (digital lock detect)[23:22], DB[20:19]=11 (даташит
  //     Figure 23), addr 101 → 0x00580005 (совпадает с классикой/EngineerZone)
  r[5] = (1U << 22) | (3U << 19) | 0x5U;

  // --- Диагностика результата ---
  out.int_val = (uint16_t)int_val;
  out.frac = (uint16_t)frac;
  out.mod = (uint16_t)mod;
  out.rf_div_sel = div_sel;
  out.prescaler_89 = presc89;
  out.integer_n = integer_n;
  out.pfd_hz = pfd;
  out.vco_hz = vco;
  out.actual_hz = plan_output_hz(out);
  out.error_hz = out.actual_hz - (double)freq_hz;

  return PlanStatus::OK;
}

}  // namespace legion
