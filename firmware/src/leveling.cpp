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
// Кэш последнего применённого затухания: на каждом шаге коридора пересчёт даёт
// то же квантованное значение, пока частота в пределах одного «участка» → не
// дёргаем PE43702 зря (меньше трафика и окна гонки). Сбрасывается при любом
// изменении калибровки/цели.
static float s_last_db = -1.0f;
static bool s_last_valid = false;

static void invalidate_apply_cache() { s_last_valid = false; }

void leveling_init(Attenuator& att) { s_att = &att; }

bool leveling_add_point(double freq_mhz, double dbm) {
  const int r = lvl_upsert(s_pts, s_n, LVL_MAX_POINTS, freq_mhz, dbm);
  if (r < 0) {
    return false;  // переполнение
  }
  s_n = r;
  invalidate_apply_cache();
  return true;
}

void leveling_clear() {
  s_n = 0;
  invalidate_apply_cache();
}
int leveling_count() { return s_n; }
const LevelPoint* leveling_table() { return s_pts; }

void leveling_set_target(double dbm) {
  s_target_dbm = dbm;
  s_enabled = true;
  invalidate_apply_cache();
}

void leveling_disable() {
  s_enabled = false;
  invalidate_apply_cache();
}
bool leveling_enabled() { return s_enabled; }
double leveling_target() { return s_target_dbm; }

double leveling_apply(uint64_t freq_hz) {
  if (!s_enabled || s_n <= 0 || s_att == nullptr) {
    return -1.0;
  }
  const double freq_mhz = (double)freq_hz / 1e6;
  const float db = (float)lvl_atten_for(s_pts, s_n, freq_mhz, s_target_dbm);
  if (s_last_valid && db == s_last_db) {
    return (double)db;  // значение не изменилось — не трогаем аттенюатор
  }
  const float actual = s_att->setDb(db);
  s_last_db = actual;
  s_last_valid = true;
  return (double)actual;
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
  invalidate_apply_cache();
}

}  // namespace legion
