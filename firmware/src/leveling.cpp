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
// Мьютекс таблицы калибровки: leveling_apply читает s_pts/s_n/s_target из
// sweep_task (коридор), а мутаторы меняют их из cmd-контекста. Без сериализации
// шаг свипа мог прочитать таблицу в момент сдвига элементов lvl_upsert
// (несогласованное состояние). Тот же приём, что s_cfg_mtx в sweep_engine.
static SemaphoreHandle_t s_mtx = nullptr;

static inline void lvl_lock() {
  if (s_mtx) xSemaphoreTake(s_mtx, portMAX_DELAY);
}
static inline void lvl_unlock() {
  if (s_mtx) xSemaphoreGive(s_mtx);
}

void leveling_init(Attenuator& att) {
  s_att = &att;
  if (s_mtx == nullptr) {
    s_mtx = xSemaphoreCreateMutex();
  }
}

bool leveling_add_point(double freq_mhz, double dbm) {
  lvl_lock();
  const int r = lvl_upsert(s_pts, s_n, LVL_MAX_POINTS, freq_mhz, dbm);
  const bool ok = (r >= 0);
  if (ok) {
    s_n = r;
    s_last_valid = false;  // калибровка изменилась
  }
  lvl_unlock();
  return ok;
}

void leveling_clear() {
  lvl_lock();
  s_n = 0;
  s_last_valid = false;
  lvl_unlock();
}
int leveling_count() { return s_n; }
const LevelPoint* leveling_table() { return s_pts; }

void leveling_set_target(double dbm) {
  lvl_lock();
  s_target_dbm = dbm;
  s_enabled = true;
  s_last_valid = false;
  lvl_unlock();
}

void leveling_disable() {
  lvl_lock();
  s_enabled = false;
  s_last_valid = false;
  lvl_unlock();
}
bool leveling_enabled() { return s_enabled; }
double leveling_target() { return s_target_dbm; }

double leveling_apply(uint64_t freq_hz) {
  // Мьютекс держим на всё время (включая setDb) — без check-then-act гонки.
  // Порядок блокировок всегда leveling→attenuator (attenuator-мьютекс берётся
  // только внутри setDb; обратного порядка нигде нет) → дедлок невозможен.
  lvl_lock();
  if (!s_enabled || s_n <= 0 || s_att == nullptr) {
    lvl_unlock();
    return -1.0;
  }
  const double freq_mhz = (double)freq_hz / 1e6;
  const float db = (float)lvl_atten_for(s_pts, s_n, freq_mhz, s_target_dbm);
  if (s_last_valid && db == s_last_db) {
    lvl_unlock();
    return (double)db;  // значение не изменилось — не трогаем аттенюатор
  }
  const float actual = s_att->setDb(db);
  s_last_db = actual;
  s_last_valid = true;
  lvl_unlock();
  return (double)actual;
}

void leveling_restore(const LevelPoint* pts, int n, bool enabled,
                      double target) {
  if (n < 0) n = 0;
  if (n > LVL_MAX_POINTS) n = LVL_MAX_POINTS;
  lvl_lock();
  for (int i = 0; i < n; ++i) {
    s_pts[i] = pts[i];
  }
  s_n = n;
  s_enabled = enabled;
  s_target_dbm = target;
  s_last_valid = false;
  lvl_unlock();
}

}  // namespace legion
