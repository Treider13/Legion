// ============================================================================
// LEGION — storage: реализация на Preferences (NVS).
// ============================================================================
#include "storage.h"

#include <Preferences.h>

namespace legion {

static Preferences s_pref;
static constexpr const char* NS = "legion";

void storage_init() { s_pref.begin(NS, false); }

void storage_load(PersistedState& out) {
  out.freq_hz = s_pref.getULong64("freq", 2475000000ULL);
  out.power_code = s_pref.getUChar("power", 3);  // +5 дБм
  out.rf_on = s_pref.getBool("rf", false);       // RF выключен (compliance)
  out.ref_ppm_milli = s_pref.getInt("ppm", 0);
  out.corridor_active = s_pref.getBool("corr_on", false);
  out.corridor.mode = (CorridorMode)s_pref.getUChar("corr_md", 0);
  out.corridor.f1_hz = s_pref.getULong64("corr_f1", 2400000000ULL);
  out.corridor.f2_hz = s_pref.getULong64("corr_f2", 2500000000ULL);
  out.corridor.step_hz = s_pref.getUInt("corr_st", 1000000);
  out.corridor.dwell_ms = s_pref.getUInt("corr_dw", 10);
  out.corridor.seed = s_pref.getUInt("corr_sd", 1);
  out.corridor.fm_depth_hz = s_pref.getDouble("corr_fm", 100000.0);
  out.att_db = s_pref.getFloat("att", 0.0f);
  out.wifi_mode = s_pref.getUChar("wifi_md", 0);
  strlcpy(out.wifi_ssid, s_pref.getString("wifi_ss", "").c_str(),
          sizeof(out.wifi_ssid));
  strlcpy(out.wifi_pass, s_pref.getString("wifi_pw", "").c_str(),
          sizeof(out.wifi_pass));
}

void storage_save_freq(uint64_t hz) { s_pref.putULong64("freq", hz); }
void storage_save_power(uint8_t code) { s_pref.putUChar("power", code); }
void storage_save_rf(bool on) { s_pref.putBool("rf", on); }
void storage_save_ppm(int32_t ppm) { s_pref.putInt("ppm", ppm); }
void storage_save_att(float db) { s_pref.putFloat("att", db); }

void storage_save_corridor(bool active, const CorridorConfig& cfg) {
  s_pref.putBool("corr_on", active);
  s_pref.putUChar("corr_md", (uint8_t)cfg.mode);
  s_pref.putULong64("corr_f1", cfg.f1_hz);
  s_pref.putULong64("corr_f2", cfg.f2_hz);
  s_pref.putUInt("corr_st", cfg.step_hz);
  s_pref.putUInt("corr_dw", cfg.dwell_ms);
  s_pref.putUInt("corr_sd", cfg.seed);
  s_pref.putDouble("corr_fm", cfg.fm_depth_hz);
}

void storage_save_wifi(uint8_t mode, const char* ssid, const char* pass) {
  s_pref.putUChar("wifi_md", mode);
  s_pref.putString("wifi_ss", ssid);
  s_pref.putString("wifi_pw", pass);
}

}  // namespace legion
