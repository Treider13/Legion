"""Цифровой режим: расчёт профилей и обход. Железо не нужно."""
import math

import numpy as np

from legion_rx.digital import (
    MAX_CORRIDOR_HZ, NIOS_SLOTS, PRESETS, PROFILE_HZ, TUNE_MARGIN, WAVES, WALKS,
    apply_preset, auto_tune, beats_elrs, build_pool, corridor_freqs, corridor_n,
    make_wave, schedule_order, switch_s, walk_us,
)


def test_one_corridor_eight_profiles():
    freqs = corridor_freqs(2400e6, 2456e6)
    assert corridor_n(2400e6, 2456e6) == 8
    assert len(freqs) == 8
    assert freqs[0] == 2403.5e6
    assert freqs[-1] == 2452.5e6
    assert all(abs(b - a - PROFILE_HZ) < 1e-6 for a, b in zip(freqs, freqs[1:]))


def test_corridor_wider_than_56_is_refused():
    try:
        corridor_n(2400e6, 2460e6)
    except ValueError as exc:
        assert "56" in str(exc)
    else:
        raise AssertionError("широкий коридор прошёл")


def test_overlap_keeps_duplicates_when_asked():
    pool = build_pool([
        {"start_hz": 2400e6, "end_hz": 2456e6, "priority": 1},
        {"start_hz": 2428e6, "end_hz": 2484e6, "priority": 3},
    ], collapse=False)
    assert len(pool) == 16
    assert pool[4]["hz"] == pool[8]["hz"]
    assert pool[4]["priority"] == 1
    assert pool[8]["priority"] == 3
    assert pool[4]["index"] != pool[8]["index"]
    assert pool[4]["hw"] is False
    assert pool[8]["hw"] is True
    assert sum(1 for p in pool if p["hw"]) == 8
    assert all(p["hw"] for p in pool if p["priority"] == 3)
    assert not any(p["hw"] for p in pool if p["priority"] == 1)


def test_overlap_collapses_by_default():
    rows = [
        {"start_hz": 2400e6, "end_hz": 2456e6, "priority": 1},
        {"start_hz": 2428e6, "end_hz": 2484e6, "priority": 3},
    ]
    pool = build_pool(rows)
    assert len(pool) == 12
    assert len({round(p["hz"]) for p in pool}) == 12
    hit = [p for p in pool if abs(p["hz"] - 2431.5e6) < 1]
    assert len(hit) == 1
    assert hit[0]["priority"] == 3
    assert sum(1 for p in pool if p["hw"]) == 8


def test_walk_budget_matches_spec():
    assert walk_us(8) == 160
    assert walk_us(16) == 960
    assert walk_us(32) == 2560
    assert walk_us(56) == 4960
    assert beats_elrs(8)["elrs_250"] and beats_elrs(8)["elrs_500"]
    assert beats_elrs(16)["elrs_250"] and beats_elrs(16)["elrs_500"]
    assert beats_elrs(32)["elrs_250"] and not beats_elrs(32)["elrs_500"]
    assert switch_s(0) == 20e-6
    assert switch_s(8) == 100e-6
    assert switch_s(True) == 20e-6
    assert switch_s(False) == 100e-6


def test_walk_modes():
    pool = build_pool([
        {"start_hz": 2400e6, "end_hz": 2456e6, "priority": 1},
        {"start_hz": 2456e6, "end_hz": 2512e6, "priority": 1},
    ])
    seq = schedule_order("sequential", pool, 16, seed=1)
    assert seq == list(range(16))
    wrap = schedule_order("sequential", pool[:8], 20, seed=1)
    assert wrap == (list(range(8)) * 3)[:20]
    stat = schedule_order("static", pool, 8, seed=1, static_k=1)
    assert all(pool[i]["corridor"] == 1 for i in stat)
    rnd = schedule_order("random", pool, 40, seed=3)
    assert set(rnd) <= set(range(len(pool)))
    assert len(set(rnd)) > 1


def test_random_picks_corridor_by_priority():
    pool = build_pool([
        {"start_hz": 2400e6, "end_hz": 2456e6, "priority": 100},
        {"start_hz": 2456e6, "end_hz": 2512e6, "priority": 1},
    ])
    order = schedule_order("random", pool, 2000, seed=7)
    n0 = sum(1 for i in order if pool[i]["corridor"] == 0)
    assert n0 > 1800


def _span_hz(x, fs):
    dph = np.diff(np.unwrap(np.angle(x)))
    inst = dph * float(fs) / (2.0 * np.pi)
    return float(np.max(inst) - np.min(inst))


def test_waves_are_finite_and_bounded():
    for kind in WAVES:
        x = make_wave(kind, 4096, 34e6, amp=0.9, chirp_dir="down")
        assert x.dtype == np.complex64
        assert x.size == 4096
        assert np.isfinite(x).all()
        assert float(np.max(np.abs(x))) <= 0.91


def test_saw_and_fm_and_chirp_fill_7_mhz():
    fs = 34e6
    saw = make_wave("saw", 8192, fs, amp=0.9, saw_period_s=50e-6)
    fm = make_wave("fm", 8192, fs, amp=0.9)
    chirp = make_wave("chirp", 8192, fs, amp=0.9)
    tone = make_wave("tone", 8192, fs, amp=0.9)
    assert np.mean(np.abs(saw.imag)) > 0.2
    assert _span_hz(saw, fs) > 6e6
    assert _span_hz(fm, fs) > 6e6
    assert _span_hz(chirp, fs) > 6e6
    assert _span_hz(tone, fs) < 1e5


