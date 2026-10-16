"""Умная атака без склейки ряда.

Скан только отмечает частоты скачков и предлагает коридор 56 МГц.
Оператор может задать этот коридор сам, до запуска.
Удар — оцифровка DRFM, которая уже есть в прошивке: линия задержки
и смеситель сдвига. Таблица прыжков не пишется.
Окно оцифровки этой прошивки — 34 МГц (тактовая 68 МГц).
"""
from __future__ import annotations

import time

import numpy as np

CORRIDOR_HZ = 56.0e6
JAM_HZ = 0.5e6
SHIFT_HZ = 15_000
# pll_sclk закрыт на 68 МГц, выборка = половина. 56 МГц в один такт не влезают.
DIGITIZER_HZ = 34.0e6
LOOK_EVERY_S = 0.100
LOOK_FOR_S = 0.002
NFFT = 1024
MAX_WINDOWS = 16


def snap_corridor(f_start_hz: float) -> tuple[float, float]:
    """Ручной коридор: ширина всегда 56 МГц от заданного начала."""
    f1 = float(f_start_hz)
    return f1, f1 + CORRIDOR_HZ


def corridor_center(f1: float, f2: float) -> float:
    return 0.5 * (float(f1) + float(f2))


def propose_corridor(hops_hz) -> "tuple[float, float] | None":
    """Окно 56 МГц, в котором скачков больше всего. Ряд не склеивается."""
    hops = [float(h) for h in hops_hz if h is not None and np.isfinite(h)]
    if not hops:
        return None
    best_n = -1
    best = hops[0]
    width = CORRIDOR_HZ
    for start in hops:
        n = sum(1 for h in hops if start <= h <= start + width)
        if n > best_n or (n == best_n and start < best):
            best_n = n
            best = start
    return best, best + width


def window_centers(f1: float, f2: float) -> list[float]:
    """Стоянки приёма по ширине оцифровки. Не склейка спектра."""
    lo, hi = float(min(f1, f2)), float(max(f1, f2))
    width = DIGITIZER_HZ
    if hi - lo <= width:
        return [0.5 * (lo + hi)]
    step = width * 0.8
    centers = []
    x = lo + width / 2.0
    while x <= hi - width / 2.0 + 1.0 and len(centers) < MAX_WINDOWS:
        centers.append(x)
        x += step
    if not centers:
        centers.append(0.5 * (lo + hi))
    return centers


def _axis(lo_hz: float, n: int, fs_hz: float) -> np.ndarray:
    return float(lo_hz) + (np.arange(n) - n / 2.0) * (float(fs_hz) / float(n))


def hop_freqs(column_lin, lo_hz: float, fs_hz: float) -> list[float]:
    """Частоты вспышек одного столбца. Тишина — пустой список."""
    from .hop_recorder import isolate_bursts

    heard = np.asarray(isolate_bursts(column_lin), dtype=np.float64)
    if heard.size == 0:
        return []
    axis = _axis(lo_hz, heard.size, fs_hz)
    return [float(axis[i]) for i in range(heard.size) if float(heard[i]) > 1.0]


def find_hop_hz(column_lin, lo_hz: float, fs_hz: float) -> "float | None":
    """Самая сильная вспышка столбца. Тишина — нет скачка."""
    from .hop_recorder import isolate_bursts

    gated = np.asarray(isolate_bursts(column_lin), dtype=np.float64)
    if gated.size == 0:
        return None
    k = int(np.argmax(gated))
    if float(gated[k]) <= 1.0:
        return None
    return float(_axis(lo_hz, gated.size, fs_hz)[k])


def energy_still(column_lin, target_hz: float, lo_hz: float, fs_hz: float) -> bool:
    from .hop_recorder import isolate_bursts

    heard = np.asarray(isolate_bursts(column_lin), dtype=np.float64)
    if heard.size == 0 or target_hz is None:
        return False
    axis = _axis(lo_hz, heard.size, fs_hz)
    k = int(np.argmin(np.abs(axis - float(target_hz))))
    return float(heard[k]) > 1.0


