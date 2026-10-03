#!/usr/bin/env python3
"""Приёмка матчера сетки: пустой эфир, ELRS, FreqCorrection, 5.8, x40."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from smart_grid import (
    ANALOG_RU,
    CH_PRESET_ELRS,
    CH_PRESET_O4VID3,
    EMPTY_RU,
    GRID_FLAG_FCORR,
    GRID_FLAG_F0UNC,
    GRID_KIND_ANALOG,
    GRID_KIND_FHSS,
    X40_C58_RU,
    match_smart_grid,
    pack_grid_f0,
)


def check(name: str, cond: bool) -> None:
    print(("PASS" if cond else "FAIL"), name)
    if not cond:
        raise SystemExit(1)


check("пустой эфир не ELRS 2400.4", match_smart_grid({})["empty"] and
      match_smart_grid({})["reason"] == EMPTY_RU and
      match_smart_grid({})["f0_hz"] == 0)

elrs = match_smart_grid({"hops_mhz": [2400.4, 2401.4, 2410.4, 2450.4]})
check("ELRS hop-set → карточка 2400.4 / 1 МГц / 80",
      elrs["smart"] and elrs["f0_hz"] == 2400400000 and
      elrs["step_hz"] == 1_000_000 and elrs["n"] == 80 and
      elrs["preset"] == CH_PRESET_ELRS and elrs["kind"] == GRID_KIND_FHSS)

corr = match_smart_grid({"hops_mhz": [2400.55, 2401.55, 2410.55]})
check("FreqCorrection +150 кГц @ 2.4",
      corr["smart"] and corr["shift_hz"] == 150_000 and
      (corr["flags"] & GRID_FLAG_FCORR) != 0)

mlrs = match_smart_grid({"hops_mhz": [2401.0, 2402.0, 2410.0]})
check("mLRS 2401 не садится на ELRS (сдвиг 600 кГц > 200)",
      mlrs["smart"] and mlrs["f0_hz"] == 2_401_000_000)

check("5.8 analog → не умная",
      match_smart_grid({"looks": [{"analog_hit": True, "freq_mhz": 5800}]})["analog"] and
      match_smart_grid({"looks": [{"analog_hit": True, "freq_mhz": 5800}]})["reason"] == ANALOG_RU)

o4 = match_smart_grid({"looks": [{"zc_hit": True, "freq_mhz": 5789.5}]})
check("ZC 5.8 → O4VID3 без карточки",
      o4["smart"] and o4["preset"] == CH_PRESET_O4VID3 and o4["f0_hz"] == 0)

check("x40+5.8 отказ",
      match_smart_grid({"sdr_id": "bladerf-x40",
                        "bands": [{"f1_mhz": 5725, "f2_mhz": 5850}]})["reason"] == X40_C58_RU)

check("5.8 ГГц в uint32 → кГц", pack_grid_f0(5_768_500_000) == 5_768_500)
check("2.4 ГГц влезает в Hz", pack_grid_f0(2_400_400_000) == 2_400_400_000)

op = match_smart_grid({"operator": {"f0_hz": 5_768_500_000, "step_hz": 21_000_000, "n": 3}})
check("карточка оператора бьёт пресет",
      op["source"] == 3 and op["packed_f0"] == 5_768_500)

overlap = match_smart_grid({"hops_mhz": [2405.1, 2406.1, 2415.1]})
check("несколько гипотез → f0_unconfirmed или одна семья",
      overlap["smart"] and (
          (overlap["flags"] & GRID_FLAG_F0UNC) != 0 or overlap["n"] == 80))

mlrs_int = match_smart_grid({"hops_mhz": [2440.0, 2441.0, 2442.0, 2443.0]})
check("residual 0.0 → одна карточка mLRS n=80",
      mlrs_int["smart"] and mlrs_int["f0_hz"] == 2_401_000_000 and
      mlrs_int["n"] == 80 and (mlrs_int["flags"] & GRID_FLAG_F0UNC) == 0)

amb = match_smart_grid({"hops_mhz": [2440.2, 2441.2, 2442.2]})
check("середина сеток — одна карточка n=80",
      amb["smart"] and amb["n"] == 80 and amb["step_hz"] == 1_000_000)
check("середина 2.4 — F0UNC (остатки равны)",
      (amb["flags"] & GRID_FLAG_F0UNC) != 0)

elrs900 = match_smart_grid({"hops_mhz": [903.5, 904.1, 904.7, 910.1]})
check("ELRS FCC915 903.5 не mLRS 902.4",
      elrs900["smart"] and elrs900["f0_hz"] == 903_500_000 and
      elrs900["n"] == 40 and (elrs900["flags"] & GRID_FLAG_F0UNC) == 0)

mlrs900 = match_smart_grid({"hops_mhz": [902.4, 903.0, 903.6, 909.0]})
check("mLRS 902.4 не ELRS 903.5",
      mlrs900["smart"] and mlrs900["f0_hz"] == 902_400_000 and
      mlrs900["n"] == 43 and (mlrs900["flags"] & GRID_FLAG_F0UNC) == 0)

mid900 = match_smart_grid({"hops_mhz": [903.55, 904.15, 904.75]})
check("середина 900 — F0UNC",
      mid900["smart"] and (mid900["flags"] & GRID_FLAG_F0UNC) != 0)

look = match_smart_grid({
    "hops_mhz": [2400.4, 2401.4, 2410.4, 2450.4],
    "fhss": {
        "hit": True,
        "unique": 4,
        "hopSetMhz": [2400.4, 2401.4, 2410.4, 2450.4],
        "spacingMhz": 1.0,
        "f0AbsMhz": 2400.4,
        "f0ResidualMhz": 0.4,
    },
})
check("look-first: n=4 F0=2400.4, не каталог 80",
      look["smart"] and look["n"] == 4 and look["f0_hz"] == 2_400_400_000
      and look["kind"] == GRID_KIND_FHSS and look["preset"] != CH_PRESET_ELRS)

print("smart_grid: ALL PASS")
