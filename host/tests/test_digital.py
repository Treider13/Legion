"""Цифровой режим: расчёт профилей и обход. Железо не нужно."""
import json
import math
from argparse import Namespace
from pathlib import Path

import numpy as np

from legion_rx.digital import (
    HOP_DWELL_US_DEFAULT, MAX_CORRIDOR_HZ, NIOS_SLOTS, PRESETS, PROFILE_HZ,
    QUEUE_AHEAD, TUNE_MARGIN, WAVES, WALKS, apply_preset, auto_tune, beats_elrs,
    build_pool, clamp_amp, corridor_freqs, corridor_n, digital_status_note,
    hop_dwell_us, hop_samples, job_from_args, make_wave, schedule_order,
    switch_s, walk_us,
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
    assert HOP_DWELL_US_DEFAULT == 100
    assert QUEUE_AHEAD == 14
    assert hop_samples(100) == 3400
    assert walk_us(8) == 800
    assert walk_us(16) == 1600
    assert walk_us(32) == 3200
    assert walk_us(56) == 5600
    assert walk_us(8, 20) == 160
    assert beats_elrs(8)["elrs_250"] and beats_elrs(8)["elrs_500"]
    assert beats_elrs(16)["elrs_250"] and beats_elrs(16)["elrs_500"]
    assert beats_elrs(32)["elrs_250"] and not beats_elrs(32)["elrs_500"]
    assert abs(switch_s(0) - 100e-6) < 1e-12
    assert abs(switch_s(8) - 100e-6) < 1e-12
    assert abs(switch_s(True) - 100e-6) < 1e-12
    assert abs(switch_s(False) - 100e-6) < 1e-12
    assert hop_dwell_us(20) == 20
    try:
        hop_dwell_us(19)
    except ValueError as exc:
        assert "20" in str(exc)
    else:
        raise AssertionError("dwell 19 прошёл")
    try:
        hop_dwell_us(10001)
    except ValueError as exc:
        assert "10000" in str(exc)
    else:
        raise AssertionError("dwell 10001 прошёл")
    assert clamp_amp(0.1) == 0.1
    try:
        clamp_amp(0.91)
    except ValueError as exc:
        assert "0.9" in str(exc)
    else:
        raise AssertionError("amp 0.91 прошёл")
    try:
        clamp_amp(0.09)
    except ValueError as exc:
        assert "0.1" in str(exc)
    else:
        raise AssertionError("amp 0.09 прошёл")


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
    assert t250["hop_us"] == 100
    assert t250["walk_us"] == 800
    assert t250["budget_us"] == 1000
    assert t250["fits"] is True
    assert t250["circles"] == 5
    assert t250["profile_hz"] == 7.0e6
    assert digital_status_note(t250, "sequential", "noise", 0.9) == (
        "цифровой: ELRS 250 Гц, 8 окон по 7 МГц, обход sequential, волна noise, "
        "dwell 100 мкс, круг 800 мкс, амплитуда 0.9, проходов за dwell 5"
    )
    t500 = apply_preset("elrs_500", one)
    assert t500["budget_us"] == 500
    assert t500["circles"] == 2
    assert t500["fits"] is True
    t50 = apply_preset("elrs_50", one)
    assert t50["n"] == 16
    assert t50["profile_hz"] == 3.5e6
    assert t50["walk_us"] == 1600
    assert t50["budget_us"] == 5000
    assert t50["fits"] is True
    over = apply_preset("elrs_250", one, profile_hz=3.5e6)
    assert over["n"] == 16
    assert over["walk_us"] == 1600
    assert over["budget_us"] == 1000
    assert over["fits"] is True
    legacy = apply_preset("elrs_250", one, hop_us=20)
    assert legacy["walk_us"] == 160
    assert legacy["circles"] == 25
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


def _cli(**kw):
    base = dict(
        f_start=None, f_end=None, digital_job=None, digital_walk=None,
        digital_wave=None, digital_static=None, digital_chirp=None,
        digital_saw_us=None, digital_amp=None, digital_tone_mhz=None,
        digital_preset=None, digital_profile_mhz=None, digital_dwell_ms=None,
        digital_dwell_us=None, digital_refresh_s=None, digital_collapse=None,
    )
    base.update(kw)
    return Namespace(**base)


def test_cli_wave_and_band_ignore_leftover_job_file():
    """Без --digital-job флаги бьют leftover JSON на диске."""
    job = job_from_args(_cli(
        f_start=2400e6, f_end=2407e6, digital_wave="noise",
        digital_profile_mhz=7, digital_walk="sequential",
    ))
    assert job["wave"] == "noise"
    assert len(job["corridors"]) == 1
    assert job["corridors"][0]["start_hz"] == 2400e6
    assert job["corridors"][0]["end_hz"] == 2407e6
    assert corridor_n(2400e6, 2407e6, 7e6) == 1
    assert job["hop_dwell_us"] == 100
    assert job["amp"] == 0.9
    hop20 = job_from_args(_cli(digital_dwell_us=20, digital_amp=0.8))
    assert hop20["hop_dwell_us"] == 20
    assert hop20["amp"] == 0.8
    try:
        job_from_args(_cli(digital_dwell_us=19))
    except ValueError as exc:
        assert "20" in str(exc)
    else:
        raise AssertionError("CLI dwell 19 прошёл")
    try:
        job_from_args(_cli(digital_amp=0.95))
    except ValueError as exc:
        assert "0.9" in str(exc)
    else:
        raise AssertionError("CLI amp 0.95 прошёл")


def test_digital_job_keeps_corridors_wave_override():
    import tempfile

    payload = {
        "corridors": [{"start_hz": 2400e6, "end_hz": 2456e6, "priority": 1}],
        "wave": "chirp",
        "walk": "sequential",
        "preset": "elrs_500",
        "profile_hz": 7e6,
    }
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "job.json"
        path.write_text(json.dumps(payload), encoding="utf-8")
        kept = job_from_args(_cli(
            digital_job=str(path), f_start=2400e6, f_end=2407e6,
        ))
        assert kept["wave"] == "chirp"
        assert kept["corridors"][0]["end_hz"] == 2456e6
        over = job_from_args(_cli(
            digital_job=str(path), f_start=2400e6, f_end=2407e6,
            digital_wave="noise",
        ))
        assert over["wave"] == "noise"
        assert over["corridors"][0]["end_hz"] == 2456e6


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
    live = inspect.getsource(digital.run_live)
    assert live.index("_fpga_digital(True)") < live.index("usb.acquire()")
    assert live.index("usb.acquire()") < live.rindex("_fpga_digital(False)")
    assert "if usb.open:" in live
    assert "стоп во время снимков" in live
    parsed = inspect.getsource(digital.job_from_args)
    assert "if job_path" in parsed
    assert "job = load_job()" not in parsed
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
    assert "if job_path" in inspect.getsource(digital.job_from_args)
    live = inspect.getsource(digital.run_live)
    assert "hop_samples(hop_us)" in live
    assert "ошибка: очередь пуста" in live
    assert "ошибка: метка в прошлом" in live
    assert live.index("usb.configure(") < live.index("usb.set_bandwidth(")
    cfg = inspect.getsource(usb.UsbOwner.configure)
    assert cfg.index("set_sample_rate") < cfg.index("set_frequency")
    assert cfg.index("set_frequency") < cfg.rindex("set_bandwidth")
