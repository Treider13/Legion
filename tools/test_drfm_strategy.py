#!/usr/bin/env python3
"""Приёмка plan_drfm_strategy: ELRS two-ray, ZC 15 кГц, ISM8 не OcuSync."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from drfm_strategy import (
    DRFM_AMP_HALF,
    DRFM_TAP1_TWORY,
    DRFM_TWORY_RU,
    DRFM_ZC_RU,
    DRFM_ZC_SHIFT_HZ,
    drfm_ftw_from_hz,
    drfm_twory_delay1,
    plan_drfm_strategy,
)
from smart_grid import (
    CH_PRESET_ISM8,
    GRID_KIND_OFDM,
    GRID_KIND_ZC,
    match_smart_grid,
)


def check(name: str, cond: bool) -> None:
    print(("PASS" if cond else "FAIL"), name)
    if not cond:
        raise SystemExit(1)


elrs = match_smart_grid({"hops_mhz": [2400.4, 2401.4, 2410.4, 2450.4]})
s = plan_drfm_strategy(elrs, 56e6)
check("ELRS → two-ray 0/64 @ 56e6, walk_step=0, без сдвига",
      s["id"] == "tworay" and s["delay0"] == 0 and s["delay1"] == DRFM_TAP1_TWORY
      and s["amp0"] == DRFM_AMP_HALF and s["amp1"] == DRFM_AMP_HALF
      and s["shift_hz"] == 0 and s["walk_step"] == 0 and s["reason"] == DRFM_TWORY_RU)
check("two-ray @ 2e6 → delay1=2",
      plan_drfm_strategy(elrs, 2e6)["delay1"] == 2 and drfm_twory_delay1(2e6) == 2)

zc = match_smart_grid({"looks": [{"zc_hit": True, "freq_mhz": 5789.5}]})
z = plan_drfm_strategy(zc, 56e6)
check("ZC 5.8 → один отвод + 15 кГц, FTW 1150438 @ 56e6",
      z["id"] == "zc-cfo" and z["delay1"] == 0 and z["amp1"] == 0
      and z["shift_hz"] == DRFM_ZC_SHIFT_HZ
      and z["ftw"] == drfm_ftw_from_hz(15_000, 56e6)
      and z["ftw"] == 1_150_438 and z["walk_step"] == 0
      and z["reason"] == DRFM_ZC_RU)

z40 = plan_drfm_strategy(zc, 40e6)
check("ZC FTW от фактического fs: 15 кГц @ 40e6 → 1610613",
      z40["ftw"] == drfm_ftw_from_hz(15_000, 40e6) and z40["ftw"] == 1_610_613)

ofdm = match_smart_grid({
    "looks": [{"kind": "ofdm", "freq_mhz": 2442, "leftover": 0.4}],
})
o = plan_drfm_strategy(ofdm, 56e6)
check("ISM8 / OFDM 2.4 без ZC → two-ray, не OcuSync-сдвиг",
      o["id"] == "tworay" and o["shift_hz"] == 0 and ofdm.get("preset") == CH_PRESET_ISM8
      and ofdm.get("kind") == GRID_KIND_OFDM)

empty = plan_drfm_strategy(match_smart_grid({}), 56e6)
check("пустая сетка → two-ray, не ELRS-подстановка сдвига",
      empty["id"] == "tworay" and empty["walk_step"] == 0)

ov = plan_drfm_strategy(elrs, 56e6, {"delay0": 32, "shift_hz": -25000})
check("override панели: tap0=32 и сдвиг бьют таблицу",
      ov["delay0"] == 32 and ov["delay1"] == 64 and ov["shift_hz"] == -25000
      and ov["wire"] == "shift")

check("amp 29491 не дефолт (двойной 0.9 с mux)",
      s["amp0"] == 16384 and z["amp0"] == 16384)

o4 = match_smart_grid({"accept_o4": True})
o4s = plan_drfm_strategy(o4, 56e6)
check("O4VID3 без zc_hit → two-ray, не 15 кГц (пресет LUT)",
      o4.get("kind") == GRID_KIND_ZC and o4s["id"] == "tworay" and o4s["shift_hz"] == 0)

print("drfm_strategy: ALL PASS")