def column_of(iq, fs_hz: float) -> np.ndarray:
    from .spectrogram import stft_db

    spec = np.asarray(stft_db(iq, NFFT, NFFT, np), dtype=np.float64)
    if spec.ndim == 1:
        db = spec
    elif spec.size == 0:
        return np.ones(NFFT, dtype=np.float64)
    else:
        db = spec[:, -1]
    return np.power(10.0, np.maximum(db, -120.0) / 10.0)


def _shift_ftw(shift_hz: float, fs_hz: float) -> int:
    fs = float(fs_hz)
    if fs <= 0.0:
        return 0
    return int(round(float(shift_hz) / fs * float(1 << 32))) & 0xFFFFFFFF


def run_live(span, args, log, pub, stop_event, note) -> int:
    survey = bool(getattr(args, "survey", False))
    if survey:
        return _survey(span, args, log, stop_event, note)
    f1, f2 = snap_corridor(span[0])
    return _attack((f1, f2), args, log, pub, stop_event, note)


def _survey(span, args, log, stop_event, note) -> int:
    """Слушает диапазон окнами оцифровки и предлагает один коридор 56 МГц."""
    from .pipeline import _UsbLive

    f1, f2 = float(span[0]), float(span[1])
    centers = window_centers(f1, f2)
    if note:
        note(
            f"скан {f1 / 1e6:.3f}–{f2 / 1e6:.3f} МГц, "
            f"окон {len(centers)}, склейки нет"
        )
    radio = _UsbLive(args, DIGITIZER_HZ, centers[0])
    radio.bw = DIGITIZER_HZ
    try:
        radio.start()
    except Exception as exc:
        if note:
            note(f"радио: {exc}")
        return 2
    heard: list[float] = []
    try:
        from .pipeline import retune_live_lo

        for lo in centers:
            if stop_event is not None and stop_event.is_set():
                break
            retune_live_lo(radio.usb, int(lo))
            radio.lo = float(lo)
            deadline = time.monotonic() + 0.15
            while time.monotonic() < deadline:
                if stop_event is not None and stop_event.is_set():
                    break
                fr = radio.read_frame(timeout=0.05)
                if fr is None:
                    continue
                heard.extend(hop_freqs(column_of(fr.complex64(), DIGITIZER_HZ), lo, DIGITIZER_HZ))
    finally:
        radio.stop()
    proposed = propose_corridor(heard)
    if proposed is None:
        if note:
            note("скан: скачков нет")
        log.write({"kind": "smart-survey", "hops": 0})
        return 0
    a, b = proposed
    if note:
        note(f"коридор предложен {a / 1e6:.3f}-{b / 1e6:.3f}")
    log.write({
        "kind": "smart-survey", "f_start": a, "f_end": b,
        "hits": len(heard), "windows": len(centers),
    })
    return 0


