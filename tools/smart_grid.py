#!/usr/bin/env python3
"""Карточка сетки умной атаки — зеркало app/src/sense/smartGrid.ts.

Слух хоста (hop-set / ZC / analog comb) → поля 0x51–0x59.
Пустой эфир не подставляет ELRS 2400.4. 5.8 analog — без умной сетки.
FreqCorrection: |shift|≤200 кГц @ 2.4, ≤100 кГц @ 900 (ExpressLRS FHSS.h).
900 FCC915 903.5 vs mLRS 902.4: nearest residual, иначе оба ≤ 200/100 кГц.
Порог канала на плате — occupancy (Sandia gr-fhss_utils / muccc gr-iridium),
не max-mag.
"""
from __future__ import annotations

from typing import Any

from protocol_db import (
    ANALOG_CHANNELS,
    FHSS_DOMAINS,
    band_of,
    fhss_filter_residual,
    fhss_freqcorr_max_hz,
    fhss_residual_f0,
)

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
ARM_CLASS_RU = "класс не FHSS и не подтверждённый ZC — ARM отказан"
ARM_OVERRIDE_RU = "class_override: затвор класса обойдён"


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
    n_used = int(card.pop("n_used", card["n"]))
    card["meta"] = pack_grid_meta(
        int(card["n"]), n_used, 180 if not analog else 0,
        int(card["source"]), int(card["kind"]))
    return card


def _lattice_n(f0_mhz: float, spacing: float, hops: list[float], unique: int,
               f_high: float = 0.0) -> tuple[int, int]:
    """NIOS AIM: F0+ch·STEP, ch∈[0,n). n — решётка до последнего hop, не unique/80."""
    heard = max(0, int(unique))
    last = hops[-1] if hops else f0_mhz
    high = max(last, f_high) if f_high > 0 else last
    span_n = heard
    if spacing > 0 and high >= f0_mhz:
        span_n = int(round((high - f0_mhz) / spacing)) + 1
    if span_n < 1:
        span_n = heard
    return min(80, max(3, heard, span_n)), min(80, heard)


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
    band = str(domain.get("band") or "")
    if band in ("s24", "p900") and abs(shift) > fhss_freqcorr_max_hz(band):
        return None
    return {"shift_hz": int(round(shift)), "hits": len(shifts)}


def _nearest_analog(mhz: float, max_df: float = 2.0) -> bool:
    best = 1e9
    for _id, _band, ch in ANALOG_CHANNELS:
        d = abs(float(ch) - mhz)
        if d < best:
            best = d
    return best <= max_df


