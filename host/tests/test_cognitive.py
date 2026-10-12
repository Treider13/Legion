"""Когнитивный контур FHSS-памяти (ТЗ п.1–12): corridor, recorder, store,
hopmap-интеграция, monitors, fpga jam/preload, FSM end-to-end."""
import numpy as np
import pytest

import legion_fpga as lf
from legion_gateway import FakeTransport
from legion_rx import fpga_control as fc
from legion_rx.cognitive import (CONFIRMING, DRIFT_DETECTED, JAMMING,
                                 LEARNING, LISTENING, MONITORING,
                                 RE_ACQUIRE, RE_LEARNING, TARGET_SILENT,
                                 CognitiveFSM)
from legion_rx.corridor import CorridorDetector, extract_subcorridor
from legion_rx.drift_detector import DriftDetector
from legion_rx.effectiveness_monitor import EffectivenessMonitor
from legion_rx.fpga_preload import preload_hop_sequence
from legion_rx.hop_recorder import HopRecorder
from legion_rx.hopmap import (check_pattern_drift, match_and_predict)
from legion_rx.pattern_store import (PatternStore, classify_sequence_type)

FS = 20.0e6
LO = 2400e6
M = 64
CYCLE = [28, 33, 31, 25, 38, 30, 41, 27, 35, 22, 39, 24]  # 12 каналов, цикл


