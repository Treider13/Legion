"""fpga_preload — LUT FHSS в FPGA (write_hop_lut + set_grid).

Индекс LUT 8 бит: 256 ячеек, адреса 0..255. Поле meta n тоже 8 бит,
256 в него не входит (клэмп 255; 0 в HDL — это TX_MUTE). Обход ряда
задаёт end_idx, не это поле. Cycle длиннее 256 — видимый префикс.
Host пишет CH_FS/CH_LO, затем HOP_LUT 0x5E, затем
GRID; FLAGS bit4 — последним. 0x31 — RX bin→ch, не hop.
HDL legion_lut_hop шагает индекс LUT по PRI_US (FLAGS bit4).
PROTO_PERIOD — запасной период в сэмплах и по-прежнему шаг DRFM walk.
Задержка USB preload — замер в лаборатории.
"""
from __future__ import annotations

import time

from . import fpga_control as fc

LUT_CAP = 256


def preload_hop_sequence(fpga, pattern: dict, sub_corridor: dict,
                         position: int = 0, next_n: "int | None" = None,
                         chan_step_hz: float = 200.0e3,
                         dwell_us: "int | None" = None,
                         autonomous: bool = False,
                         fs_hz: float = 34e6,
                         lo_hz: float = None) -> dict:
    """next_n позиций (от position) → LUT + GRID. Адреса 0..255.
    lo_hz обязателен. Порядок: FS/LO → HOP_LUT → GRID → FLAGS bit4."""
    from .corridor import in_subcorridor

    if lo_hz is None:
        raise ValueError(
            "preload: lo_hz обязателен — без CH_LO FTW считается от 0")

    cyc = pattern.get("cycle") or pattern["hop_sequence"]
    freqs = (pattern.get("freqs_mhz") or [])[: len(cyc)]
    if not cyc or len(freqs) < len(cyc):
        raise ValueError("preload: у паттерна нет freqs_mhz полной длины")
    cyc_n = len(cyc)
    visible = cyc_n > LUT_CAP
    n_pre = LUT_CAP if next_n is None else int(next_n)
    n_pre = max(1, min(n_pre, LUT_CAP, cyc_n if cyc_n else LUT_CAP))
    if autonomous and cyc_n > LUT_CAP:
        autonomous = False
        visible = True
    f0 = float(sub_corridor["f_start"])
    lat: list[float] = []
    written = 0
    lf = fc.lf
    phase = int(position) % max(1, cyc_n)

    t0 = time.perf_counter()
    ok = fpga.write_reg(lf.REG_CH_FS_HZ, int(round(float(fs_hz))) & 0xFFFFFFFF)
    lo_khz = int(round(float(lo_hz) / 1000.0))
    ok = fpga.write_reg(lf.REG_CH_LO_KHZ, lo_khz & 0xFFFFFFFF) and ok
    lat.append((time.perf_counter() - t0) * 1000.0)
    if not ok:
        raise RuntimeError("preload: запись CH_FS/CH_LO не удалась")

    for i in range(n_pre):
        idx = (phase + i) % cyc_n
        f_hz = freqs[idx] * 1e6
        if not in_subcorridor(f_hz, sub_corridor):
            raise ValueError(
                f"preload: f {f_hz / 1e6:.3f} МГц вне sub-corridor — стоп")
        ch = int(round((f_hz - f0) / chan_step_hz))
        if not (0 <= ch <= 0xFF):
            raise ValueError(f"preload: канал {ch} вне LUT 0..255")
        t0 = time.perf_counter()
        if not fpga.write_hop_lut(i, ch):
            raise RuntimeError(f"preload: запись HOP_LUT[{i}] не удалась")
        lat.append((time.perf_counter() - t0) * 1000.0)
        written += 1

    dwell = int(dwell_us if dwell_us is not None else
                pattern.get("dwell_us") or 1000)
    dwell = max(1, dwell)
    period_us = int(round(dwell * min(cyc_n, LUT_CAP)))
    flags = lf.GRID_FLAG_AUTONOMOUS if autonomous else 0
    meta = lf.pack_grid_f0(int(round(f0)))
    t0 = time.perf_counter()
    ok = fpga.set_grid(
        meta=lf.pack_grid_meta(n=written, n_used=written, conf=90,
                               source=lf.GRID_SRC_OPERATOR,
                               kind=lf.GRID_KIND_FHSS),
        f0_hz=meta, step_hz=int(chan_step_hz), pri_us=dwell,
        shift_hz=0, flags=flags, pwr_thr=0, rsv=phase)
    period_samp = max(1, int(round(period_us * 1e-6 * float(fs_hz))))
    pulse_samp = max(1, int(round(dwell * 1e-6 * float(fs_hz))))
    ok = fpga.set_proto_timing(period_samp, pulse_samp, 0) and ok
    ok = fpga.set_channelize(map_lut=True) and ok
    lat.append((time.perf_counter() - t0) * 1000.0)
    if not ok:
        raise RuntimeError("preload: запись GRID/CH_CTRL не удалась")
    lat_sorted = sorted(lat)
    return {"written": written, "lut_writes": written,
            "per_write_ms": {
                "p50": lat_sorted[len(lat_sorted) // 2],
                "max": lat_sorted[-1], "min": lat_sorted[0]},
            "chan_step_hz": chan_step_hz, "f0_hz": f0,
            "dwell_us": dwell, "period_us": period_us,
            "autonomous": autonomous, "phase": phase,
            "visible_only": visible, "lut_n": written}


def preload_drfm_shelf(fpga, pattern: dict, sub_corridor: dict,
                       fs_hz: float = 34e6, shift_hz: int = 15000,
                       mute_ns: int = 0, hop_start: int = 0,
                       hop_end: "int | None" = None,
                       hold_end: bool = False,
                       arm: bool = True) -> dict:
    """Килогерцы ряда, границы, задержки 0/64, амплитуда 32767.

    apply_predictive_jam при этом не вызывается: он затирает амплитуду.
    FLAGS автономности — последним, после полки.
    """
    lf = fc.lf
    freqs = pattern.get("freqs_mhz") or []
    if not freqs:
        raise ValueError("preload_drfm_shelf: нет freqs_mhz")
    n = min(LUT_CAP, len(freqs))
    # meta n — 8 бит. 256 адресов пишутся, в поле длины остаётся 255.
    for i in range(n):
        khz = int(round(float(freqs[i]) * 1000.0))
        if not fpga.write_hop_khz(i, khz):
            raise RuntimeError(f"preload_drfm_shelf: ячейка {i}")
    end = n - 1 if hop_end is None else int(hop_end)
    start = max(0, min(int(hop_start), end))
    end = max(start, min(end, n - 1))
    if not fpga.apply_hop_range(start, end):
        raise RuntimeError("preload_drfm_shelf: границы ряда")
    # 32767 в регистре, ЦАП уже умножает на 0.90.
    amp = (32767 & 0xFFFF)
    ok = fpga.write_reg(lf.REG_LB_DELAY, 0)
    ok = fpga.write_reg(lf.REG_LB_DELAY1, 64) and ok
    ok = fpga.write_reg(lf.REG_LB_AMP, amp) and ok
    ok = fpga.set_hop_mute_ns(int(mute_ns)) and ok
    dwell = int(pattern.get("dwell_us") or 1000)
    f0 = int(round(float(sub_corridor["f_start"])))
    ok = fpga.set_grid(
        meta=lf.pack_grid_meta(n=min(n, 255), n_used=min(n, 255), conf=90,
                               source=lf.GRID_SRC_OPERATOR,
                               kind=lf.GRID_KIND_FHSS),
        f0_hz=lf.pack_grid_f0(f0),
        step_hz=0,
        pri_us=max(1, dwell),
        shift_hz=int(shift_hz),
        flags=(lf.GRID_FLAG_AUTONOMOUS | (
            lf.GRID_FLAG_HOLD_END if hold_end else 0)) if arm else 0,
        rsv=0) and ok
    ok = fpga.write_reg(lf.REG_CH_FS_HZ, int(round(float(fs_hz))) & 0xFFFFFFFF) and ok
    if not ok:
        raise RuntimeError("preload_drfm_shelf: полка или сетка")
    return {"written": n, "shift_hz": int(shift_hz), "mute_ns": int(mute_ns)}
