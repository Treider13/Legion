// ============================================================================
// LEGION — SELFTEST: реализация. MUXOUT переключается правкой битов [28:26]
// в R2 (MUXOUT не double-buffered — R0 не нужен, даташит Program Modes).
// ============================================================================
#include "selftest.h"

namespace legion {

// MUXOUT значения (даташит Figure 26 / pyadf435x MuxOut)
static constexpr uint32_t MUX_DGND = 2;  // 010
static constexpr uint32_t MUX_DVDD = 1;  // 001
static constexpr uint32_t MUX_DLD = 6;   // 110 — digital lock detect

static uint32_t r2_with_mux(uint32_t r2, uint32_t mux) {
  return (r2 & ~(0x7UL << 26)) | (mux << 26);
}

void selftest_run(AppState& s, Print& out) {
  // Базовый R2: из текущего плана, либо свежерассчитанный на 2475 МГц
  if (!s.plan_valid) {
    bool lock;
    apply_frequency(s, s.freq_hz, lock);  // побочный LOCK нам не нужен
  }
  const uint32_t r2_base = s.plan.regs[2];

  // Шаг 1: MUXOUT=DGND → LOW
  s.drv->writeR2(r2_with_mux(r2_base, MUX_DGND));
  delay(2);
  const bool gnd_ok = (s.drv->readLock() == false);

  // Шаг 2: MUXOUT=DVdd → HIGH
  s.drv->writeR2(r2_with_mux(r2_base, MUX_DVDD));
  delay(2);
  const bool dvdd_ok = (s.drv->readLock() == true);

  // Шаг 3: MUXOUT=DLD, полная перезапись плана (R5→R0), ожидание LOCK
  s.drv->writeR2(r2_with_mux(r2_base, MUX_DLD));
  s.drv->writePlan(s.plan);
  delay(10);  // band select 20 мкс + settling ~0.3 мс — запас ×30 (F4/F5)
  bool lock = false;
  for (int i = 0; i < 10; ++i) {  // debounce (F12)
    if (s.drv->readLock()) {
      lock = true;
    } else {
      lock = false;
    }
    delay(1);
  }

  const bool pass = gnd_ok && dvdd_ok && lock;
  out.print(F("{\"selftest\":{\"mux_gnd\":"));
  out.print(gnd_ok ? 1 : 0);
  out.print(F(",\"mux_dvdd\":"));
  out.print(dvdd_ok ? 1 : 0);
  out.print(F(",\"lock\":"));
  out.print(lock ? 1 : 0);
  out.print(F(",\"pass\":"));
  out.print(pass ? 1 : 0);
  out.println(F("}}"));
  if (!gnd_ok || !dvdd_ok) {
    out.println(F("ERR HINT check SPI wiring — pins may be swapped (docs/module-quirks.md M1)"));
  }
}

}  // namespace legion
