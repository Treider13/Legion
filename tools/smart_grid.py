#!/usr/bin/env python3
"""Карточка сетки умной атаки — зеркало app/src/sense/smartGrid.ts.

Слух хоста (hop-set / ZC / analog comb) → поля 0x51–0x59.
Пустой эфир не подставляет ELRS 2400.4. 5.8 analog — без умной сетки.
FreqCorrection: |shift|≤200 кГц @ 2.4 (ExpressLRS FHSS.cpp).
Порог канала на плате — occupancy (Sandia gr-fhss_utils / muccc gr-iridium),
не max-mag.
"""
from __future__ import annotations

from typing import Any

from protocol_db import ANALOG_CHANNELS, FHSS_DOMAINS

AIM_NONE = 0xFF
CH_PWR_THR_DEFAULT = 0x40
CH_THR_SLOT_DEFAULT = 256
CH_HYST_DEFAULT = 1
FREQCORR_MAX_HZ = 200_000
GRID_F0_KHZ_GATE = 10_000_000
C58_MHZ = 5100.0
XLAT_NULL_BINS = 16

GRID_KIND_UNKNOWN = 0
GRID_KIND_FHSS = 1
GRID_KIND_OFDM = 2
GRID_KIND_ANALOG = 3
GRID_KIND_ZC = 4
GRID_KIND_CW = 5

GRID_SRC_NONE = 0
GRID_SRC_MATCHER = 1
GRID_SRC_PRESET = 2
GRID_SRC_OPERATOR = 3

GRID_FLAG_WINLIM = 1 << 0
GRID_FLAG_F0UNC = 1 << 1
GRID_FLAG_ZC = 1 << 2
GRID_FLAG_FCORR = 1 << 3

CH_PRESET_MANUAL = 0
CH_PRESET_ELRS = 1
CH_PRESET_ISM8 = 2
CH_PRESET_O4VID3 = 3

EMPTY_RU = "сетка не собрана — не умная"
ANALOG_RU = "аналог 5.8 — сетка умной атаки не собирается"
X40_C58_RU = "x40 / LMS6002D не видит 5.8 ГГц — умная атака на C58 только на xA4"


def pack_grid_f0(f0_hz: int) -> int:
    hz = int(f0_hz)
    if hz <= 0:
        return 0
    if hz > 0xFFFFFFFF:
        return int(round(hz / 1000.0))
    return hz & 0xFFFFFFFF


def pack_grid_meta(n: int, n_used: int, conf: int, source: int, kind: int) -> int:
    return ((n & 0xFF) | ((n_used & 0xFF) << 8) | ((conf & 0xFF) << 16) |
            ((source & 0xF) << 24) | ((kind & 0xF) << 28)) & 0xFFFFFFFF


def pack_grid_flags(*, window_limited: bool = False, f0_unconfirmed: bool = False,
                    zc_hit: bool = False, freqcorr: bool = False,
                    hyp_index: int = 0, hyp_count: int = 0,
                    window_bins: int = XLAT_NULL_BINS) -> int:
    w = 0
    if window_limited:
        w |= GRID_FLAG_WINLIM
    if f0_unconfirmed:
        w |= GRID_FLAG_F0UNC
    if zc_hit:
        w |= GRID_FLAG_ZC
    if freqcorr:
        w |= GRID_FLAG_FCORR
    w |= (hyp_index & 0xF) << 4
    w |= (hyp_count & 0xFF) << 8
    w |= (window_bins & 0xFF) << 16
    return w & 0xFFFFFFFF


def xlat_window_mhz(fs_hz: float) -> float:
    fs = float(fs_hz) if fs_hz else 56e6
    return round((fs / XLAT_NULL_BINS) / 1e4) / 100.0


def empty_card(reason: str = EMPTY_RU) -> dict[str, Any]:
    return {
        "empty": True,
        "analog": False,
        "smart": False,
        "reason": reason,
        "f0_hz": 0,
        "step_hz": 0,
        "n": 0,
        "kind": GRID_KIND_UNKNOWN,
        "source": GRID_SRC_NONE,
        "shift_hz": 0,
        "pri_us": 0,
        "flags": pack_grid_flags(),
        "packed_f0": 0,
        "meta": 0,
        "preset": CH_PRESET_MANUAL,
        "ch_pwr_thr": 0,
        "ch_thr": 0,
        "ch_hyst": 0,
        "ch_mode": 0,
    }


