"""Стоянки LO для пятна шире одного окна 34 МГц.

Окно = fs (±fs/2 от центра). Шаг = fs × 0.85.
Пятно не шире fs — одна стоянка. Иначе
N = ceil((f_max − f_min − fs) / step) + 1.
Последняя стоянка накрывает f_max.
Больше 8 стоянок — восемь самых плотных по числу прыжков.
Интервал не расширяется: шаг шире fs снова сворачивает частоту.
"""
from __future__ import annotations

import math

FS_HZ = 34.0e6
STEP_FRAC = 0.85
MAX_PROFILES = 8


def plan_stations(f_min: float, f_max: float, fs_hz: float = FS_HZ,
                  hop_hz: "list[float] | None" = None) -> dict:
    lo, hi = float(min(f_min, f_max)), float(max(f_min, f_max))
    fs = float(fs_hz)
    width = hi - lo
    step = fs * STEP_FRAC
    if width <= fs or fs <= 0:
        centers = [(lo + hi) / 2.0]
    else:
        n = int(math.ceil((width - fs) / step)) + 1
        centers = [lo + fs / 2.0 + i * step for i in range(n)]
    outside_hz = 0.0
    kept = list(centers)
    if len(kept) > MAX_PROFILES:
        hops = [float(h) for h in (hop_hz or [])]
        scored = []
        for c in kept:
            n_in = sum(1 for h in hops if abs(h - c) <= fs / 2.0)
            scored.append((n_in, c))
        scored.sort(key=lambda x: (-x[0], x[1]))
        kept = sorted(c for _, c in scored[:MAX_PROFILES])
        covered = []
        for h in hops:
            if any(abs(h - c) <= fs / 2.0 for c in kept):
                covered.append(h)
        if hops:
            outside = [h for h in hops if h not in covered]
            if outside:
                outside_hz = max(outside) - min(outside)
            else:
                outside_hz = 0.0
        else:
            dropped = [c for c in centers if c not in kept]
            outside_hz = (max(dropped) - min(dropped) + fs) if dropped else 0.0
    return {
        "fs_hz": fs,
        "step_hz": step,
        "centers_hz": kept,
        "n": len(kept),
        "n_full": len(centers),
        "outside_hz": float(outside_hz),
        "truncated": len(centers) > MAX_PROFILES,
    }


def station_groups(freqs_mhz: list, centers_hz: list[float],
                   fs_hz: float = FS_HZ) -> tuple[list[float], list[dict]]:
    """Частоты одного цикла, сложенные блоками по стоянкам.

    Блок LUT — непрерывный START..END. LO меняется только между блоками,
    не на каждом прыжке. Пустая стоянка в таблицу не входит.
    """
    half = float(fs_hz) / 2.0
    centers = [float(c) for c in centers_hz][:8]
    buckets: list[list[float]] = [[] for _ in centers]
    for raw in freqs_mhz:
        f_mhz = float(raw)
        f = f_mhz * 1e6
        inside = [k for k, c in enumerate(centers) if abs(f - c) <= half]
        if inside:
            k = inside[0]
        elif centers:
            k = min(range(len(centers)), key=lambda i: abs(f - centers[i]))
        else:
            continue
        buckets[k].append(f_mhz)
    grouped: list[float] = []
    slices: list[dict] = []
    slot = 0
    for k, bucket in enumerate(buckets):
        if not bucket or slot >= 8:
            continue
        start = len(grouped)
        room = 256 - start
        take = bucket[:room]
        if not take:
            break
        grouped.extend(take)
        end = len(grouped) - 1
        slices.append({
            "slot": slot,
            "start": start,
            "end": end,
            "lo_hz": centers[k],
            "n": end - start + 1,
        })
        slot += 1
        if len(grouped) >= 256:
            break
    return grouped, slices


def boundary_marks(slices: list[dict], dwell_s: float, t0_sample: int,
                   fs_hz: float, cycles: int = 6) -> list[dict]:
    """Метки только на границе стоянки. Первая стоянка уже стоит."""
    if not slices:
        return []
    cycle_n = int(slices[-1]["end"]) + 1
    step = max(1, int(round(float(dwell_s) * float(fs_hz))))
    out: list[dict] = []
    for cyc in range(max(1, int(cycles))):
        for sl in slices:
            if cyc == 0 and int(sl["start"]) == 0:
                continue
            hop_i = cyc * cycle_n + int(sl["start"])
            out.append({
                "window": int(sl["slot"]),
                "lo_hz": float(sl["lo_hz"]),
                "sample": int(t0_sample) + hop_i * step,
                "full_cal": False,
            })
    return out


def assign_windows(hop_hz: list[float], centers_hz: list[float],
                   fs_hz: float = FS_HZ) -> list[tuple[int, int]]:
    """(индекс прыжка, номер стоянки) по времени.

    Прыжок в перекрытии двух окон остаётся в текущем окне.
    """
    half = float(fs_hz) / 2.0
    centers = [float(c) for c in centers_hz]
    out: list[tuple[int, int]] = []
    current = 0
    for i, f in enumerate(hop_hz):
        f = float(f)
        inside = [k for k, c in enumerate(centers) if abs(f - c) <= half]
        if not inside:
            # Ближайшая стоянка. Дальше 100 МГц решает кэш профилей.
            current = min(range(len(centers)),
                          key=lambda k: abs(f - centers[k]))
        elif current in inside:
            pass
        else:
            current = inside[0]
        out.append((i, current))
    return out
