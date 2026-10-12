"""CognitiveFSM — контур FHSS-памяти.

LISTENING → INITIAL_SCAN → LEARNING → CONFIRMING →
JAMMING (host, каждый hop) → MONITORING → (DRIFT | SILENT | RE_ACQUIRE).
HDL не шагает CH_LUT — флаг autonomous пишется, удар всегда с host.
"""
from __future__ import annotations

import numpy as np

from .corridor import (CorridorDetector, extract_subcorridor, ibw_visibility,
                       IBW_HZ)
from .drift_detector import DriftDetector
from .effectiveness_monitor import EffectivenessMonitor
from .hop_recorder import HopRecorder
from .hopmap import FallbackPredictor, match_and_predict
from .lo_sweep import LoSweeper
from .pattern_store import PatternStore, apply_timer_cycle, match_need

LISTENING = "LISTENING"
INITIAL_SCAN = "INITIAL_SCAN"
LEARNING = "LEARNING"
CONFIRMING = "CONFIRMING"
JAMMING = "JAMMING"
MONITORING = "MONITORING"
TARGET_SILENT = "TARGET_SILENT"
RE_ACQUIRE = "RE_ACQUIRE"
RE_LEARNING = "RE_LEARNING"
DRIFT_DETECTED = "DRIFT_DETECTED"

MIN_CONFIRMS = 3
MATCH_GO = 0.9
SILENT_S = 0.100
P_HOPPING_GO = 0.6
LOOKTHROUGH_HOPS = 10
NFFT_SPEC = 1024


