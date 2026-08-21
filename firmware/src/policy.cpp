// ============================================================================
// LEGION — runtime-политика актуатора. Состояние только в RAM:
// LOAD и PA ON не переживают reboot (как RF ON — compliance).
// ============================================================================
#include "policy.h"

namespace legion {

static AllowBand g_bands[ALLOW_MAX_BANDS];
static int g_n = 0;
static bool g_load_ok = true;  // совместимость со стендами без LOAD
static uint32_t g_pa_ma = 0;
static bool g_pa_on = false;

void policy_init() {
  g_n = 0;
  g_load_ok = true;
  g_pa_ma = 0;
  g_pa_on = false;
}

bool policy_allow_add(uint64_t f1_hz, uint64_t f2_hz) {
  if (!allow_band_valid(f1_hz, f2_hz)) {
    return false;
  }
  // Дубль — идемпотентный успех: реплей allowlist при reconnect хоста
  // (connect() шлёт ALLOW ADD заново) не плодит копии до переполнения таблицы.
  for (int i = 0; i < g_n; ++i) {
    if (g_bands[i].f1_hz == f1_hz && g_bands[i].f2_hz == f2_hz) {
      return true;
    }
  }
  if (g_n >= ALLOW_MAX_BANDS) {
    return false;
  }
  g_bands[g_n].f1_hz = f1_hz;
  g_bands[g_n].f2_hz = f2_hz;
  ++g_n;
  return true;
}

void policy_allow_clear() { g_n = 0; }

int policy_allow_count() { return g_n; }

const AllowBand* policy_allow_table() { return g_bands; }

void policy_set_load_ok(bool ok) {
  g_load_ok = ok;
  if (!ok) {
    g_pa_on = false;  // нагрузка снята — PA гасим
  }
}

bool policy_load_ok() { return g_load_ok; }

bool policy_set_pa_ma(uint32_t ma) {
  if (!pa_current_in_range(ma)) {
    return false;
  }
  g_pa_ma = ma;
  if (g_pa_ma == 0) {
    g_pa_on = false;
  }
  return true;
}

uint32_t policy_pa_ma() { return g_pa_ma; }

bool policy_set_pa_on(bool on) {
  if (on) {
    if (!actuator_enable_allowed(g_load_ok) || g_pa_ma == 0) {
      return false;
    }
  }
  g_pa_on = on;
  return true;
}

bool policy_pa_on() { return g_pa_on; }

bool policy_rf_enable_allowed(uint64_t freq_hz) {
  if (!actuator_enable_allowed(g_load_ok)) {
    return false;
  }
  return hz_in_allowlist(freq_hz, g_bands, g_n);
}

bool policy_corridor_allowed(uint64_t f1_hz, uint64_t f2_hz) {
  return range_in_allowlist(f1_hz, f2_hz, g_bands, g_n);
}

bool policy_cue_allowed(uint64_t freq_hz) {
  return cue_freq_allowed(freq_hz, g_bands, g_n);
}

}  // namespace legion
