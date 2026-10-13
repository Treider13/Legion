"""Когнитивный контур FHSS-памяти (ТЗ п.1–12): corridor, recorder, store,
hopmap-интеграция, monitors, fpga jam/preload, FSM end-to-end."""
import numpy as np
import pytest

import legion_fpga as lf
from legion_gateway import FakeTransport
from legion_rx import fpga_control as fc
from legion_rx.cognitive import (CONFIRMING, DRIFT_DETECTED, INITIAL_SCAN,
                                 JAMMING, LEARNING, LISTENING, MONITORING,
                                 RE_ACQUIRE, RE_LEARNING, TARGET_SILENT,
                                 CognitiveFSM)
from legion_rx.corridor import CorridorDetector, extract_subcorridor
from legion_rx.drift_detector import DriftDetector
from legion_rx.effectiveness_monitor import EffectivenessMonitor
from legion_rx.fpga_preload import preload_hop_sequence
from legion_rx.hop_recorder import HopRecorder, isolate_bursts
from legion_rx.spectrogram import stft_db
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
    t = 0.0
    for v in air_cycle(20):
        for _rep in range(2):
            t += 1e-3
            det_fhss.update(v, f, t)
    p_fhss = det_fhss.posterior()
    det_nb = CorridorDetector()
    for i in range(20):
        det_nb.update(air_frame(30), f, (i + 1) * 1e-3)
    p_nb = det_nb.posterior()
    assert p_fhss["p_hopping"] > 0.6, p_fhss
    assert p_nb["p_hopping"] <= 0.6, p_nb
    assert p_fhss["hop_rate_hz"] == pytest.approx(500.0, rel=0.3)


def test_extract_subcorridor_exact():
    sub = extract_subcorridor([2400e6, 2483e6, 2440e6], "parent-1")
    assert sub["f_start"] == pytest.approx(2399.6e6)
    assert sub["f_end"] == pytest.approx(2483.4e6)
    assert sub["parent_corridor_id"] == "parent-1"
    assert sub["sub_corridor_id"]


# ---------------------------------------------------------------- recorder

def test_hop_recorder_commits_at_16():
    """Период CYCLE=12 виден после ≥8 сравнений (кадр ≥20) и коммитится
    при ≥2 циклах. 16 кадров период ещё не закрывают."""
    sub = extract_subcorridor([float(_freqs()[c]) for c in CYCLE], "p")
    rec = HopRecorder(sub)
    t = 0.0
    f = _freqs()
    for v in air_cycle(40):
        for _rep in range(2):
            t += 1e-3
            rec.update(v, f, t)
    assert rec.valid_count >= 2 * len(CYCLE)
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
    assert d.update(0.4)["drift"] is True  # 3 hops < 0.7
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
    step = 0
    for i, v in enumerate(frames):
        if shift_at is not None and i >= shift_at:
            vv = v.copy()
            peak = int(np.argmax(v))
            if v[peak] > 2:
                vv[peak] = 1.0
                vv[(peak + shift) % 64] = 100.0
            v = vv
        # Вспышка — два кадра выше пола. Один кадр в ряд не пишется.
        for _rep in range(2):
            step += 1
            fsm.tick(v, f, step * 1e-3)
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


def test_learning_row_is_not_wiped_at_two_minutes():
    """Ряд копится, пока не повторится. Две минуты учения его не стирают."""
    store = PatternStore()
    fpga = lf.LegionFpga(FakeTransport(board="bladerf2"))
    fsm = CognitiveFSM(store, M, 34e6, 2417e6, fpga=fpga,
                       scan_corridor=(2400e6, 2434e6), ibw_hz=34e6)
    fsm.state = LEARNING
    fsm._state_since = 0.0
    fsm._watch(121.0)
    assert fsm.state == LEARNING


def test_one_frame_is_not_a_hop_and_silence_closes():
    sub = extract_subcorridor([float(_freqs()[c]) for c in CYCLE], "p")
    rec = HopRecorder(sub)
    f = _freqs()
    assert rec.update(air_frame(28), f, 1e-3) is None
    assert rec.hops == []
    assert rec.update(air_frame(28), f, 2e-3) is None
    hop = rec.update(air_frame(None), f, 3e-3)
    assert hop is not None and hop["channel_idx"] == 28
    assert len(rec.hops) == 1
    # Слабее старого порога ×6, но выше пола — тоже вспышка, если держится два кадра.
    weak = HopRecorder(sub)
    soft = air_frame(30, peak=2.0, noise=1.0)
    assert weak.update(soft, f, 1e-3) is None
    assert weak.hops == []
    assert weak.update(soft, f, 2e-3) is None
    hop2 = weak.update(air_frame(None), f, 3e-3)
    assert hop2 is not None and hop2["channel_idx"] == 30