class CognitiveFSM:
    def __init__(self, store: PatternStore, n_chans: int, fs_hz: float,
                 lo_hz: float, fpga=None, pub=None, frame_dt_s: float = 1e-3,
                 radio=None, scan_corridor=None, ibw_hz: float = IBW_HZ,
                 frame_samples: int = 20_000):
        self.store = store
        self.n_chans = int(n_chans)
        self.fs_hz = float(fs_hz)
        self.lo_hz = float(lo_hz)
        self.fpga = fpga
        self.pub = pub
        self.radio = radio
        self.dt = float(frame_dt_s)
        self.ibw_hz = float(ibw_hz)
        self.spf = int(frame_samples)
        self.scan_corridor = scan_corridor
        self.det = CorridorDetector()
        self.eff = EffectivenessMonitor()
        self.drift = DriftDetector()
        self.fallback = FallbackPredictor(n_chans, self.dt)
        self.sweeper = LoSweeper(ibw_hz=self.ibw_hz, radio=radio,
                                 samples_per_frame=self.spf, fs_hz=self.fs_hz)
        self.rec: "HopRecorder | None" = None
        self.sub: "dict | None" = None
        self.parent: "dict | None" = None
        self.state = LISTENING
        self.pid: "str | None" = None
        self.position = 0
        self.jams_sent = 0
        self.transitions: list[dict] = []
        self._live: list[int] = []
        self._last_hop_t: "float | None" = None
        self._reacquire_hops = 0
        self._confirm_base = 0
        self._tick_i = 0
        self._last_jam_ch: "int | None" = None
        self._autonomous = False
        self._lt_hops = 0
        self._lt_listen = False
        self._scan_t0 = 0.0
        self._grid_step_hz = 200.0e3
        self._fb: dict = {}
        if getattr(store, "n_chans", None) is None:
            store.n_chans = self.n_chans
        self._listen_freqs: list[float] = []

    def _go(self, to: str, t_s: float, **extra) -> None:
        rec = {"tick": self._tick_i, "from": self.state, "to": to,
               "t_s": round(float(t_s), 6), "pattern_id": self.pid,
               "jams_sent": self.jams_sent, **extra}
        self.transitions.append(rec)
        self.state = to

    def _spec_axis(self) -> tuple:
        half = 0.5 * self.fs_hz
        return (self.lo_hz - half, self.lo_hz + half, float(NFFT_SPEC))

    def _live_cap(self) -> int:
        cyc = 64
        if self.pid:
            cyc = max(64, 2 * int(self.store.get(self.pid)["cycle_length"]))
        elif self.rec is not None and self.rec._period:
            cyc = max(64, 2 * int(self.rec._period[0]))
        return cyc

    def _publish(self, t_s: float, confidence: float = 0.0) -> None:
        if self.pub:
            rec = self.store.get(self.pid) if self.pid else {}
            threat = {}
            if self.pid:
                threat = self.store.classify_threat_type(self.pid)
            self.pub.send_fsm(self.state, {
                "pattern_id": self.pid, "position": self.position,
                "confidence": rec.get("confidence", confidence),
                "sequence_type": rec.get("sequence_type"),
                "jams_sent": self.jams_sent,
                "pdr_target": self.eff.pdr,
                "threat": threat})

    def _set_lut_flag(self, on: bool) -> None:
        if self.fpga is None or self.sub is None or not self.pid:
            return
        from . import fpga_control as fc
        pat = self.store.get(self.pid)
        dwell = int(pat.get("dwell_us") or 1000)
        flags = fc.lf.GRID_FLAG_AUTONOMOUS if on else 0
        ok = self.fpga.set_grid(
            meta=fc.lf.pack_grid_meta(n=int(pat.get("lut_n") or 0),
                                      n_used=int(pat.get("lut_n") or 0),
                                      conf=90, source=fc.lf.GRID_SRC_OPERATOR,
                                      kind=fc.lf.GRID_KIND_FHSS),
            f0_hz=fc.lf.pack_grid_f0(int(round(self.sub["f_start"]))),
            step_hz=int(self._grid_step_hz), pri_us=dwell,
            flags=flags, rsv=int(self.position))
        if not ok:
            self.transitions.append({
                "tick": self._tick_i, "from": self.state, "to": self.state,
                "action": "set_grid_fail", "autonomous": on})
        self._autonomous = on if ok else self._autonomous

    def _jam_now(self, t_s: float, preload: bool = False) -> dict:
        from .fpga_control import apply_predictive_jam
        from .fpga_preload import LUT_CAP, preload_hop_sequence

        if self.fpga is None:
            raise RuntimeError("FSM: помеха без FPGA-транспорта")
        pat = self.store.get(self.pid)
        jam = apply_predictive_jam(self.fpga, self.sub, pat,
                                   position=self.position, lo_hz=self.lo_hz,
                                   fs_hz=self.fs_hz, horizon=1)
        pre_n = 0
        if preload:
            cyc = max(1, len(pat.get("cycle") or []))
            auto = cyc <= LUT_CAP
            n_pre = min(cyc, LUT_CAP)
            step = max(1e3, (self.sub["f_end"] - self.sub["f_start"]) / 255.0)
            self._grid_step_hz = step
            dwell = pat.get("dwell_us")
            try:
                out = preload_hop_sequence(self.fpga, pat, self.sub,
                                           position=self.position, next_n=n_pre,
                                           chan_step_hz=step, dwell_us=dwell,
                                           autonomous=auto, fs_hz=self.fs_hz)
                pre_n = out["written"]
                self._autonomous = bool(out["autonomous"])
                pat["lut_n"] = pre_n
                pat["visible_only"] = out["visible_only"]
                if out["visible_only"]:
                    self.transitions.append({
                        "tick": self._tick_i, "from": self.state, "to": self.state,
                        "t_s": float(t_s), "action": "visible_part",
                        "cycle": cyc, "lut_n": pre_n})
            except (ValueError, RuntimeError) as e:
                self._autonomous = False
                self.transitions.append({
                    "tick": self._tick_i, "from": self.state, "to": self.state,
                    "t_s": float(t_s), "action": "preload_fail",
                    "why": str(e)})
        self.store.mark_jammed(self.pid)
        self.jams_sent += 1
        self.eff.mark_jam_applied()
        self._go(JAMMING, t_s, action="jam+preload",
                 f_jam_hz=jam["f_jam_hz"], preload_n=pre_n,
                 autonomous=self._autonomous, immediate=True)
        if self.pub and self.pid:
            nxt = match_and_predict(self.store, self._live,
                                    self.sub["sub_corridor_id"])
            self.pub.send_pred(nxt[1], t_s, self.pid)
        return jam

    def _stop_jam(self, t_s: float, why: str) -> None:
        from .fpga_control import stop_jam

        self._autonomous = False
        if self.fpga is not None:
            self._set_lut_flag(False)
            stop_jam(self.fpga)
        self.transitions.append({"tick": self._tick_i, "from": self.state,
                                 "to": self.state, "t_s": round(float(t_s), 6),
                                 "action": "stop_jam", "why": why,
                                 "pattern_id": self.pid})

    def tick(self, ch_pwr, freqs_hz, t_s: float) -> dict:
        self._tick_i += 1
        self.sweeper.sample_count = int(round(float(t_s) * self.fs_hz))
        self._fb = self.fallback.update(ch_pwr, t_s)
        st = self.state
        hop = None
        if st == LISTENING:
            self._tick_listening(ch_pwr, freqs_hz, t_s)
        elif st == INITIAL_SCAN:
            hop = self._tick_scan(ch_pwr, freqs_hz, t_s)
        else:
            if (st in (LEARNING, CONFIRMING, RE_LEARNING)
                    and self.rec is not None):
                p = np.asarray(ch_pwr, dtype=float)
                k = int(np.argmax(p))
                med = float(np.median(p)) + 1e-12
                if p[k] > 6.0 * med:
                    self._listen_freqs.append(float(np.asarray(freqs_hz)[k]))
                    self._expand_sub()
            hop = self.rec.update(ch_pwr, freqs_hz, t_s) if self.rec else None
            if hop is not None:
                self._live.append(hop["channel_idx"])
                self._live = self._live[-self._live_cap():]
                self._last_hop_t = float(t_s)
            if st == LEARNING:
                self._tick_learning(t_s)
            elif st == CONFIRMING:
                self._tick_confirming(t_s)
            elif st in (MONITORING, JAMMING):
                self._tick_monitoring(ch_pwr, freqs_hz, t_s, hop)
            elif st == TARGET_SILENT:
                self._tick_target_silent(t_s)
            elif st == RE_LEARNING:
                self._tick_relearning(t_s)
        self._publish(t_s)
        return {"state": self.state, "hop": hop, "pid": self.pid,
                "jams_sent": self.jams_sent, "pdr": self.eff.pdr}

    def _start_learning(self, t_s: float, hops, parent: dict) -> None:
        self.parent = parent
        self._live = []
        self.sub = extract_subcorridor(hops, parent["corridor_id"])
        vis = ibw_visibility(self.sub, self.lo_hz, self.ibw_hz)
        if vis["wider_than_ibw"]:
            self.transitions.append({
                "tick": self._tick_i, "from": self.state, "to": self.state,
                "t_s": float(t_s), "action": "ibw_limit", **vis})
        self.rec = HopRecorder(self.sub, n_chans=self.n_chans,
                               samples_per_frame=self.spf)
        self._go(LEARNING, t_s, sub=[self.sub["f_start"], self.sub["f_end"]],
                 coverage=round(vis["visible_frac"], 3), note=vis["note"])
        if self.pub:
            self.pub.send_corridor(
                {"f_start": parent.get("f_start", min(hops)),
                 "f_end": parent.get("f_end", max(hops))},
                self.sub, axis=self._spec_axis())

    def _tick_listening(self, ch_pwr, freqs_hz, t_s: float) -> None:
        out = self.det.update(ch_pwr, freqs_hz, t_s)
        for b in out["bursts"]:
            self._listen_freqs.append(float(b["f_center"]))
        self._listen_freqs = self._listen_freqs[-64:]
        post = self.det.posterior()
        hops = self._listen_freqs
        if self.scan_corridor:
            a, b = float(self.scan_corridor[0]), float(self.scan_corridor[1])
            if (b - a) > self.ibw_hz:
                self.sweeper.setup(a, b)
                self.sweeper.tune_current(self.sweeper.sample_count)
                w = self.sweeper.current()
                if w:
                    self.lo_hz = w["f_center"]
                self._scan_t0 = float(t_s)
                self._go(INITIAL_SCAN, t_s, windows=len(self.sweeper.windows))
                return
        if post["p_hopping"] >= P_HOPPING_GO and hops:
            parent = max(out["corridors"], key=lambda c: c["power"]) if out["corridors"] else {
                "corridor_id": "listen",
                "f_start": min(hops), "f_end": max(hops),
            }
            width = float(parent.get("f_end", 0)) - float(parent.get("f_start", 0))
            if width > self.ibw_hz:
                self.sweeper.setup(parent["f_start"], parent["f_end"])
                self.sweeper.tune_current(self.sweeper.sample_count)
                w = self.sweeper.current()
                if w:
                    self.lo_hz = w["f_center"]
                self.parent = parent
                self._scan_t0 = float(t_s)
                self._go(INITIAL_SCAN, t_s, windows=len(self.sweeper.windows))
                return
            self._start_learning(t_s, hops, parent)

    def _tick_scan(self, ch_pwr, freqs_hz, t_s: float):
        if self.rec is None:
            w = self.sweeper.current() or {"f_start": self.lo_hz - 8e6,
                                           "f_end": self.lo_hz + 8e6,
                                           "index": 0}
            sub = extract_subcorridor([w["f_start"], w["f_end"]], "scan")
            self.rec = HopRecorder(sub, n_chans=self.n_chans,
                                   samples_per_frame=self.spf)
        hop = self.rec.update(ch_pwr, freqs_hz, t_s)
        if hop is not None:
            hop["sample_count"] = self.sweeper.sample_count
            self.sweeper.on_hop(hop)
            self._live.append(hop["channel_idx"])
            self._live = self._live[-self._live_cap():]
            self._last_hop_t = float(t_s)
        if self.sweeper.dwell_done(t_s, self._scan_t0):
            if self.sweeper.advance(self.sweeper.sample_count):
                w = self.sweeper.current()
                if w:
                    self.lo_hz = w["f_center"]
                    self.rec = HopRecorder(
                        extract_subcorridor([w["f_start"], w["f_end"]], "scan"),
                        n_chans=self.n_chans, samples_per_frame=self.spf)
                self._scan_t0 = float(t_s)
            else:
                fin = self.sweeper.finish()
                work = fin["work"]
                if work:
                    self.lo_hz = work["f_center"]
                hops = [h["freq_mhz"] * 1e6 for h in fin["stitched"]] or self._listen_freqs
                if not hops:
                    hops = [self.lo_hz]
                parent = {"corridor_id": "scan",
                          "f_start": work["f_start"] if work else min(hops),
                          "f_end": work["f_end"] if work else max(hops)}
                self._start_learning(t_s, hops, parent)
                if self.transitions:
                    self.transitions[-1]["coverage"] = fin["coverage"]
                    self.transitions[-1]["note"] = fin["note"]
        return hop

    def _expand_sub(self) -> None:
        freqs = list(self._listen_freqs)
        if self.rec:
            freqs += [float(h["freq_mhz"]) * 1e6 for h in self.rec.hops]
        if not freqs or self.sub is None:
            return
        nxt = extract_subcorridor(freqs, self.sub["parent_corridor_id"])
        nxt["sub_corridor_id"] = self.sub["sub_corridor_id"]
        self.sub = nxt
        if self.rec:
            self.rec.sub = dict(self.sub)
        if self.pid and self.pid in self.store.patterns:
            self.store.patterns[self.pid]["sub"] = dict(self.sub)

    def _tick_learning(self, t_s: float) -> None:
        self._expand_sub()
        pid = self.rec.maybe_commit(self.store) if self.rec else None
        if pid is not None:
            self.pid = pid
            rec = self.store.get(pid)
            apply_timer_cycle(rec, energy=self.rec._energy, dt_s=self.dt)
            if self.rec.median_dwell_us():
                rec["dwell_us"] = self.rec.median_dwell_us()
                rec["dwell_s"] = rec["dwell_us"] / 1e6
            self.drift.set_cycles(int(rec["cycle_length"]))
            self.drift.reset()
            self._live = self._live[-self._live_cap():]
            self._confirm_base = self.rec.valid_count
            self._go(CONFIRMING, t_s, hops=self.rec.valid_count,
                     cycle=rec["cycle_length"],
                     visible_only=rec.get("visible_only"))

    def _tick_confirming(self, t_s: float) -> None:
        if self.rec is None or self.sub is None or not self.pid:
            return
        rec = self.store.get(self.pid)
        cyc = max(1, int(rec["cycle_length"]))
        if self.rec.valid_count < self._confirm_base + cyc:
            return
        m = self.store.find_match(self._live[-2 * cyc:],
                                  self.sub["sub_corridor_id"],
                                  min_match=8)
        self._confirm_base = self.rec.valid_count
        if m is None or m[2] < MATCH_GO:
            return
        self.position = m[1]
        rec["confidence"] = m[2]
        count = self.store.mark_confirmed(self.pid)
        if count >= MIN_CONFIRMS and rec["confirmed"]:
            self.store.classify_threat_type(self.pid)
            self._jam_now(t_s, preload=True)
            self._go(MONITORING, t_s, confirms=count)

    def _tick_monitoring(self, ch_pwr, freqs_hz, t_s: float, hop) -> None:
        pid2, nxt, lp = match_and_predict(self.store, self._live,
                                          self.sub["sub_corridor_id"])
        lp_score = lp if pid2 == self.pid else 0.0
        if nxt is None:
            nxt = self._fb.get("next_channel")
            lp_score = float(self._fb.get("conf") or 0.0)
        d = self.drift.update(lp_score)
        dwell_s = max(self.dt, float(self.store.get(self.pid)
                                     .get("dwell_s", self.dt)))
        self.eff.update(expected=self.dt / dwell_s,
                        observed=1.0 if hop is not None else 0.0)
        if d["drift"]:
            self._stop_jam(t_s, "drift")
            self._go(DRIFT_DETECTED, t_s, lp_score=round(lp_score, 3))
            self.rec.reset()
            self._live = []
            self._go(RE_LEARNING, t_s)
            return
        if hop is not None:
            rec = self.store.get(self.pid)
            self.position = (self.position + 1) % max(1, int(rec["cycle_length"]))
            self._lt_hops += 1
            if self._lt_listen:
                self._lt_listen = False
                cyc = rec.get("cycle") or []
                if rec.get("lut_n") and not rec.get("visible_only"):
                    self._set_lut_flag(True)
                if cyc and abs(int(hop["channel_idx"])
                               - int(cyc[self.position % len(cyc)])) > 1:
                    exp = cyc[self.position % len(cyc)]
                    self._stop_jam(t_s, "lookthrough")
                    self._go(DRIFT_DETECTED, t_s, observed=hop["channel_idx"],
                             expected=exp)
                    self.rec.reset()
                    self._live = []
                    self._go(RE_LEARNING, t_s)
                    return
            else:
                if self._lt_hops >= LOOKTHROUGH_HOPS:
                    self._lt_hops = 0
                    self._lt_listen = True
                    self._set_lut_flag(False)
                if nxt is not None and lp_score >= 0.7:
                    if nxt != self._last_jam_ch:
                        self._jam_now(t_s)
                        self._last_jam_ch = nxt
                    self._go(MONITORING, t_s, keep=True)
        if (self._last_hop_t is not None
                and float(t_s) - self._last_hop_t > SILENT_S):
            self._stop_jam(t_s, "target_silent")
            self._live = []
            self._reacquire_hops = 0
            self.drift.reset()
            self._go(TARGET_SILENT, t_s)

    def _tick_target_silent(self, t_s: float) -> None:
        self._reacquire_hops = len(self._live)
        rec = self.store.get(self.pid) if self.pid else {}
        need = match_need(int(rec.get("cycle_length") or 8), 8)
        if self._reacquire_hops < need:
            return
        if self.sub is None or self.rec is None:
            self._go(LISTENING, t_s, note="нет sub/rec")
            return
        self._go(RE_ACQUIRE, t_s, live_hops=self._reacquire_hops, need=need)
        m = self.store.find_match(self._live[-need:],
                                  self.sub["sub_corridor_id"], min_match=8)
        if m is not None and m[0] == self.pid and m[2] >= MATCH_GO:
            self.position = m[1]
            rec["confidence"] = m[2]
            self.drift.reset()
            self._jam_now(t_s, preload=True)
            self._go(MONITORING, t_s, reacquire_conf=round(m[2], 3))
        else:
            self.rec.reset()
            self._live = []
            self.pid = None
            self.drift.reset()
            self._go(LEARNING, t_s, note="новый паттерн")

    def _tick_relearning(self, t_s: float) -> None:
        from .hop_recorder import MAX_CYCLE

        if self.rec is None or not self.pid:
            return
        afh = (self.rec._period is None
               and self.rec.valid_count >= 2 * MAX_CYCLE)
        if self.rec.ready() is not None or afh:
            self.store.update_pattern(self.pid, self.rec.hops)
            rec = self.store.get(self.pid)
            apply_timer_cycle(rec, energy=self.rec._energy, dt_s=self.dt)
            self.drift.set_cycles(int(rec["cycle_length"]))
            self.drift.reset()
            self._confirm_base = self.rec.valid_count
            self._go(CONFIRMING, t_s, relearned=True)