def _finish(card: dict[str, Any]) -> dict[str, Any]:
    analog = bool(card.get("analog"))
    card_live = card["n"] > 0 and card["f0_hz"] > 0 and card["step_hz"] > 0
    preset_only = int(card.get("preset") or 0) == CH_PRESET_O4VID3 and not analog
    empty = analog or (not card_live and not preset_only)
    card["empty"] = empty
    card["smart"] = (not empty) and (not analog)
    card["packed_f0"] = pack_grid_f0(int(card["f0_hz"]))
    card["meta"] = pack_grid_meta(
        int(card["n"]), int(card["n"]), 180 if not analog else 0,
        int(card["source"]), int(card["kind"]))
    return card


def _hop_match(hops: list[float], domain: dict[str, Any]) -> dict[str, int] | None:
    spacing = float(domain.get("spacing") or 0)
    n = int(domain.get("n") or 0)
    if spacing <= 0 or n <= 0 or len(hops) < 2:
        return None
    step = spacing * 1e6
    f0 = float(domain["f0"]) * 1e6
    shifts: list[float] = []
    for h in hops:
        hz = h * 1e6
        k = int(round((hz - f0) / step))
        if k < 0 or k >= n:
            continue
        center = f0 + k * step
        sh = hz - center
        if abs(sh) <= step / 2 + 1:
            shifts.append(sh)
    if len(shifts) < 2:
        return None
    shifts.sort()
    shift = shifts[len(shifts) // 2]
    if domain.get("band") == "s24" and abs(shift) > FREQCORR_MAX_HZ:
        return None
    return {"shift_hz": int(round(shift)), "hits": len(shifts)}


def _nearest_analog(mhz: float, max_df: float = 2.0) -> bool:
    best = 1e9
    for _id, _band, ch in ANALOG_CHANNELS:
        d = abs(float(ch) - mhz)
        if d < best:
            best = d
    return best <= max_df


def match_smart_grid(inp: dict[str, Any]) -> dict[str, Any]:
    sdr = str(inp.get("sdr_id") or "")
    hops = [float(h) for h in (inp.get("hops_mhz") or []) if h]
    bands = inp.get("bands") or []
    if sdr == "bladerf-x40":
        if any(float(b.get("f2_mhz", b.get("f2Mhz", 0))) >= C58_MHZ for b in bands if isinstance(b, dict)):
            return empty_card(X40_C58_RU)
        if any(h >= C58_MHZ for h in hops):
            return empty_card(X40_C58_RU)

    op = inp.get("operator") or {}
    if op.get("f0_hz") and op.get("step_hz") and op.get("n"):
        n = min(80, max(1, int(op["n"])))
        f0 = int(op["f0_hz"])
        step = int(op["step_hz"])
        c58 = f0 >= int(C58_MHZ * 1e6)
        ofdm = int(op.get("kind") or 0) == GRID_KIND_OFDM or step >= 10_000_000
        return _finish({
            "analog": False,
            "reason": "карточка 5.8 (оператор)" if c58 else "карточка оператора",
            "f0_hz": f0,
            "step_hz": step,
            "n": n,
            "kind": int(op.get("kind") or (GRID_KIND_OFDM if ofdm else GRID_KIND_FHSS)),
            "source": GRID_SRC_OPERATOR,
            "shift_hz": 0,
            "pri_us": 0,
            "flags": pack_grid_flags(),
            "preset": CH_PRESET_O4VID3 if c58 else (CH_PRESET_ISM8 if ofdm and not c58 else CH_PRESET_ELRS),
            "ch_pwr_thr": 0 if ofdm and not c58 else CH_PWR_THR_DEFAULT,
            "ch_thr": CH_THR_SLOT_DEFAULT if ofdm and not c58 else 0,
            "ch_hyst": CH_HYST_DEFAULT,
            "ch_mode": 0 if ofdm and not c58 else 1,
        })

    if inp.get("accept_o4"):
        return _finish({
            "analog": False,
            "reason": "O4VID3 по умолчанию",
            "f0_hz": 0,
            "step_hz": 0,
            "n": 0,
            "kind": GRID_KIND_ZC,
            "source": GRID_SRC_PRESET,
            "shift_hz": 0,
            "pri_us": 0,
            "flags": pack_grid_flags(),
            "preset": CH_PRESET_O4VID3,
            "ch_pwr_thr": CH_PWR_THR_DEFAULT,
            "ch_thr": 0,
            "ch_hyst": CH_HYST_DEFAULT,
            "ch_mode": 0,
        })

    looks = inp.get("looks") or []
    analog = any(bool(l.get("analog_hit")) for l in looks)
    if analog or (any(h >= C58_MHZ for h in hops) and any(_nearest_analog(h) for h in hops if h >= C58_MHZ)
                  and not any(l.get("zc_hit") or l.get("kind") == "ofdm" for l in looks)):
        return _finish({
            "analog": True,
            "reason": ANALOG_RU,
            "f0_hz": 0,
            "step_hz": 0,
            "n": 0,
            "kind": GRID_KIND_ANALOG,
            "source": GRID_SRC_MATCHER,
            "shift_hz": 0,
            "pri_us": 0,
            "flags": pack_grid_flags(),
            "preset": CH_PRESET_MANUAL,
            "ch_pwr_thr": 0,
            "ch_thr": 0,
            "ch_hyst": 0,
            "ch_mode": 0,
        })

    zc = any(bool(l.get("zc_hit")) for l in looks)
    ofdm58 = any(l.get("kind") == "ofdm" and float(l.get("freq_mhz") or 0) >= C58_MHZ for l in looks)
    if zc or ofdm58:
        return _finish({
            "analog": False,
            "reason": "5.8 цифра · ZC 600/147" if zc else "5.8 цифра · OFDM",
            "f0_hz": 0,
            "step_hz": 0,
            "n": 0,
            "kind": GRID_KIND_ZC if zc else GRID_KIND_OFDM,
            "source": GRID_SRC_PRESET,
            "shift_hz": 0,
            "pri_us": 0,
            "flags": pack_grid_flags(zc_hit=zc),
            "preset": CH_PRESET_O4VID3,
            "ch_pwr_thr": CH_PWR_THR_DEFAULT,
            "ch_thr": 0,
            "ch_hyst": CH_HYST_DEFAULT,
            "ch_mode": 0,
        })

    win_lim = bool(inp.get("window_limited"))
    if len(hops) >= 2:
        scored: list[dict[str, Any]] = []
        for d in FHSS_DOMAINS:
            m = _hop_match(hops, d)
            if m:
                scored.append({"d": d, **m})
        scored.sort(key=lambda s: (-s["hits"], abs(s["shift_hz"])))
        if scored:
            best = scored[0]
            families = {s["d"]["family"] for s in scored if s["hits"] == best["hits"]}
            unconf = len(families) > 1
            s24 = best["d"].get("band") == "s24"
            elrs_like = s24 and abs(float(best["d"]["spacing"]) - 1.0) <= 0.05
            fcorr = s24 and 0 < abs(best["shift_hz"]) <= FREQCORR_MAX_HZ
            hop_span = max(hops) - min(hops)
            cropped = win_lim or hop_span > 56.5
            return _finish({
                "analog": False,
                "reason": (
                    f"FHSS {'/'.join(sorted(families))} — f0 не подтверждён" if unconf
                    else best["d"]["label"] + (f" · FreqCorrection {best['shift_hz']} Гц" if fcorr else "")
                ),
                "f0_hz": int(round(float(best["d"]["f0"]) * 1e6)),
                "step_hz": int(round(float(best["d"]["spacing"]) * 1e6)),
                "n": min(80, int(best["d"]["n"])),
                "kind": GRID_KIND_FHSS,
                "source": GRID_SRC_MATCHER,
                "shift_hz": int(best["shift_hz"]) if fcorr else 0,
                "pri_us": 0,
                "flags": pack_grid_flags(
                    window_limited=cropped, f0_unconfirmed=unconf,
                    freqcorr=fcorr, hyp_count=len(scored)),
                "preset": CH_PRESET_ELRS if elrs_like else CH_PRESET_MANUAL,
                "ch_pwr_thr": CH_PWR_THR_DEFAULT,
                "ch_thr": 0,
                "ch_hyst": CH_HYST_DEFAULT,
                "ch_mode": 1 if elrs_like else 0,
            })

    ofdm24 = any(
        l.get("kind") == "ofdm" and 2400 <= float(l.get("freq_mhz") or 0) <= 2480
        for l in looks)
    if ofdm24:
        return _finish({
            "analog": False,
            "reason": "ISM 2.4 · 8×10 МГц",
            "f0_hz": 2_400_000_000,
            "step_hz": 10_000_000,
            "n": 8,
            "kind": GRID_KIND_OFDM,
            "source": GRID_SRC_MATCHER,
            "shift_hz": 0,
            "pri_us": 0,
            "flags": pack_grid_flags(window_limited=win_lim),
            "preset": CH_PRESET_ISM8,
            "ch_pwr_thr": 0,
            "ch_thr": CH_THR_SLOT_DEFAULT,
            "ch_hyst": CH_HYST_DEFAULT,
            "ch_mode": 0,
        })

    return empty_card(EMPTY_RU)


if __name__ == "__main__":
    import json
    import sys
    raw = json.load(sys.stdin) if not sys.stdin.isatty() else {}
    json.dump(match_smart_grid(raw), sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")