def _freqs(m=M):
    return np.asarray([(k - (m if k >= m // 2 else 0)) * FS / m + LO
                       if False else ((k if k < m // 2 else k - m) * FS / m + LO)
                       for k in range(m)])


def air_frame(chan, m=M, peak=100.0, noise=1.0):
    v = np.full(m, noise)
    if chan is not None:
        v[chan] = peak
    return v


def air_cycle(n_frames, cycle=CYCLE, shift=0, silent_from=None, **kw):
    out = []
    for i in range(n_frames):
        if silent_from is not None and i >= silent_from:
            out.append(air_frame(None, **kw))
        else:
            out.append(air_frame((cycle[i % len(cycle)] + shift) % 64, **kw))
    return out


def make_store_with_pattern(confirmed=True):
    store = PatternStore()
    sub = extract_subcorridor([float(_freqs()[c]) for c in CYCLE], "parent-1")
    hops = [{"channel_idx": c, "freq_mhz": float(_freqs()[c]) / 1e6,
             "dwell_us": 1000.0, "t_start": i * 1e-3, "confidence": 0.9,
             "seq_num": i} for i, c in enumerate(CYCLE * 3)]
    pid = store.add_pattern(sub, hops)
    if confirmed:
        for _ in range(3):
            store.mark_confirmed(pid)
    return store, pid, sub


# ---------------------------------------------------------------- corridor

def test_corridor_two_found():
    det = CorridorDetector()
    f = _freqs()
    for i in range(4):
        v = np.full(M, 1.0)
        v[10:14] = 100.0   # коридор 1
        v[40:44] = 100.0   # коридор 2
        out = det.update(v, f, i * 1e-3)
    ids = {(c["f_start"], c["f_end"]) for c in out["corridors"]}
    assert len(out["corridors"]) >= 2
    spans = {c["f_end"] - c["f_start"] for c in out["corridors"]}
    assert len(ids) >= 2 and all(s > 0 for s in spans)


def test_corridor_fhss_vs_narrowband():
    f = _freqs()
    det_fhss = CorridorDetector()
    for i, v in enumerate(air_cycle(20)):
        det_fhss.update(v, f, (i + 1) * 1e-3)
    p_fhss = det_fhss.posterior()
    det_nb = CorridorDetector()
    for i in range(20):
        det_nb.update(air_frame(30), f, (i + 1) * 1e-3)
    p_nb = det_nb.posterior()
    assert p_fhss["p_hopping"] > 0.6, p_fhss
    assert p_nb["p_hopping"] <= 0.6, p_nb
    assert p_fhss["hop_rate_hz"] == pytest.approx(1000.0, rel=0.3)


def test_extract_subcorridor_exact():
    sub = extract_subcorridor([2400e6, 2483e6, 2440e6], "parent-1")
    assert sub["f_start"] == pytest.approx(2399.6e6)
    assert sub["f_end"] == pytest.approx(2483.4e6)
    assert sub["parent_corridor_id"] == "parent-1"
    assert sub["sub_corridor_id"]


# ---------------------------------------------------------------- recorder

def test_hop_recorder_commits_at_16():
    sub = extract_subcorridor([float(_freqs()[c]) for c in CYCLE], "p")
    rec = HopRecorder(sub)
    for i, v in enumerate(air_cycle(20)):
        rec.update(v, _freqs(), (i + 1) * 1e-3)
    assert rec.valid_count >= 16
    store = PatternStore()
    pid = rec.maybe_commit(store)
    assert pid and store.patterns[pid]["status"] == "pending"
    h0 = store.patterns[pid]
    assert h0["hop_sequence"][:4] == CYCLE[:4]  # первый hop — закрытие ch0


# ---------------------------------------------------------------- store

def test_store_match_same_sub():
    store, pid, sub = make_store_with_pattern()
    m = store.find_match(CYCLE[:10], sub["sub_corridor_id"], min_match=8)
    assert m is not None and m[0] == pid
    assert m[2] >= 0.90
    assert m[1] == 9  # позиция последнего живого скачка в цикле


def test_store_no_match_other_sub():
    store, pid, sub = make_store_with_pattern()
    assert store.find_match(CYCLE[:10], "other-sub", min_match=8) is None


def test_classify_sequence_type():
    assert classify_sequence_type([1, 5, 9, 13, 17, 21] * 4) == "table_based"
    assert classify_sequence_type([1, 1, 5, 5, 9, 9] * 3) == "pseudo_random"
    rng = np.random.default_rng(1)
    assert classify_sequence_type(list(rng.permutation(48))) == "adaptive_afh"


# ---------------------------------------------------------------- hopmap

def test_hopmap_match_and_predict():
    store, pid, sub = make_store_with_pattern()
    pid2, nxt, lp = match_and_predict(store, CYCLE[:10], sub["sub_corridor_id"])
    assert pid2 == pid and nxt == CYCLE[10] and lp >= 0.90


def test_hopmap_check_pattern_drift():
    store, pid, sub = make_store_with_pattern()
    assert check_pattern_drift(store, pid, CYCLE[:10]) is False
    shifted = [(c + 20) % 64 for c in CYCLE[:10]]
    assert check_pattern_drift(store, pid, shifted) is True


# ---------------------------------------------------------------- monitors

def test_effectiveness_monitor():
    eff = EffectivenessMonitor()
    for _ in range(10):
        eff.update(expected=1, observed=1)
    assert eff.pdr == 1.0
    eff.mark_jam_applied()
    assert eff.evaluate()["verdict"] == "ineffective"
    for _ in range(32):
        eff.update(expected=1, observed=0)
    assert eff.evaluate()["verdict"] == "effective"
    assert eff.fer == pytest.approx(1.0 - eff.pdr)


def test_drift_detector():
    d = DriftDetector()
    assert d.update(0.5)["drift"] is False
    assert d.update(0.6)["drift"] is False
    assert d.update(0.4)["drift"] is True  # 3 цикла < 0.7
    d.reset()
    assert d.update(0.9)["drift"] is False


# ---------------------------------------------------------------- fpga

def test_apply_predictive_jam_in_sub():
    store, pid, sub = make_store_with_pattern()
    pat = store.get(pid)
    fpga = lf.LegionFpga(FakeTransport(board="bladerf2"))
    jam = fc.apply_predictive_jam(fpga, sub, pat, position=3, lo_hz=LO,
                                  fs_hz=FS, horizon=2)
    assert len(jam["plan"]) == 2
    e = jam["plan"][0]
    assert e.f_jam_hz == pytest.approx(pat["freqs_mhz"][4] * 1e6)
    assert sub["f_start"] <= e.f_jam_hz <= sub["f_end"]  # только sub!
    t = fpga._t
    assert t.regs[lf.REG_LB_AMP] & 0xFFFF == fc.q15(0.90)
    assert t.regs[lf.REG_LB_FTW] == fc.ftw_from_hz(e.f_jam_hz - LO, FS)
    assert ((t.regs[lf.REG_CTRL] >> 1) & 0x7) == lf.MODE_LB_ALWAYS
    assert jam["per_write_ms"][0] >= 0.0


def test_apply_predictive_jam_rejects_parent_and_unconfirmed():
    store, pid, sub = make_store_with_pattern()
    pat = store.get(pid)
    fpga = lf.LegionFpga(FakeTransport(board="bladerf2"))
    pat["freqs_mhz"][4] = (sub["f_end"] + 1e6) / 1e6  # выход за sub
    with pytest.raises(ValueError, match="parent"):
        fc.apply_predictive_jam(fpga, sub, pat, position=3, lo_hz=LO, fs_hz=FS)
    store2, pid2, sub2 = make_store_with_pattern(confirmed=False)
    with pytest.raises(ValueError, match="confirmed"):
        fc.apply_predictive_jam(fpga, sub2, store2.get(pid2), position=0,
                                lo_hz=LO, fs_hz=FS)


def test_stop_jam():
    fpga = lf.LegionFpga(FakeTransport(board="bladerf2"))
    store, pid, sub = make_store_with_pattern()
    fc.apply_predictive_jam(fpga, sub, store.get(pid), position=0,
                            lo_hz=LO, fs_hz=FS)
    assert fc.stop_jam(fpga)
    t = fpga._t
    assert t.regs[lf.REG_CTRL] == 0
    assert t.regs[lf.REG_LB_AMP] == 0
    assert t.regs[lf.REG_PROTO_PERIOD] == 0


def test_preload_hop_sequence_20():
    store, pid, sub = make_store_with_pattern()
    pat = store.get(pid)
    fpga = lf.LegionFpga(FakeTransport(board="bladerf2"))
    out = preload_hop_sequence(fpga, pat, sub, position=0, next_n=20,
                               lo_hz=LO)
    assert out["written"] == 20
    assert out["per_write_ms"]["max"] >= out["per_write_ms"]["min"] >= 0.0
    t = fpga._t
    assert (t.regs[lf.REG_GRID_META] & 0xFF) == 20
    assert t.regs[lf.REG_GRID_F0_HZ] != 0


# ---------------------------------------------------------------- FSM

def _run_fsm(frames, shift_at=None, shift=20):
    store = PatternStore()
    fpga = lf.LegionFpga(FakeTransport(board="bladerf2"))
    fsm = CognitiveFSM(store, M, FS, LO, fpga=fpga, frame_dt_s=1e-3)
    f = _freqs()
    for i, v in enumerate(frames):
        if shift_at is not None and i >= shift_at:
            vv = v.copy()
            peak = int(np.argmax(v))
            if v[peak] > 2:
                vv[peak] = 1.0
                vv[(peak + shift) % 64] = 100.0
            v = vv
        fsm.tick(v, f, (i + 1) * 1e-3)
    return fsm, store, fpga


def test_fsm_full_cycle_silent_reacquire():
    frames = (air_cycle(120) + air_cycle(140, silent_from=0) +
              air_cycle(60))
    fsm, store, fpga = _run_fsm(frames)
    path = [t["to"] for t in fsm.transitions]
    assert LEARNING in path and CONFIRMING in path
    assert JAMMING in path and MONITORING in path
    assert TARGET_SILENT in path
    assert RE_ACQUIRE in path
    assert path[-1] == MONITORING
    assert fsm.jams_sent >= 1
    # немедленная помеха: JAMMING и confirms=3 — один тик
    jam_tick = next(t["tick"] for t in fsm.transitions if t["to"] == JAMMING)
    mon_tick = next(t["tick"] for t in fsm.transitions
                    if t["to"] == MONITORING and t.get("confirms"))
    assert jam_tick == mon_tick  # без лишнего цикла — НЕМЕДЛЕННО
    t = fpga._t
    # после RE_ACQUIRE → JAMMING: контур снова взведён (быстрый удар)
    assert t.regs[lf.REG_CTRL] & lf.CTRL_ARM
    assert ((t.regs[lf.REG_CTRL] >> 1) & 0x7) == lf.MODE_LB_ALWAYS


def test_fsm_drift_relearns():
    frames = air_cycle(400)
    fsm, store, fpga = _run_fsm(frames, shift_at=150, shift=20)
    path = [t["to"] for t in fsm.transitions]
    assert DRIFT_DETECTED in path
    assert RE_LEARNING in path
    pid = fsm.pid
    rec = store.get(pid)
    assert rec["legacy"], "старый паттерн обязан уйти в legacy (не удалён)"
    assert rec["hop_sequence"][0] != CYCLE[1] or rec["status"] in (
        "pending", "confirmed")


def test_no_jam_without_confirmed():
    frames = air_cycle(30)  # только обучение: < 3 подтверждений
    fsm, store, fpga = _run_fsm(frames)
    assert fsm.jams_sent == 0
    assert fsm.state in (LEARNING, CONFIRMING, LISTENING)
