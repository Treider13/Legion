/* Синтетический ad9361_api.h: заголовки no_OS AD9361 в вендоренное
 * подмножество не вошли. На уровне объявлений проверяемому коду нужны:
 * неполный тип struct ad9361_rf_phy (указатели) и enum rf_gain_ctrl_mode
 * (bladerf2_common.h, devices_rfic_cmds.c). Значения enum — как в no_OS ADI
 * (RF_GAIN_MGC=0 …), сверено с использованием в devices_rfic_cmds.c. */
#ifndef LEGION_STUB_AD9361_API_H_
#define LEGION_STUB_AD9361_API_H_

struct ad9361_rf_phy;

enum rf_gain_ctrl_mode {
    RF_GAIN_MGC,
    RF_GAIN_FASTATTACK_AGC,
    RF_GAIN_SLOWATTACK_AGC,
    RF_GAIN_HYBRID_AGC,
};

#endif /* LEGION_STUB_AD9361_API_H_ */