def test_flush_keeps_open_hop():
    sub = extract_subcorridor([float(_freqs()[c]) for c in CYCLE], "p")
    rec = HopRecorder(sub)
    f = _freqs()
    rec.update(air_frame(28), f, 1e-3)
    rec.update(air_frame(28), f, 2e-3)
    hop = rec.flush(3e-3, f)
    assert hop is not None and hop["channel_idx"] == 28
    assert rec.hops[-1]["channel_idx"] == 28


def test_operator_window_starts_row_without_score():
    store = PatternStore()
    fpga = lf.LegionFpga(FakeTransport(board="bladerf2"))
    fsm = CognitiveFSM(store, M, 34e6, 2417e6, fpga=fpga,
                       scan_corridor=(2400e6, 2434e6), ibw_hz=34e6)
    fsm.tick(air_frame(None), _freqs(), 1e-3)
    assert fsm.state == LEARNING
    wide = CognitiveFSM(store, M, 34e6, 2440e6, fpga=fpga,
                        scan_corridor=(2400e6, 2480e6), ibw_hz=34e6)
    wide.tick(air_frame(None), _freqs(), 1e-3)
    assert wide.state == INITIAL_SCAN
    assert len(wide.sweeper.windows) == 3
    hundred = CognitiveFSM(store, M, 34e6, 2450e6, fpga=fpga,
                           scan_corridor=(2400e6, 2500e6), ibw_hz=34e6)
    hundred.tick(air_frame(None), _freqs(), 1e-3)
    assert len(hundred.sweeper.windows) == 4


def test_stitch_drops_skirt_and_keeps_both_visits():
    from legion_rx.lo_sweep import EDGE_GUARD, LoSweeper

    sw = LoSweeper(ibw_hz=34e6, fs_hz=34e6)
    sw.setup(2400e6, 2480e6)
    assert len(sw.windows) == 3
    w0, w1 = sw.windows[0], sw.windows[1]
    span0 = w0["f_end"] - w0["f_start"]
    span1 = w1["f_end"] - w1["f_start"]
    edge = w0["f_start"] + 0.02 * span0
    a = max(w0["f_start"] + EDGE_GUARD * span0,
            w1["f_start"] + EDGE_GUARD * span1)
    b = min(w0["f_end"] - EDGE_GUARD * span0,
            w1["f_end"] - EDGE_GUARD * span1)
    assert b > a
    mid = 0.5 * (a + b)
    gap = int(round(0.01 * 34e6))
    sw.hops[0].append({
        "freq_mhz": edge / 1e6, "sample_count": 1000, "t_start": 0.0,
        "window": 0, "dwell_us": 500.0, "channel_idx": 1,
    })
    sw.hops[0].append({
        "freq_mhz": mid / 1e6, "sample_count": 2000, "t_start": 0.001,
        "window": 0, "dwell_us": 500.0, "channel_idx": 2,
    })
    sw.hops[1].append({
        "freq_mhz": mid / 1e6, "sample_count": 2000 + gap, "t_start": 0.02,
        "window": 1, "dwell_us": 500.0, "channel_idx": 2,
    })
    out = sw.stitch()
    freqs = [round(h["freq_mhz"], 3) for h in out]
    assert round(edge / 1e6, 3) not in freqs
    # Два разных момента одной частоты — два скачка. Картинка клеит шов отдельно.
    assert freqs.count(round(mid / 1e6, 3)) == 2
    assert out[-1]["hole"] is True