def test_finer_grid_is_half_and_quarter():
    half = corridor_freqs(2400e6, 2456e6, 3.5e6)
    assert corridor_n(2400e6, 2456e6, 3.5e6) == 16
    assert half[0] == 2401.75e6
    assert half[-1] == 2454.25e6
    quarter = corridor_freqs(2400e6, 2456e6, 1.75e6)
    assert len(quarter) == 32
    assert quarter[0] == 2400.875e6


def test_hw_slots_follow_priority():
    pool = build_pool([
        {"start_hz": 2400e6, "end_hz": 2456e6, "priority": 1},
        {"start_hz": 2456e6, "end_hz": 2512e6, "priority": 5},
    ])
    hw = [p for p in pool if p["hw"]]
    assert len(hw) == 8
    assert all(p["corridor"] == 1 for p in hw)


def test_nios_slot_ceiling():
    rows = [
        {"start_hz": 2400e6 + i * 80e6, "end_hz": 2456e6 + i * 80e6, "priority": 1}
        for i in range(32)
    ]
    pool = build_pool(rows)
    assert len(pool) == 256
    assert NIOS_SLOTS == 256
    try:
        build_pool(rows + [{
            "start_hz": 2400e6 + 32 * 80e6,
            "end_hz": 2456e6 + 32 * 80e6,
            "priority": 1,
        }])
    except ValueError as exc:
        assert "256" in str(exc)
    else:
        raise AssertionError("потолок NIOS пропущен")


def test_auto_tune_presets():
    one = [{"start_hz": 2400e6, "end_hz": 2456e6, "priority": 1}]
    t250 = apply_preset("elrs_250", one)
    assert t250["n"] == 8
    assert t250["walk_us"] == 160
    assert t250["budget_us"] == 1000
    assert t250["fits"] is True
    assert t250["circles"] == 25
    assert t250["profile_hz"] == 7.0e6
    t500 = apply_preset("elrs_500", one)
    assert t500["budget_us"] == 500
    assert t500["circles"] == 12
    assert t500["fits"] is True
    t50 = apply_preset("elrs_50", one)
    assert t50["n"] == 16
    assert t50["profile_hz"] == 3.5e6
    assert t50["walk_us"] == 960
    assert t50["budget_us"] == 5000
    assert t50["fits"] is True
    over = apply_preset("elrs_250", one, profile_hz=3.5e6)
    assert over["n"] == 16
    assert over["walk_us"] == 960
    assert over["budget_us"] == 1000
    assert over["fits"] is True
    t150 = apply_preset("elrs_150", one)
    assert t150["profile_hz"] == 7.0e6
    assert abs(t150["dwell_us"] - int(round(1e6 / 150.0))) <= 1
    xf = apply_preset("crossfire_868_150", one)
    assert xf["src"].startswith("fpga_control")
    assert "crossfire_915" not in PRESETS
    try:
        apply_preset("crossfire_915", one)
    except ValueError as exc:
        assert "crossfire_915" in str(exc)
    else:
        raise AssertionError("выдуманный 915 прошёл")
    assert TUNE_MARGIN == 4
    raw = auto_tune(one, 0.004, 7.0e6)
    assert raw["alts"]
    assert {a["profile_hz"] for a in raw["alts"]} == {7.0e6, 3.5e6, 1.75e6}


def test_fpga_digital_reg_is_not_hop_lut():
    import sys
    from pathlib import Path

    root = Path(__file__).resolve().parents[2]
    host = str(root / "fpga" / "host")
    if host not in sys.path:
        sys.path.insert(0, host)
    import legion_fpga as lf

    assert lf.REG_DIGITAL == 0x65
    assert lf.REG_DIGITAL != lf.REG_HOP_MUTE_NS
    assert lf.REG_DIGITAL != lf.REG_HOP_LUT
    assert lf.MODE_PASS == 0


def test_module_does_not_touch_smart_or_ordinary():
    import inspect

    from legion_rx import digital
    from legion_rx import pipeline
    from legion_rx import smart56

    src = inspect.getsource(digital)
    assert "smart56" not in src
    assert "set_live_drfm" not in src
    assert "hostTxWave" not in src
    assert "detectFromBins" not in src
    assert "_fpga_digital" in src
    assert "MODE_PASS" in src
    assert "apply_preset" in src
    assert "tx_only=True" in src
    assert "cancel_one" in src
    assert "collapse_pool" in src
    assert "REFRESH_S" in src
    assert "crossfire_915" not in src
    assert math.ceil(MAX_CORRIDOR_HZ / PROFILE_HZ) == 8
    assert "sequential" in WALKS
    cog = inspect.getsource(pipeline._run_cognitive_live)
    assert "smart56" in cog
    assert "digital" not in cog
    smart = inspect.getsource(smart56)
    assert "also_tx=True" in smart
    assert "set_live_drfm" in smart
    from legion_rx import libbladerf_owner as usb
    pair = inspect.getsource(usb.UsbOwner.capture_pair)
    one = inspect.getsource(usb.UsbOwner.capture_one)
    assert "MAX_PAIRS" in pair
    assert "digital_tunes" in one
    assert "digital_tunes" not in pair
