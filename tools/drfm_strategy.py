#!/usr/bin/env python3
"""Стратегия живого DRFM — зеркало app/src/sense/drfmStrategy.ts.

Хост выбирает отводы/FTW. NIOS не switch(kind). aim NCO не трогаем.
ELRS: two-ray 0/64 ≈ 1/B @ BW_0800 (ExpressLRS common.cpp / LBT.cpp).
ZC: 15 кГц = 1 SCS DroneID (Schiller 2023 / proto17). LB_FTW0, не aim.
Mux уже ×0.9 — tap amp 0.5, не 29491.
"""
from __future__ import annotations

from typing import Any

GRID_KIND_ZC = 4
GRID_FLAG_ZC = 1 << 2

DRFM_TAP0 = 0
DRFM_TAP1_TWORY = 64
DRFM_AMP_HALF = 16384
DRFM_ZC_SHIFT_HZ = 15_000
DRFM_ZC_SHIFT_ALT_HZ = 20_000

DRFM_TWORY_RU = "drfm · two-ray 0/64"
DRFM_ZC_RU = "drfm · ZC CFO 15 кГц"


def drfm_ftw_from_hz(hz: float, fs_hz: float) -> int:
    if fs_hz <= 0 or abs(hz) < 0.5:
        return 0
    return int(round(hz / fs_hz * (1 << 32))) & 0xFFFFFFFF


def wants_zc_drfm(card: dict[str, Any] | None) -> bool:
    if not card:
        return False
    flags = int(card.get("flags") or 0)
    return (flags & GRID_FLAG_ZC) != 0


def _clamp_delay(n: float) -> int:
    if n < 0:
        return 0
    return min(4095, int(round(n)))


def plan_drfm_strategy(
    card: dict[str, Any] | None,
    fs_hz: float,
    override: dict[str, Any] | None = None,
) -> dict[str, Any]:
    fs = float(fs_hz) if fs_hz and fs_hz > 0 else 56e6
    if wants_zc_drfm(card):
        s: dict[str, Any] = {
            "id": "zc-cfo",
            "delay0": DRFM_TAP0,
            "delay1": 0,
            "amp0": DRFM_AMP_HALF,
            "amp1": 0,
            "shift_hz": DRFM_ZC_SHIFT_HZ,
            "ftw": drfm_ftw_from_hz(DRFM_ZC_SHIFT_HZ, fs),
            "walk_step": 0,
            "walk_en": True,
            "wire": "shift",
            "reason": DRFM_ZC_RU,
        }
    else:
        s = {
            "id": "tworay",
            "delay0": DRFM_TAP0,
            "delay1": DRFM_TAP1_TWORY,
            "amp0": DRFM_AMP_HALF,
            "amp1": DRFM_AMP_HALF,
            "shift_hz": 0,
            "ftw": 0,
            "walk_step": 0,
            "walk_en": True,
            "wire": "none",
            "reason": DRFM_TWORY_RU,
        }
    o = override or {}
    if o.get("delay0") is not None and float(o["delay0"]) > 0:
        s["delay0"] = _clamp_delay(float(o["delay0"]))
    if o.get("delay1") is not None and float(o["delay1"]) >= 0:
        s["delay1"] = _clamp_delay(float(o["delay1"]))
    if o.get("amp0") is not None:
        s["amp0"] = max(0, min(32767, int(round(float(o["amp0"])))))
    if o.get("amp1") is not None:
        s["amp1"] = max(0, min(32767, int(round(float(o["amp1"])))))
    if o.get("walk_step") is not None and float(o["walk_step"]) >= 0:
        s["walk_step"] = int(round(float(o["walk_step"])))
    if o.get("ftw") is not None:
        s["ftw"] = int(o["ftw"]) & 0xFFFFFFFF
        s["shift_hz"] = 0
        s["wire"] = "none" if s["ftw"] == 0 else "ftw"
    elif o.get("shift_hz") is not None and abs(float(o["shift_hz"])) >= 0.5:
        s["shift_hz"] = float(o["shift_hz"])
        s["ftw"] = drfm_ftw_from_hz(s["shift_hz"], fs)
        s["wire"] = "shift"
    return s
