// ============================================================================
// LEGION — leveling: реализация. Таблица калибровки в статической памяти,
// применение затухания через PE43702. Вся арифметика — leveling_math.h.
// ============================================================================
#include "leveling.h"

namespace legion {

static Attenuator* s_att = nullptr;
static LevelPoint s_pts[LVL_MAX_POINTS];
static int s_n = 0;
static bool s_enabled = false;
static double s_target_dbm = 0.0;

void leveling_init(Attenuator& att) { s_att = &att; }

bool leveling_add_point(double freq_mhz, double dbm) {
  const int r = lvl_upsert(s_pts, s_n, LVL_MAX_POINTS, freq_mhz, dbm);
  if (r < 0) {
    return false;  // переполнение
  }
  s_n = r;
  return true;
}

void leveling_clear() { s_n = 0; }
int leveling_count() { return s_n; }
const LevelPoint* leveling_table() { return s_pts; }

void leveling_set_target(double dbm) {
  s_target_dbm = dbm;
  s_enabled = true;
}

void leveling_disable() { s_enabled = false; }
bool leveling_enabled() { return s_enabled; }
double leveling_target() { return s_target_dbm; }

double leveling_apply(uint64_t freq_hz) {
  if (!s_enabled || s_n <= 0 || s_att == nullptr) {
    return -1.0;
  }
  const double freq_mhz = (double)freq_hz / 1e6;
  const double db = lvl_atten_for(s_pts, s_n, freq_mhz, s_target_dbm);
  return (double)s_att->setDb((float)db);
}

void leveling_restore(const LevelPoint* pts, int n, bool enabled,
                      double target) {
  if (n < 0) n = 0;
  if (n > LVL_MAX_POINTS) n = LVL_MAX_POINTS;
  for (int i = 0; i < n; ++i) {
    s_pts[i] = pts[i];
  }
  s_n = n;
  s_enabled = enabled;
  s_target_dbm = target;
}

}  // namespace legion
