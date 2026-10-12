"""FHSS-память: corridor, PatternStore, drift, PDR, FSM, preload."""
import numpy as np
import pytest

import legion_fpga as lf
from legion_gateway import FakeTransport
from legion_rx.corridor import CorridorDetector, extract_subcorridor, in_subcorridor
from legion_rx.cognitive import (
    CognitiveFSM, CONFIRMING, JAMMING, LEARNING, LISTENING, MONITORING,
    TARGET_SILENT, DRIFT_DETECTED, RE_LEARNING,
)
from legion_rx.drift_detector import DriftDetector
from legion_rx.effectiveness_monitor import EffectivenessMonitor
from legion_rx.fpga_control import apply_predictive_jam, apply_profile
from legion_rx.fpga_preload import preload_hop_sequence
from legion_rx.hop_recorder import HopRecorder
from legion_rx.pattern_store import PatternStore


def _sub(f0=2400e6, f1=2483e6, pid="p0"):
    return extract_subcorridor([f0, f1], pid)


def _hops(n=16, start=10):
    return [{"channel_idx": start + i, "freq_mhz": 2400.0 + 0.2 * (start + i)}
            for i in range(n)]


def test_corridor_two_and_sub():
    det = CorridorDetector(k_sigma=3.0, min_width_bins=2)
    freqs = np.linspace(2000e6, 3000e6, 64)
    p = np.ones(64) * 1e-6
    p[8:12] = 1.0
    p[40:45] = 0.8
    out = None
    for i in range(8):
        out = det.update(p, freqs, i * 1e-3)
    assert len(out["corridors"]) == 2
    sub = extract_subcorridor([2400e6, 2483e6], "parent0")
    assert abs(sub["f_start"] - (2400e6 - 400e3)) < 1
    assert abs(sub["f_end"] - (2483e6 + 400e3)) < 1
    assert in_subcorridor(2440e6, sub)
    assert not in_subcorridor(2000e6, sub)


def test_pattern_store_add_and_match_same_sub():
    store = PatternStore()
    sub = _sub()
    hops = _hops(16)
    pid = store.add_pattern(sub, hops)
    m = store.find_match([h["channel_idx"] for h in hops[:10]],
                         sub["sub_corridor_id"], min_match=8)
    assert m is not None
    assert m[0] == pid
    assert m[2] >= 0.9
    other = extract_subcorridor([5725e6, 5850e6], "p1")
    assert store.find_match([h["channel_idx"] for h in hops[:10]],
                            other["sub_corridor_id"]) is None


def test_drift_lp_below_0_7():
    d = DriftDetector()
    assert d.update(0.9)["drift"] is False
    assert d.update(0.5)["drift"] is False
    assert d.update(0.4)["drift"] is False
    assert d.update(0.3)["drift"] is True


def test_effectiveness_low_pdr_effective():
    m = EffectivenessMonitor()
    m.mark_jam_applied()
    m.update(expected=10, observed=2)
    ev = m.evaluate()
    assert ev["pdr_target"] == pytest.approx(0.2)
    assert ev["verdict"] == "effective"


def test_apply_predictive_jam_requires_confirmed():
    t = FakeTransport(board="bladerf2")
    fpga = lf.LegionFpga(t)
    store = PatternStore()
    sub = _sub()
    pid = store.add_pattern(sub, _hops(16))
    pat = store.get(pid)
    with pytest.raises(ValueError, match="confirmed"):
        apply_predictive_jam(fpga, sub, pat, 0, 2440e6, 36e6)


def test_fpga_preload_20():
    t = FakeTransport(board="bladerf2")
    fpga = lf.LegionFpga(t)
    store = PatternStore()
    sub = _sub()
    hops = _hops(20)
    pid = store.add_pattern(sub, hops)
    store.mark_confirmed(pid)
    store.mark_confirmed(pid)
    store.mark_confirmed(pid)
    pre = preload_hop_sequence(fpga, store.get(pid), sub, next_n=20)
    assert pre["written"] == 20
    assert pre["lut_writes"] == 20


def test_apply_profile_36msps_plus_two():
    t = FakeTransport(board="bladerf2")
    fpga = lf.LegionFpga(t)
    from legion_rx.fpga_control import PROFILES
    assert apply_profile(fpga, PROFILES["elrs_24_2ray"], 36e6)
    assert t.regs[lf.REG_LB_DELAY1] == lf.twory_delay1(36e6) == 41
    assert lf.pipeline_extra_s(36e6) == pytest.approx(2 / 36e6)


def test_fsm_confirming_to_jam_and_monitor():
    t = FakeTransport(board="bladerf2")
    fpga = lf.LegionFpga(t)
    store = PatternStore()
    sub = _sub()
    hops = _hops(16)
    pid = store.add_pattern(sub, hops)
    fsm = CognitiveFSM(store, 64, 36e6, 2440e6, fpga=fpga, frame_dt_s=1e-3)
    fsm.state = CONFIRMING
    fsm.pid = pid
    fsm.sub = sub
    fsm.rec = HopRecorder(sub)
    fsm.rec.valid_count = 64
    fsm.rec.hops = hops
    fsm._live = [h["channel_idx"] for h in hops]
    fsm._confirm_base = 0
    store.mark_confirmed(pid)
    store.mark_confirmed(pid)
    fsm._tick_confirming(0.2)
    path = [x["to"] for x in fsm.transitions]
    assert JAMMING in path
    assert fsm.jams_sent >= 1
    assert fsm.state == MONITORING


def test_fsm_listening_constant():
    assert LISTENING == "LISTENING"
    assert LEARNING == "LEARNING"
    assert TARGET_SILENT == "TARGET_SILENT"
    assert DRIFT_DETECTED == "DRIFT_DETECTED"
    assert RE_LEARNING == "RE_LEARNING"
