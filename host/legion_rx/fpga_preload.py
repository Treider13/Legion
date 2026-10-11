"""fpga_preload — предзагрузка FHSS-последовательности в FPGA (ТЗ п.7).

Механизм — существующий API legion_fpga.py КАК ЕСТЬ (без raw poke):
  - write_ch_lut(idx, ch): LUT позиции скачка → канал (REG_CH_LUT);
  - set_grid(...): сетка умной атаки (REG_GRID_*), meta kind=FHSS,
    source=OPERATOR; f0 = sub.f_start, step = шаг канала, pri = dwell;
  - set_channelize(map_lut=True): маршрут по LUT.

После предзагрузки FPGA работает АВТОНОМНО по карте (реактивная петля —
там же), ПК только корректирует при drift. Задержка записи — замер
в логе (per_write_ms); на USB полный preload 4–20 мс, per-hop 1–3 мс
(не «<1 мс» без замера, [W6]). FakeTransport — мкс, не эфир.
"""
from __future__ import annotations

import time

from . import fpga_control as fc

PRELOAD_N = 20  # дефолт ТЗ; FSM считает max(20, 2×cycle) с потолком 256
LUT_MAX = 256  # write_ch_lut: индекс аппаратно 8 бит (legion_fpga.py)


def preload_hop_sequence(fpga, pattern: dict, sub_corridor: dict,
                         position: int = 0, next_n: int = PRELOAD_N,
                         chan_step_hz: float = 200.0e3,
                         dwell_us: "int | None" = None) -> dict:
    """next_n позиций цикла (от position+1) → LUT + GRID в FPGA.
    Канал LUT: ch = round((f − sub.f_start) / chan_step). Все f обязаны
    лежать в sub-corridor (проверка жёсткая, parent ЗАПРЕЩЁН)."""
    from .corridor import in_subcorridor

    cyc = pattern.get("cycle") or pattern["hop_sequence"]
    freqs = (pattern.get("freqs_mhz") or [])[: len(cyc)]
    if not cyc or len(freqs) < len(cyc):
        raise ValueError("preload: у паттерна нет freqs_mhz полной длины")
    f0 = float(sub_corridor["f_start"])
    lat: list[float] = []
    written = 0
    lf = fc.lf
    for i in range(next_n):
        idx = (int(position) + 1 + i) % len(cyc)
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
    dwell = int(dwell_us if dwell_us is not None else 1000)
    meta = lf.pack_grid_f0(int(round(f0)))  # f0 может быть > 32 бит Гц → кГц
    t0 = time.perf_counter()
    ok = fpga.set_grid(
        meta=lf.pack_grid_meta(n=written, n_used=written, conf=90,
                               source=lf.GRID_SRC_OPERATOR,
                               kind=lf.GRID_KIND_FHSS),
        f0_hz=meta, step_hz=int(chan_step_hz), pri_us=dwell,
        shift_hz=0, flags=0, pwr_thr=0)
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
            "dwell_us": dwell}
