// ============================================================================
// LEGION — leveling_math: чистая математика выравнивания выходного уровня
// через цифровой аттенюатор PE43702. Без Arduino — host-тестируемо
// (pio test -e native).
//
// Зачем: дешёвый модуль ADF4351 гуляет по выходной мощности ~9 дБ по диапазону
// 35М–4.4Г (замер dd1us.de), хотя сам чип даёт ±1 дБ (даташит ADF4351 Rev. A,
// «Output Power Variation ±1 dB»). Чип умеет только 4 грубые ступени мощности
// (−4/−1/+2/+5 дБм, R4[4:3]). PE43702 добавляет 0–31.75 дБ шагом 0.25 дБ.
//
// Модель РАЗОМКНУТАЯ (open-loop): по калибровочной таблице «частота → измеренный
// выход, дБм» вычисляем, сколько нужно ослабить, чтобы получить ПЛОСКИЙ целевой
// уровень. Данные таблицы измеряет пользователь анализатором/измерителем
// мощности — без прибора это выравнивание не построить (честное ограничение;
// см. docs/analysis-upgrade.md). Аттенюатор только ОСЛАБЛЯЕТ: цель обязана быть
// не выше минимума измеренного уровня по полосе, иначе ослабление упрётся в 0.
// ============================================================================
#pragma once

#include <cstdint>

namespace legion {

// Точка калибровки: измеренный выход (дБм) на данной частоте при опорной
// настройке (аттенюатор 0 дБ, фиксированный power_code).
struct LevelPoint {
  double freq_mhz;
  double dbm;
};

// Кусочно-линейная интерполяция измеренного уровня (дБм) на частоте freq_mhz.
// Таблица отсортирована по возрастанию частоты. За краями — плато (clamp).
// n<=0 → 0 дБм (нет данных).
inline double lvl_interp_dbm(const LevelPoint* pts, int n, double freq_mhz) {
  if (n <= 0 || pts == nullptr) {
    return 0.0;
  }
  if (freq_mhz <= pts[0].freq_mhz) {
    return pts[0].dbm;
  }
  if (freq_mhz >= pts[n - 1].freq_mhz) {
    return pts[n - 1].dbm;
  }
  for (int i = 1; i < n; ++i) {
    if (freq_mhz <= pts[i].freq_mhz) {
      const double f0 = pts[i - 1].freq_mhz;
      const double f1 = pts[i].freq_mhz;
      const double d0 = pts[i - 1].dbm;
      const double d1 = pts[i].dbm;
      if (f1 <= f0) {
        return d0;  // защита от вырожденных точек с равной частотой
      }
      const double t = (freq_mhz - f0) / (f1 - f0);
      return d0 + t * (d1 - d0);
    }
  }
  return pts[n - 1].dbm;
}

// Требуемое затухание аттенюатора (дБ), чтобы из измеренного measured_dbm
// получить целевой target_dbm. Аттенюатор только ослабляет → результат в
// [0, max_db], квантование к step (PE43702: 0.25 дБ). Если цель выше
// измеренного — вернём 0 (усилить нельзя, честное ограничение).
inline double lvl_required_atten_db(double measured_dbm, double target_dbm,
                                    double max_db = 31.75, double step = 0.25) {
  double db = measured_dbm - target_dbm;
  if (db < 0.0) {
    db = 0.0;
  }
  if (db > max_db) {
    db = max_db;
  }
  if (step > 0.0) {
    const long q = (long)(db / step + 0.5);  // квантование как в драйвере
    db = (double)q * step;
    if (db > max_db) {
      db = max_db;
    }
  }
  return db;
}

// Комбинированно: по таблице + частоте + цели → затухание аттенюатора (дБ).
inline double lvl_atten_for(const LevelPoint* pts, int n, double freq_mhz,
                            double target_dbm, double max_db = 31.75,
                            double step = 0.25) {
  const double measured = lvl_interp_dbm(pts, n, freq_mhz);
  return lvl_required_atten_db(measured, target_dbm, max_db, step);
}

// Вставка/замена точки в отсортированную по частоте таблицу (по возрастанию).
// Совпадение частоты (в пределах eps МГц) заменяет значение. Возвращает новый
// размер, либо -1 если нет места (n уже == cap). cap — ёмкость массива.
inline int lvl_upsert(LevelPoint* pts, int n, int cap, double freq_mhz,
                      double dbm, double eps_mhz = 1e-6) {
  // Замена существующей точки
  for (int i = 0; i < n; ++i) {
    double d = pts[i].freq_mhz - freq_mhz;
    if (d < 0) d = -d;
    if (d <= eps_mhz) {
      pts[i].dbm = dbm;
      return n;
    }
  }
  if (n >= cap) {
    return -1;
  }
  // Позиция вставки (сохраняем сортировку)
  int pos = n;
  for (int i = 0; i < n; ++i) {
    if (freq_mhz < pts[i].freq_mhz) {
      pos = i;
      break;
    }
  }
  for (int i = n; i > pos; --i) {
    pts[i] = pts[i - 1];
  }
  pts[pos].freq_mhz = freq_mhz;
  pts[pos].dbm = dbm;
  return n + 1;
}

}  // namespace legion