def test_corridor_middles_cover_band():
    from legion_rx.lo_sweep import EDGE_GUARD, plan_windows

    wins = plan_windows(2300e6, 2500e6, ibw_hz=34e6)
    assert len(wins) >= 2
    covered = []
    for w in wins:
        span = w["f_end"] - w["f_start"]
        g = EDGE_GUARD * span
        covered.append((w["f_start"] + g, w["f_end"] - g))
    assert covered[0][0] == pytest.approx(2300e6)
    assert covered[-1][1] == pytest.approx(2500e6)
    for (a0, b0), (a1, _b1) in zip(covered, covered[1:]):
        assert a1 <= b0 + 1.0
    # 2350–2440 целиком в серединах, без щели
    cursor = 2350e6
    for a, b in covered:
        if b < cursor or a > 2440e6:
            continue
        if a <= cursor:
            cursor = max(cursor, b)
    assert cursor >= 2440e6


def test_stitched_row_does_not_reopen():
    sub = extract_subcorridor([float(_freqs()[c]) for c in CYCLE], "p")
    rec = HopRecorder(sub)
    freq = float(_freqs()[28]) / 1e6
    rec.load_stitched([{
        "freq_mhz": freq, "sample_count": 1000, "dwell_us": 500.0,
        "t_start": 0.0, "hole": False,
    }])
    n = len(rec.hops)
    rec.update(air_frame(None), _freqs(), 1.0)
    assert len(rec.hops) == n


def test_hole_stays_in_the_jam_row():
    sub = extract_subcorridor([2400e6, 2480e6], "p")
    rec = HopRecorder(sub, n_chans=64)
    seq = [0, 1, 2, 3] * 6
    rec.hops = [{
        "channel_idx": c, "freq_mhz": 2400.0 + 0.2 * c,
        "dwell_us": 1000.0, "hole": i == 8,
    } for i, c in enumerate(seq)]
    rec.valid_count = len(rec.hops)
    store = PatternStore()
    pid = rec.maybe_commit(store)
    assert pid
    assert store.patterns[pid]["hop_sequence"] == seq
    assert rec.hops[8]["hole"] is True


