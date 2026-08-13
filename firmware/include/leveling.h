// ============================================================================
// LEGION — leveling: выравнивание выходного уровня через PE43702 (фаза 10).
// Разомкнутая калибровка «частота → измеренный выход, дБм» + целевой плоский
// уровень. Данные таблицы вводит пользователь (CAL LEVEL ...), измеряя выход
// анализатором/измерителем мощности. Математика — в leveling_math.h (host-тест).
// ============================================================================
#pragma once

#include <Arduino.h>

#include "attenuator.h"
#include "leveling_math.h"

namespace legion {

constexpr int LVL_MAX_POINTS = 16;

// Инициализация: привязка к аттенюатору.
void leveling_init(Attenuator& att);

// Калибровка: добавить/заменить точку (freq_mhz → измеренный dBm).
// Возвращает false, если таблица переполнена.
bool leveling_add_point(double freq_mhz, double dbm);
void leveling_clear();
int leveling_count();
const LevelPoint* leveling_table();

// Целевой плоский уровень (дБм). Включает выравнивание.
void leveling_set_target(double dbm);
void leveling_disable();
bool leveling_enabled();
double leveling_target();

// Применить затухание для частоты freq_hz, если выравнивание включено.
// Возвращает применённое затухание (дБ) или -1.0, если выключено / нет данных.
double leveling_apply(uint64_t freq_hz);

// Загрузка сохранённого состояния (NVS) без записи в аттенюатор.
void leveling_restore(const LevelPoint* pts, int n, bool enabled, double target);

}  // namespace legion
