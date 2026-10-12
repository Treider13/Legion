"""fpga_preload — LUT FHSS в FPGA (write_ch_lut + set_grid).

Индекс LUT 8 бит: n_pre ≤ 255. Cycle > 255 — видимый префикс, без
догрузки на ходу. Host пишет REG_GRID_PRI_US / PROTO_PERIOD / FLAGS / RSV.
GRID 0x51–0x57 в legion_regs.vhd — when others => null (NIOS-only).
PROTO_PERIOD шагает DRFM walk (delay/FTW), не индекс CH_LUT.
Автономный LUT-режим FPGA без таймера в HDL не работает.
Задержка USB preload — замер в лаборатории.
"""
from __future__ import annotations

import time

from . import fpga_control as fc

LUT_CAP = 255


def preload_hop_sequence(fpga, pattern: dict, sub_corridor: dict,
                         position: int = 0, next_n: "int | None" = None,
                         chan_step_hz: float = 200.0e3,
                         dwell_us: "int | None" = None,
                         autonomous: bool = False,
                         fs_hz: float = 36e6) -> dict:
    """next_n позиций (от position) → LUT + GRID. n ≤ 255.
    autonomous: flags|=GRID_FLAG_AUTONOMOUS, rsv=phase, proto period."""
    from .corridor import in_subcorridor

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
        if not fpga.write_ch_lut(i, ch):
            raise RuntimeError(f"preload: запись CH_LUT[{i}] не удалась")
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