def _attack(span, args, log, pub, stop_event, note) -> int:
    """Один коридор. DRFM копирует приём в передачу со сдвигом, до Стоп."""
    from .pipeline import _UsbHandoff, _UsbLive, retune_live_lo

    f1, f2 = float(span[0]), float(span[1])
    lo = corridor_center(f1, f2)
    fs = DIGITIZER_HZ
    shift = int(getattr(args, "shift_hz", None) or SHIFT_HZ)
    look_every = float(getattr(args, "look_every_s", None) or LOOK_EVERY_S)
    look_for = float(getattr(args, "look_for_s", None) or LOOK_FOR_S)
    if note:
        note(
            f"коридор {f1 / 1e6:.3f}–{f2 / 1e6:.3f} МГц, "
            f"оцифровка {fs / 1e6:.0f} МГц по центру, "
            f"DRFM сдвиг {shift} Гц, удар {JAM_HZ / 1e6:.1f} МГц, до Стоп"
        )
    log.write({
        "kind": "smart56", "f_start": f1, "f_end": f2, "lo_hz": lo,
        "fs_hz": fs, "jam_hz": JAM_HZ, "shift_hz": shift,
    })
    radio = _UsbLive(args, fs, lo)
    radio.bw = fs
    try:
        radio.start()
    except Exception as exc:
        if note:
            note(f"радио: {exc}")
        return 2
    fpga = _UsbHandoff(radio)
    target = None
    tx_on = False
    next_look = time.monotonic() + look_every

    def _stopped() -> bool:
        return stop_event is not None and stop_event.is_set()

    def _arm(hop_hz: float) -> None:
        nonlocal target, tx_on
        rc = retune_live_lo(radio.usb, int(hop_hz), also_tx=True)
        if rc:
            raise RuntimeError(f"перенос несущей {rc}")
        radio.lo = float(hop_hz)
        if hasattr(radio.usb, "set_bandwidth"):
            radio.usb.set_bandwidth(0, int(JAM_HZ))
            radio.usb.set_bandwidth(1, int(JAM_HZ))
        from legion_fpga import twory_delay1

        fpga.set_live_drfm(
            delay0=0, delay1=twory_delay1(fs), ftw0=_shift_ftw(shift, fs), ftw1=0,
            amp0=32767, amp1=0, period=0, ftw_step=0)
        fpga.set_grid(meta=0, f0_hz=0, step_hz=0, pri_us=0, shift_hz=0, flags=0, rsv=0)
        from legion_fpga import MODE_LB_ALWAYS

        fpga.arm(MODE_LB_ALWAYS, True)
        fpga.yield_usb(reconfigure=False)
        if hasattr(radio.usb, "enable_tx"):
            radio.usb.enable_tx(True)
        target = float(hop_hz)
        tx_on = True
        if note:
            note(f"скачок {target / 1e6:.3f} МГц, DRFM сдвиг {shift} Гц, удар {JAM_HZ / 1e6:.1f} МГц")

    try:
        while not _stopped():
            fr = radio.read_frame(timeout=0.5)
            if fr is None:
                continue
            iq = fr.complex64()
            col = column_of(iq, fs)
            now = time.monotonic()
            if pub is not None and hasattr(pub, "send_spec"):
                db = 10.0 * np.log10(np.maximum(col, 1e-12))
                half = 0.5 * fs
                pub.send_wf_row(db, f_start_hz=radio.lo - half, f_end_hz=radio.lo + half)
                pub.send_spec(db)
            if target is None:
                hop = find_hop_hz(col, radio.lo, fs)
                if hop is None:
                    continue
                try:
                    _arm(hop)
                except Exception as exc:
                    if note:
                        note(f"DRFM: {exc}")
                    target = None
                continue
            if now < next_look:
                continue
            if hasattr(radio.usb, "enable_tx"):
                radio.usb.enable_tx(False)
            tx_on = False
            if hasattr(radio.usb, "set_bandwidth"):
                radio.usb.set_bandwidth(0, int(fs))
            deadline = time.monotonic() + look_for
            seen = None
            while time.monotonic() < deadline and not _stopped():
                fr = radio.read_frame(timeout=look_for)
                if fr is None:
                    break
                seen = column_of(fr.complex64(), fs)
            if seen is None or energy_still(seen, target, radio.lo, fs):
                if hasattr(radio.usb, "set_bandwidth"):
                    radio.usb.set_bandwidth(0, int(JAM_HZ))
                if hasattr(radio.usb, "enable_tx"):
                    radio.usb.enable_tx(True)
                tx_on = True
                if note and seen is not None:
                    note("взгляд: энергия на скачке есть")
            else:
                hop = find_hop_hz(seen, radio.lo, fs)
                if note:
                    note("взгляд: энергия пропала")
                if hop is None:
                    target = None
                else:
                    try:
                        _arm(hop)
                    except Exception as exc:
                        if note:
                            note(f"DRFM: {exc}")
                        target = None
            next_look = time.monotonic() + look_every
    finally:
        if tx_on and hasattr(radio.usb, "enable_tx"):
            try:
                radio.usb.enable_tx(False)
            except Exception:
                pass
        try:
            fpga.disarm()
        except Exception:
            pass
        try:
            fpga.close()
        except Exception:
            pass
        radio.stop()
    return 0