def test_seam_blends_linear_power():
    from legion_rx.lo_sweep import stitch_power

    w0 = {"index": 0, "f_start": 2400e6, "f_end": 2434e6, "f_center": 2417e6}
    db, f0, f1 = stitch_power(
        {0: (2417e6, np.full(128, 100.0))}, [w0], 34e6, n_out=64)
    # На картинке коридор — середина окна, юбка фильтра в ось не входит.
    assert f0 == pytest.approx(2403.4e6, rel=1e-6)
    assert f1 == pytest.approx(2430.6e6, rel=1e-6)
    assert db[0] == pytest.approx(20.0, abs=1.0)
    assert db[len(db) // 2] == pytest.approx(20.0, abs=1.0)
    w1 = {"index": 1, "f_start": 2423e6, "f_end": 2457e6, "f_center": 2440e6}
    span0 = w0["f_end"] - w0["f_start"]
    span1 = w1["f_end"] - w1["f_start"]
    a = max(w0["f_start"] + 0.10 * span0, w1["f_start"] + 0.10 * span1)
    b = min(w0["f_end"] - 0.10 * span0, w1["f_end"] - 0.10 * span1)
    mid_f = 0.5 * (a + b)
    mixed, fa, fb = stitch_power(
        {0: (w0["f_center"], np.full(128, 100.0)),
         1: (w1["f_center"], np.full(128, 10.0))},
        [w0, w1], 34e6, n_out=256)
    axis = np.linspace(fa, fb, mixed.size)
    i = int(np.argmin(np.abs(axis - mid_f)))
    # 50/50 по мощности: 55 → ~17.4 дБ. Среднее децибел было бы 15.
    assert mixed[i] == pytest.approx(17.4, abs=1.5)
    # Стык без нахлёста не проваливается в −120.
    left = {"index": 0, "f_start": 2400e6, "f_end": 2434e6, "f_center": 2417e6}
    right = {"index": 1, "f_start": 2427.2e6, "f_end": 2461.2e6,
             "f_center": 2444.2e6}
    joined, ja, jb = stitch_power(
        {0: (left["f_center"], np.full(128, 100.0)),
         1: (right["f_center"], np.full(128, 100.0))},
        [left, right], 34e6, n_out=128)
    seam = np.linspace(ja, jb, joined.size)
    k = int(np.argmin(np.abs(seam - 2430.6e6)))
    assert joined[k] == pytest.approx(20.0, abs=1.5)


def test_dwell_uses_samples_not_wall_clock():
    """Скачок часов компьютера не заканчивает стоянку. Её заканчивают отсчёты."""
    from legion_rx.lo_sweep import LoSweeper

    sw = LoSweeper(ibw_hz=34e6, fs_hz=34e6)
    sw.arm_sample_dwell()
    sw.add_samples(int(0.003 * 34e6))
    assert sw.dwell_done(100.0, 0.0) is False
    sw.add_samples(int(0.002 * 34e6))
    assert sw.dwell_done(100.0, 0.0) is True
    sw.reset_dwell_samples()
    assert sw.dwell_done(100.0, 0.0) is False
    plain = LoSweeper(ibw_hz=34e6, fs_hz=34e6)
    assert plain.dwell_done(0.001, 0.0) is False
    assert plain.dwell_done(0.005, 0.0) is True


def test_weak_peak_just_above_its_floor_is_a_hop():
    """Дрон едва выше своего пола — это вспышка, если она держится два кадра."""
    sub = extract_subcorridor([float(_freqs()[c]) for c in CYCLE], "p")
    rec = HopRecorder(sub)
    f = _freqs()
    soft = air_frame(12, peak=1.02, noise=1.0)
    assert rec.update(soft, f, 1e-3) is None
    assert rec.hops == []
    assert rec.update(soft, f, 2e-3) is None
    hop = rec.update(air_frame(None), f, 3e-3)
    assert hop is not None and hop["channel_idx"] == 12


def test_minimal_burst_survives_neighbor_bin_and_a_weaker_second_frame():
    """Минимальная вспышка не гаснет: соседний бин и более тихий второй кадр."""
    sub = extract_subcorridor([float(_freqs()[c]) for c in CYCLE], "p")
    f = _freqs()
    wander = HopRecorder(sub)
    assert wander.update(air_frame(20, peak=1.01, noise=1.0), f, 1e-3) is None
    assert wander.update(air_frame(21, peak=1.01, noise=1.0), f, 2e-3) is None
    hop = wander.update(air_frame(None), f, 3e-3)
    assert hop is not None
    assert hop["channel_idx"] in (20, 21)
    weaker = HopRecorder(sub)
    assert weaker.update(air_frame(8, peak=1.02, noise=1.0), f, 1e-3) is None
    assert weaker.update(air_frame(8, peak=1.001, noise=1.0), f, 2e-3) is None
    hop2 = weaker.update(air_frame(None), f, 3e-3)
    assert hop2 is not None and hop2["channel_idx"] == 8
    lone = HopRecorder(sub)
    assert lone.update(air_frame(8, peak=1.02, noise=1.0), f, 1e-3) is None
    assert lone.update(air_frame(None), f, 2e-3) is None
    assert lone.hops == []


def test_frequency_set_opens_tx_when_order_changes():
    """Порядок другой, список тот же — три совпадения открывают передатчик.
    Сдвиг на 20 кГц (слабый бин гуляет) остаётся той же частотой."""
    store = PatternStore()
    fpga = lf.LegionFpga(FakeTransport(board="bladerf2"))
    fsm = CognitiveFSM(store, M, 34e6, 2440e6, fpga=fpga,
                       scan_corridor=(2400e6, 2500e6), ibw_hz=34e6)
    fsm.sub = extract_subcorridor([2400e6, 2500e6], "scan")
    fsm.state = LEARNING
    a = [2410.0, 2420.0, 2430.0, 2440.0]
    fsm.finish_pass(a, 1.0)
    assert fsm.state == LEARNING and fsm.jams_sent == 0
    fsm.finish_pass([2470.0, 2480.0, 2490.0, 2460.0], 1.5)
    assert fsm.state == LEARNING and fsm.jams_sent == 0
    wandered = [x + 0.02 for x in reversed(a)]
    fsm.finish_pass(a, 2.0)
    fsm.finish_pass(wandered, 2.5)
    assert fsm.state == CONFIRMING and fsm.jams_sent == 0
    fsm.finish_pass(a, 3.0)
    fsm.finish_pass(wandered, 4.0)
    fsm.finish_pass(list(reversed(a)), 5.0)
    assert fsm.jams_sent >= 1
    # Три из четырёх частот — не совпадение 0.9, удар не копится заранее.
    late = CognitiveFSM(PatternStore(), M, 34e6, 2440e6,
                        fpga=lf.LegionFpga(FakeTransport(board="bladerf2")),
                        scan_corridor=(2400e6, 2500e6), ibw_hz=34e6)
    late.sub = extract_subcorridor([2400e6, 2500e6], "scan")
    late.state = LEARNING
    late.finish_pass(a, 1.0)
    late.finish_pass(a[:3], 2.0)
    assert late.state == LEARNING and late.pid is None
    late.finish_pass(a, 3.0)
    assert late.state == CONFIRMING and late.jams_sent == 0


def test_hold_releases_exactly_one_window():
    """Пока блок ещё считается, стоянка не кончается. После — ровно одно окно."""
    fpga = lf.LegionFpga(FakeTransport(board="bladerf2"))
    fsm = CognitiveFSM(PatternStore(), M, 34e6, 2450e6, fpga=fpga,
                       scan_corridor=(2400e6, 2500e6), ibw_hz=34e6)
    fsm.tick(air_frame(None), _freqs(), 1e-3)
    assert fsm.state == INITIAL_SCAN and len(fsm.sweeper.windows) == 4
    fsm.sweeper.arm_sample_dwell()
    fsm.sweeper._hold_dwell = True
    fsm.sweeper.add_samples(fsm.sweeper.dwell_need())
    assert fsm.sweeper.dwell_done(50.0, 0.0) is False
    fsm.sweeper._hold_dwell = False
    assert fsm.sweeper.dwell_done(50.0, 0.0) is True
    before = fsm.sweeper.idx
    fsm._advance_scan(_freqs(), 2.0)
    assert fsm.sweeper.idx == before + 1
    assert fsm.sweeper.dwell_done(50.0, 0.0) is False
    assert fsm.sweeper._dwell_samples == 0


def test_stale_hops_do_not_confirm_and_fresh_lap_does():
    """Старые скачки в окнах не считаются новым кругом. Новый круг — да."""
    store = PatternStore()
    fpga = lf.LegionFpga(FakeTransport(board="bladerf2"))
    fsm = CognitiveFSM(store, M, 34e6, 2440e6, fpga=fpga,
                       scan_corridor=(2400e6, 2500e6), ibw_hz=34e6)
    fsm.sub = extract_subcorridor([2400e6, 2500e6], "scan")
    fsm.sweeper.setup(2400e6, 2500e6)
    fsm.sweeper.idx = 0
    freqs = [2405.0, 2412.0, 2418.0, 2424.0]
    for n, mhz in enumerate(freqs):
        fsm.sweeper.on_hop({
            "freq_mhz": mhz, "sample_count": 1000 + n, "t_start": 0.0,
            "dwell_us": 200.0, "channel_idx": n,
        })
    fsm.state = INITIAL_SCAN
    fsm._absorb_lap(1.0)
    assert fsm.state == LEARNING and fsm.pid is None and fsm.jams_sent == 0
    fsm._absorb_lap(2.0)
    assert fsm.state == LEARNING and fsm.pid is None and fsm.jams_sent == 0
    for n, mhz in enumerate(freqs):
        fsm.sweeper.on_hop({
            "freq_mhz": mhz, "sample_count": 5_000_000 + n, "t_start": 1.0,
            "dwell_us": 200.0, "channel_idx": n,
        })
    fsm._absorb_lap(3.0)
    assert fsm.state == CONFIRMING and fsm.jams_sent == 0
    for lap, base in enumerate((6_000_000, 7_000_000, 8_000_000)):
        for n, mhz in enumerate(freqs):
            fsm.sweeper.on_hop({
                "freq_mhz": mhz, "sample_count": base + n, "t_start": 2.0 + lap,
                "dwell_us": 200.0, "channel_idx": n,
            })
        fsm._absorb_lap(4.0 + lap)
    assert fsm.jams_sent >= 1


def test_narrow_cycle_closes_on_repeat_and_partial_does_not_count():
    """Узкий коридор: повтор частоты закрывает круг. Куцый круг удар не двигает."""
    store = PatternStore()
    fpga = lf.LegionFpga(FakeTransport(board="bladerf2"))
    fsm = CognitiveFSM(store, M, 34e6, 2420e6, fpga=fpga,
                       scan_corridor=(2400e6, 2434e6), ibw_hz=34e6)
    fsm.sub = extract_subcorridor([2400e6, 2434e6], "scan")
    fsm.state = LEARNING
    cycle = [2410.0, 2420.0, 2430.0, 2440.0]
    fsm.feed_freqs(cycle, 1.0)
    assert fsm.state == LEARNING and fsm._prev_bins is None
    fsm.feed_freqs([cycle[0]], 2.0)
    assert fsm.state == LEARNING and fsm.pid is None and fsm._prev_bins
    fsm.feed_freqs(cycle[1:], 2.5)
    fsm.feed_freqs([cycle[0]], 3.0)
    assert fsm.state == CONFIRMING and fsm.jams_sent == 0
    pid = fsm.pid
    marks = store.get(pid)["confirm_count"]
    fsm.feed_freqs(cycle[:3] + [cycle[0]], 4.0)
    assert store.get(pid)["confirm_count"] == marks
    assert fsm.jams_sent == 0
    for t in (5.0, 6.0, 7.0):
        fsm.feed_freqs(cycle + [cycle[0]], t)
    assert fsm.jams_sent >= 1


def test_weak_burst_beside_loud_one_is_kept_and_one_frame_is_not():
    """Громкая вспышка не съедает тихую рядом. Один кадр по-прежнему не скачок."""
    sub = extract_subcorridor([float(_freqs()[c]) for c in CYCLE], "p")
    f = _freqs()
    both = HopRecorder(sub)
    loud = air_frame(4, peak=100.0, noise=1.0).copy()
    loud[16] = 1.02
    assert both.update(loud, f, 1e-3) is None
    assert both.hops == []
    assert both.update(loud, f, 2e-3) is None
    both.update(air_frame(None), f, 3e-3)
    chans = {h["channel_idx"] for h in both.hops}
    assert chans == {4, 16}


def test_both_bursts_are_handed_to_the_sweep():
    """Обе вспышки попадают в ряд окна, а не только та, что вернул update."""
    fpga = lf.LegionFpga(FakeTransport(board="bladerf2"))
    fsm = CognitiveFSM(PatternStore(), M, 34e6, 2440e6, fpga=fpga,
                       scan_corridor=(2400e6, 2500e6), ibw_hz=34e6)
    fsm.tick(air_frame(None), _freqs(), 1e-3)
    assert fsm.state == INITIAL_SCAN
    f = _freqs()
    loud = air_frame(4, peak=100.0, noise=1.0).copy()
    loud[16] = 1.02
    fsm._hear_scan(loud, f, 1e-3)
    fsm._hear_scan(loud, f, 2e-3)
    fsm._hear_scan(air_frame(None), f, 3e-3)
    chans = {int(h["channel_idx"]) for h in fsm.sweeper.hops[0]}
    assert 4 in chans and 16 in chans


def test_stft_noise_is_not_a_hop_and_a_weak_tone_beside_a_loud_one_is():
    """Шум БПФ не пишется. Слабый тон рядом с громким — пишется."""
    rng = np.random.default_rng(1)
    nfft = 1024
    fs = 34e6
    lo = 2440e6
    n = nfft * 4
    noise = (rng.normal(size=n) + 1j * rng.normal(size=n)) * 0.02
    t = np.arange(n)
    weak_bin, loud_bin = 200, 700

    def tone(bin_, amp):
        return amp * np.exp(2j * np.pi * (bin_ - nfft / 2) * t / nfft)

    def run(iq):
        spec = np.asarray(stft_db(iq, nfft, nfft, np), dtype=np.float64)
        lin = np.power(10.0, np.maximum(spec, -120.0) / 10.0)
        freqs = lo + (np.arange(nfft) - nfft / 2.0) * (fs / nfft)
        sub = extract_subcorridor(
            [float(freqs.min()), float(freqs.max())], "stft")
        rec = HopRecorder(sub)
        for col in range(lin.shape[1]):
            rec.update(isolate_bursts(lin[:, col]), freqs, (col + 1) * 1e-3)
        rec.update(np.full(nfft, 1e-30), freqs, (lin.shape[1] + 1) * 1e-3)
        return rec

    quiet = run(noise)
    assert quiet.hops == []
    heard = run(noise + tone(weak_bin, 0.008) + tone(loud_bin, 0.5))
    got = {int(h["channel_idx"]) for h in heard.hops}
    assert any(abs(c - weak_bin) <= 4 for c in got)
    assert any(abs(c - loud_bin) <= 4 for c in got)
    assert all(abs(c - weak_bin) <= 4 or abs(c - loud_bin) <= 4 for c in got)