def _grid_from_measured_fhss(fhss: dict[str, Any] | None, hops: list[float],
                             window_limited: bool) -> dict[str, Any] | None:
    """GRID из look: F0=f0Abs, n=решётка до последнего hop. Не каталог 80 и не n=unique."""
    if not fhss or not fhss.get("hit"):
        return None
    hop_set = [float(h) for h in (
        fhss.get("hop_set_mhz") or fhss.get("hopSetMhz") or hops or []
    ) if h]
    hops_all = sorted(set(round(h, 3) for h in [*hop_set, *hops] if h > 0))
    unique = int(fhss.get("unique") or fhss.get("n_slots") or fhss.get("nSlots") or len(hops_all) or 0)
    if unique < 3 or len(hops_all) < 3:
        return None
    spacing = float(fhss.get("spacing_mhz") or fhss.get("spacingMhz") or 0.0)
    if spacing <= 0 and len(hops_all) >= 2:
        diffs = sorted(b - a for a, b in zip(hops_all, hops_all[1:]))
        spacing = diffs[len(diffs) // 2] if diffs else 0.0
    if spacing < 0.15:
        return None
    f0_abs = fhss.get("f0_abs_mhz")
    if f0_abs is None:
        f0_abs = fhss.get("f0AbsMhz")
    if f0_abs is None or float(f0_abs) < 50:
        residual, f_ref = fhss_residual_f0(hops_all, spacing)
        res = fhss.get("f0_residual_mhz", fhss.get("f0ResidualMhz", residual))
        f0_abs = f_ref + float(res if res is not None else residual)
    if float(f0_abs) < 50:
        return None
    f_high = float(fhss.get("f_high_mhz") or fhss.get("fHighMhz") or 0.0)
    n, n_used = _lattice_n(float(f0_abs), spacing, hops_all, unique, f_high)
    win = window_limited or bool(fhss.get("window_limited") or fhss.get("windowLimited"))
    return _finish({
        "analog": False,
        "reason": f"FHSS look · n={n} · слышал {n_used} · F0 {float(f0_abs):.3f}",
        "f0_hz": int(round(float(f0_abs) * 1e6)),
        "step_hz": int(round(spacing * 1e6)),
        "n": n,
        "n_used": n_used,
        "kind": GRID_KIND_FHSS,
        "source": GRID_SRC_MATCHER,
        "shift_hz": 0,
        "pri_us": 0,
        "flags": pack_grid_flags(window_limited=win),
        "preset": CH_PRESET_MANUAL,
        "ch_pwr_thr": CH_PWR_THR_DEFAULT,
        "ch_thr": 0,
        "ch_hyst": CH_HYST_DEFAULT,
        "ch_mode": 1 if abs(spacing - 1.0) <= 0.05 else 0,
    })


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

    fhss = inp.get("fhss") if isinstance(inp.get("fhss"), dict) else None
    if not fhss:
        for l in looks:
            cand = l.get("fhss") if isinstance(l, dict) else None
            if isinstance(cand, dict) and cand.get("hit"):
                fhss = cand
                break
    measured = _grid_from_measured_fhss(fhss, hops, win_lim)
    if measured and not measured.get("empty"):
        return measured

    if len(hops) >= 2:
        scored: list[dict[str, Any]] = []
        for d in FHSS_DOMAINS:
            m = _hop_match(hops, d)
            if m:
                scored.append({"d": d, **m})
        scored.sort(key=lambda s: (-s["hits"], abs(s["shift_hz"])))
        if scored:
            residual, f_ref = fhss_residual_f0(hops, float(scored[0]["d"]["spacing"]))
            mid = hops[len(hops) // 2] if len(hops) < 3 else sorted(hops)[len(hops) // 2]
            scored = fhss_filter_residual(
                scored,
                residual,
                f_ref,
                band_of(mid),
                f0_of=lambda s: s["d"]["f0"],
                step_of=lambda s: s["d"].get("spacing") or 0.0,
                hops_mhz=hops,
            )
            best = scored[0]
            families = {s["d"]["family"] for s in scored if s["hits"] == best["hits"]}
            unconf = len(families) > 1
            s24 = best["d"].get("band") == "s24"
            elrs_like = s24 and abs(float(best["d"]["spacing"]) - 1.0) <= 0.05
            gate_hz = fhss_freqcorr_max_hz(str(best["d"].get("band") or ""))
            fcorr = best["d"].get("band") in ("s24", "p900") and 0 < abs(best["shift_hz"]) <= gate_hz
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


def arm_class_ok(card: dict[str, Any] | None) -> bool:
    if not card or card.get("analog") or card.get("empty"):
        return False
    kind = int(card.get("kind") or 0)
    flags = int(card.get("flags") or 0)
    if kind == GRID_KIND_FHSS:
        return True
    if kind == GRID_KIND_ZC and (flags & GRID_FLAG_ZC) != 0:
        return True
    return False


def look_covers_hopset(card: dict[str, Any], look_mhz: float) -> bool:
    n = int(card.get("n") or 0)
    step = float(card.get("step_hz") or 0)
    if n <= 1 or step <= 0 or look_mhz <= 0:
        return True
    span_mhz = (n - 1) * step / 1e6
    return span_mhz <= look_mhz + 1e-9


def hop_map_next_mhz(card: dict[str, Any], current_mhz: float, look_mhz: float) -> float | None:
    if int(card.get("kind") or 0) != GRID_KIND_FHSS:
        return None
    if int(card.get("flags") or 0) & GRID_FLAG_F0UNC:
        return None
    if look_covers_hopset(card, look_mhz):
        return None
    f0 = (float(card.get("f0_hz") or 0) + float(card.get("shift_hz") or 0)) / 1e6
    step = float(card.get("step_hz") or 0) / 1e6
    n = int(card.get("n") or 0)
    if step <= 0 or n <= 1:
        return None
    ch = int(round((current_mhz - f0) / step))
    if ch < 0:
        ch = 0
    ch = (ch + 1) % n
    return round(f0 + ch * step, 3)


if __name__ == "__main__":
    import json
    import sys
    raw = json.load(sys.stdin) if not sys.stdin.isatty() else {}
    json.dump(match_smart_grid(raw), sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")
