// ============================================================================
// LEGION — runtime-политика актуатора (RAM, не NVS).
// Не владеет ADF4351: только решение «можно / нельзя» для cmd_server.
// ============================================================================
#pragma once

#include <cstdint>

#include "policy_math.h"

namespace legion {

void policy_init();

bool policy_allow_add(uint64_t f1_hz, uint64_t f2_hz);
void policy_allow_clear();
int policy_allow_count();
const AllowBand* policy_allow_table();

void policy_set_load_ok(bool ok);
bool policy_load_ok();

bool policy_set_pa_ma(uint32_t ma);
uint32_t policy_pa_ma();
bool policy_set_pa_on(bool on);  // false, если интерлок не пускает
bool policy_pa_on();

bool policy_rf_enable_allowed(uint64_t freq_hz);
bool policy_corridor_allowed(uint64_t f1_hz, uint64_t f2_hz);
bool policy_cue_allowed(uint64_t freq_hz);

}  // namespace legion
