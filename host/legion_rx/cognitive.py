"""CognitiveFSM — контур FHSS-памяти.

LISTENING → INITIAL_SCAN → LEARNING → CONFIRMING →
JAMMING (preload; host poke только если cycle>255) → MONITORING →
(DRIFT | SILENT | RE_ACQUIRE | RE_LEARNING).
HDL legion_lut_hop шагает индекс HOP_LUT 0x5E при FLAGS.AUTONOMOUS и cycle≤255.
"""
from __future__ import annotations

import numpy as np

from .corridor import (SUB_MARGIN_HZ, CorridorDetector, extract_subcorridor,
                       ibw_visibility, IBW_HZ)
from .drift_detector import DriftDetector
from .effectiveness_monitor import EffectivenessMonitor
from .hop_recorder import HopRecorder
from .hopmap import FallbackPredictor, match_and_predict
from .lo_sweep import SCAN_DWELL_S, LoSweeper
from .pattern_store import (PatternStore, apply_timer_cycle, freq_bin_mhz,
                           match_need, set_similarity)

LISTENING = "LISTENING"
INITIAL_SCAN = "INITIAL_SCAN"
LEARNING = "LEARNING"
CONFIRMING = "CONFIRMING"
JAMMING = "JAMMING"
MULTI_LO = "MULTI_LO"
TIMER = "TIMER"
RE_SCAN = "RE_SCAN"
MONITORING = "MONITORING"
TARGET_SILENT = "TARGET_SILENT"
RE_ACQUIRE = "RE_ACQUIRE"
RE_LEARNING = "RE_LEARNING"
DRIFT_DETECTED = "DRIFT_DETECTED"

MIN_CONFIRMS = 3
# Края не двигались столько, сколько протоколу нужно, чтобы пройти свои частоты.
# В списке тогда сколько он занял: 10, 50 или 100.
EDGE_QUIET_S = 0.5
MATCH_GO = 0.6
SILENT_S = 0.100
P_HOPPING_GO = 0.6
LOOKTHROUGH_HOPS = 100
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
        self.usb_io = None
        self._lt_armed = False
        self._scan_t0 = 0.0
        self._grid_step_hz = 200.0e3
        self._fb: dict = {}
        if getattr(store, "n_chans", None) is None:
            store.n_chans = self.n_chans
        self._listen_freqs: list[float] = []
        self._prev_bins: "set | None" = None
        self._open_bins: set = set()
        self._open_order: list = []
        self._set_handled = False
        self._lap_sc = -1
        self._bin_hits: dict = {}
        self._bin_mhz: dict = {}
        self._bin_order: list = []
        self._hop_gaps: list[float] = []
        self._win_hop_t: dict = {}
        self._span_key = None
        self._last_edge_t = None
        self._last_grow_t = None
        self._sweep_on_cluster = False
        self._heard_ready = None
        self._jam_by_set = False
        self._until_stop = False
        self.jam_duration_s = 15.0
        self._jam_until: "float | None" = None
        self._paused = False
        self._state_since = 0.0

    def _go(self, to: str, t_s: float, **extra) -> None:
        if to != self.state:
            self._state_since = float(t_s)
        rec = {"tick": self._tick_i, "from": self.state, "to": to,
               "t_s": round(float(t_s), 6), "pattern_id": self.pid,
               "jams_sent": self.jams_sent, **extra}
        self.transitions.append(rec)
        self.state = to

    def _watch(self, t_s: float) -> None:
        age = float(t_s) - float(self._state_since)
        if self.state == CONFIRMING and age > 300.0:
            self._rescan_origin(t_s, "watchdog_confirming")
        elif self.state == MONITORING and age > 10.0:
            self._stop_jam(t_s, "watchdog_monitoring")
            self._go("TARGET_SILENT", t_s, note="watchdog")

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
        if not self.pub:
            return
        try:
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
        except Exception as exc:
            self.transitions.append({
                "tick": self._tick_i, "from": self.state, "to": self.state,
                "t_s": float(t_s), "action": "publish_fail", "error": str(exc)})

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

    def _arm_look_through(self, dwell_us) -> None:
        """Один раз, пока таймер ещё выключен: 1 слушающий прыжок из 100.
        Автономный флаг не снимается. После FLAGS запись регистра снова
        закрывает USB, а следующий кадр делает set_frequency по живому ряду.
        """
        if self.fpga is None or self._lt_armed or not self._autonomous:
            return
        from .fpga_control import AIR_FS_HZ
        fs = float(getattr(self, "fpga_fs_hz", None) or AIR_FS_HZ)
        try:
            ok = bool(self.fpga.enable_look_through(
                LOOKTHROUGH_HOPS, 1, fs_hz=fs, dwell_us=float(dwell_us)))
        except (TypeError, ValueError, RuntimeError) as e:
            self.transitions.append({
                "tick": self._tick_i, "from": self.state, "to": self.state,
                "action": "look_through_fail", "why": str(e)})
            return
        self._lt_armed = ok
        self.transitions.append({
            "tick": self._tick_i, "from": self.state, "to": self.state,
            "action": "look_through", "ok": ok,
            "period_hops": LOOKTHROUGH_HOPS, "listen_hops": 1,
            "fs_hz": fs, "dwell_us": float(dwell_us)})

    def pause(self, t_s: float) -> None:
        """Пауза глушит передачу. FPGA иначе продолжает ряд."""
        self._paused = True
        self._stop_jam(t_s, "pause")

    def resume(self, t_s: float) -> None:
        self._paused = False
        self._go(LISTENING, t_s, note="resume")

    def _rescan_origin(self, t_s: float, why: str) -> None:
        """После таймера — исходный коридор оператора, не узкое пятно."""
        self._stop_jam(t_s, why)
        self._jam_until = None
        self.sub = None
        self.rec = None
        self.pid = None
        self._live = []
        self._listen_freqs = []
        self._stitched = None
        self._prev_bins = None
        self._open_bins = set()
        self._open_order = []
        self._set_handled = False
        self._lap_sc = -1
        self._bin_hits = {}
        self._bin_mhz = {}
        self._bin_order = []
        self._hop_gaps = []
        self._win_hop_t = {}
        self._span_key = None
        self._last_edge_t = None
        self._last_grow_t = None
        self._sweep_on_cluster = False
        self._heard_ready = None
        self._jam_by_set = False
        self._until_stop = False
        pair = self._corridor_hz()
        if pair:
            self.sweeper.setup(pair[0], pair[1])
            self.sweeper.arm_sample_dwell()
        self._go(LISTENING, t_s, note="rescan_origin",
                 corridor=self.scan_corridor)

    def _jam_now(self, t_s: float, preload: bool = True) -> dict:
        from .fpga_preload import LUT_CAP

        if self.fpga is None:
            raise RuntimeError("FSM: помеха без FPGA-транспорта")
        pat = self.store.get(self.pid)
        fs_hop = float(getattr(self, "fpga_fs_hz", None) or self.fs_hz)
        # Автономный удар не вызывает apply_predictive_jam: тот пишет amp 0.90.
        if preload:
            from .fpga_preload import preload_drfm_shelf
            from .lo_window_planner import plan_stations, station_groups
            from . import fpga_control as fc
            raw = list(pat.get("freqs_mhz") or [])
            cyc_n = int(pat.get("cycle_length") or len(raw) or 1)
            cycle_freqs = raw[:max(1, min(cyc_n, LUT_CAP, len(raw)))]
            hops = [float(x) * 1e6 for x in cycle_freqs]
            plan = plan_stations(
                min(hops) if hops else self.sub["f_start"],
                max(hops) if hops else self.sub["f_end"],
                fs_hop, hops)
            grouped, slices = station_groups(
                cycle_freqs, plan["centers_hz"], fs_hop)
            if not grouped:
                grouped = list(cycle_freqs)
                slices = [{"slot": 0, "start": 0, "end": max(0, len(grouped) - 1),
                           "lo_hz": float(plan["centers_hz"][0]),
                           "n": len(grouped)}] if grouped and plan["centers_hz"] else []
            jam_pat = dict(pat)
            jam_pat["freqs_mhz"] = grouped or cycle_freqs
            first = slices[0] if slices else {
                "start": 0, "end": max(0, len(jam_pat["freqs_mhz"]) - 1)}
            lf = fc.lf

            def _stage(sl, key: int, tx_nios: int = 0, rx_nios: int = 0,
                       tx_port: int = 0, tx_spdt: int = 0,
                       rx_port: int = 0, rx_spdt: int = 0) -> None:
                # HDL читает [7:0]. Старшие байты — номер ячейки fastlock и
                # порт/ключ, их забирает NIOS до проброса в плату.
                self.fpga.write_reg(
                    lf.REG_HOP_START_IDX,
                    (int(tx_spdt) & 0xFF) << 24 | (int(tx_port) & 0xFF) << 16 |
                    (int(tx_nios) & 0xFF) << 8 | (int(sl["start"]) & 0xFF))
                self.fpga.write_reg(
                    lf.REG_HOP_END_IDX,
                    (int(rx_spdt) & 0xFF) << 24 | (int(rx_port) & 0xFF) << 16 |
                    (int(rx_nios) & 0xFF) << 8 | (int(sl["end"]) & 0xFF))
                lo_khz = int(round(float(sl["lo_hz"]) / 1000.0))
                self.fpga.store_profile_lo_khz(int(key) & 7, lo_khz)

            usb = getattr(self, "usb", None)
            io = getattr(self, "usb_io", None)
            hold = len(slices) > 1
            staged = False
            tune_fail = False
            saved: list = []
            # Все снимки — пока поток ещё держит плату. Первая запись регистра
            # закрывает handle и стирает слоты AD9361; байты уже лежат в NIOS.
            if (usb is not None and getattr(usb, "open", False) and hold):
                from .libbladerf_owner import CH_RX, CH_TX
                cap = io.capture_locked if io is not None else usb.capture_pair
                for sl in slices:
                    if cap(int(sl["slot"]), int(sl["lo_hz"])) != 0:
                        tune_fail = True
                        break
                    saved.append((
                        sl,
                        usb.tunes.get((int(sl["slot"]), CH_TX)),
                        usb.tunes.get((int(sl["slot"]), CH_RX)),
                    ))
                if tune_fail:
                    hold = False
                    saved = []
            if tune_fail:
                if io is not None and hasattr(io, "resume_after_pio"):
                    io.resume_after_pio(reconfigure=True)
                self._rescan_origin(t_s, "tune_fail")
                return {"f_jam_hz": 0.0, "shelf": {}, "stations": 0,
                        "outside_hz": 0.0, "slices": 0}
            if io is not None and slices and not tune_fail:
                if hasattr(io, "park_locked"):
                    io.park_locked(int(slices[0]["lo_hz"]))
                else:
                    io.lo = float(slices[0]["lo_hz"])
            for sl, qt_tx, qt_rx in saved:
                _stage(sl, int(sl["slot"]),
                       int(getattr(qt_tx, "nios_profile", 0) or 0),
                       int(getattr(qt_rx, "nios_profile", 0) or 0),
                       int(getattr(qt_tx, "port", 0) or 0),
                       int(getattr(qt_tx, "spdt", 0) or 0),
                       int(getattr(qt_rx, "port", 0) or 0),
                       int(getattr(qt_rx, "spdt", 0) or 0))
            staged = bool(saved)
            shelf = preload_drfm_shelf(
                self.fpga, jam_pat, self.sub, fs_hz=fs_hop,
                shift_hz=15000, mute_ns=0,
                hop_start=int(first["start"]), hop_end=int(first["end"]),
                hold_end=hold, arm=False)
            if not staged:
                for sl in slices:
                    _stage(sl, int(sl["slot"]))
            if slices:
                self.fpga.apply_hop_range(int(slices[0]["start"]),
                                          int(slices[0]["end"]))
                # Живая несущая первой стоянки. mute_ns = 0 — старт не молчит.
                # На границе молчит HDL, NIOS отзывает профиль и даёт новый диапазон.
                self.fpga.write_reg(lf.REG_CH_LO_KHZ,
                                    int(round(float(slices[0]["lo_hz"]) / 1000.0))
                                    & 0x0FFFFFFF)
            # Взгляд — в этой сессии, FLAGS ещё 0. После старта таймера
            # запись снова делает standby, а end_tick кадра перестраивает LO.
            if not tune_fail:
                cyc_lt = max(1, len(pat.get("cycle") or pat.get("freqs_mhz") or []))
                self._autonomous = cyc_lt <= LUT_CAP
                if self._autonomous:
                    self._arm_look_through(int(pat.get("dwell_us") or 1000))
            if hasattr(self.fpga, "yield_usb"):
                self.fpga.yield_usb()
            # Таймер — только когда configure уже поставил несущую первой
            # стоянки. Иначе первая стоянка кончается во время set_frequency.
            if not tune_fail and slices:
                dwell = int(pat.get("dwell_us") or 1000)
                n_written = int(shelf.get("written") or 1)
                f0 = int(round(float(self.sub["f_start"])))
                flags = lf.GRID_FLAG_AUTONOMOUS | (
                    lf.GRID_FLAG_HOLD_END if hold else 0)
                self.fpga.set_grid(
                    meta=lf.pack_grid_meta(
                        n=min(n_written, 255), n_used=min(n_written, 255),
                        conf=90, source=lf.GRID_SRC_OPERATOR,
                        kind=lf.GRID_KIND_FHSS),
                    f0_hz=lf.pack_grid_f0(f0),
                    step_hz=0,
                    pri_us=max(1, dwell),
                    shift_hz=15000,
                    flags=flags,
                    rsv=0)
                if hasattr(self.fpga, "yield_usb"):
                    self.fpga.yield_usb(reconfigure=False)
            if tune_fail:
                self._rescan_origin(t_s, "tune_fail")
            plan = dict(plan)
            plan["n"] = max(1, len(slices))
            self._lo_plan = plan
            jam = {"f_jam_hz": hops[0] if hops else 0.0,
                   "shelf": shelf, "stations": len(slices) or 1,
                   "outside_hz": plan.get("outside_hz", 0.0),
                   "slices": len(slices)}
        pre_n = 0
        if preload:
            cyc = max(1, len(pat.get("cycle") or pat.get("freqs_mhz") or []))
            self._autonomous = cyc <= LUT_CAP
            pre_n = int(jam.get("shelf", {}).get("written") or 0)
            pat["lut_n"] = pre_n
            # Кнопка Передать держит удар до Стоп. Сам по таймеру он не гаснет.
            if getattr(self, "_until_stop", False):
                self._jam_until = None
            else:
                self._jam_until = float(t_s) + float(self.jam_duration_s)
            self.transitions.append({
                "tick": self._tick_i, "from": self.state, "to": self.state,
                "t_s": float(t_s), "action": "drfm_shelf",
                "stations": jam.get("stations"),
                "outside_hz": jam.get("outside_hz"),
                "until": self._jam_until})
        self.store.mark_jammed(self.pid)
        self.jams_sent += 1
        self.eff.mark_jam_applied()
        self._go(JAMMING, t_s, action="jam+preload",
                 f_jam_hz=jam["f_jam_hz"], preload_n=pre_n,
                 autonomous=self._autonomous, immediate=True,
                 lo_hz=self.lo_hz, fs_hz=fs_hop,
                 f_start=self.sub["f_start"], f_end=self.sub["f_end"])
        if self.pub and self.pid:
            nxt = match_and_predict(self.store, self._live,
                                    self.sub["sub_corridor_id"])
            self.pub.send_pred(nxt[1], t_s, self.pid)
        return jam

    def _stop_jam(self, t_s: float, why: str) -> None:
        from .fpga_control import stop_jam

        self._autonomous = False
        self._lt_armed = False
        if self.fpga is not None:
            self.fpga.disable_look_through()
            # Стоп LUT (drift / silent), не listen-hop: blank делает REG_LT_*.
            self._set_lut_flag(False)
            stop_jam(self.fpga)
        self.transitions.append({"tick": self._tick_i, "from": self.state,
                                 "to": self.state, "t_s": round(float(t_s), 6),
                                 "action": "stop_jam", "why": why,
                                 "pattern_id": self.pid})

    def tick(self, ch_pwr, freqs_hz, t_s: float) -> dict:
        self._tick_i += 1
        self._watch(float(t_s))
        if self._take_replay(float(t_s)):
            self._publish(t_s)
            return {"state": self.state, "hop": None, "pid": self.pid,
                    "jams_sent": self.jams_sent, "pdr": self.eff.pdr}
        self.sweeper.sample_count = int(round(float(t_s) * self.fs_hz))
        self._fb = self.fallback.update(ch_pwr, t_s)
        st = self.state
        hop = None
        wide = self._wide()
        if st == LISTENING:
            hop = self._tick_listening(ch_pwr, freqs_hz, t_s)
        elif st == INITIAL_SCAN or (wide and st in (LEARNING, CONFIRMING)):
            hop = self._tick_scan(ch_pwr, freqs_hz, t_s)
        else:
            if (st in (LEARNING, CONFIRMING, RE_LEARNING)
                    and self.rec is not None):
                p = np.asarray(ch_pwr, dtype=float)
                k = int(np.argmax(p))
                med = float(np.median(p)) + 1e-12
                if p[k] > med:
                    self._listen_freqs.append(float(np.asarray(freqs_hz)[k]))
                    self._expand_sub()
            n_before = len(self.rec.hops) if self.rec is not None else 0
            hop = self.rec.update(ch_pwr, freqs_hz, t_s) if self.rec else None
            if self.rec is not None:
                for seen in self.rec.hops[n_before:]:
                    self._note_hop(seen, t_s)
                if self.rec.hops[n_before:]:
                    hop = self.rec.hops[-1]
            if st == LEARNING:
                self._tick_learning(t_s)
            elif st == CONFIRMING:
                self._tick_confirming(t_s)
            elif st in (MONITORING, JAMMING, MULTI_LO, TIMER):
                if self.rec is not None and self.rec._open:
                    self._last_hop_t = float(t_s)
                self._tick_monitoring(ch_pwr, freqs_hz, t_s, hop)
            elif st == TARGET_SILENT:
                self._tick_target_silent(t_s)
            elif st == RE_LEARNING:
                self._tick_relearning(t_s)
        self._publish(t_s)
        return {"state": self.state, "hop": hop, "pid": self.pid,
                "jams_sent": self.jams_sent, "pdr": self.eff.pdr}

    def _start_learning(self, t_s: float, hops, parent: dict,
                        seed: "list | None" = None) -> None:
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
        stitched_n = 0
        holes = 0
        if seed:
            stitched_n = self.rec.load_stitched(seed)
            self._live = [int(h["channel_idx"]) for h in self.rec.hops]
            self._live = self._live[-self._live_cap():]
            holes = self.rec.hole_count
        self._go(LEARNING, t_s, sub=[self.sub["f_start"], self.sub["f_end"]],
                 coverage=round(vis["visible_frac"], 3), note=vis["note"],
                 stitched=stitched_n, holes=holes)
        if self.pub:
            self.pub.send_corridor(
                {"f_start": parent.get("f_start", min(hops)),
                 "f_end": parent.get("f_end", max(hops))},
                self.sub, axis=self._spec_axis())

    def _corridor_hz(self) -> "tuple | None":
        c = self.scan_corridor
        if not c:
            return None
        if isinstance(c, dict):
            return float(c["f_start"]), float(c["f_end"])
        return float(c[0]), float(c[1])

    def arm_replay(self, record: dict) -> None:
        """Следующий цикл слушает сохранённый паттерн и бьёт по нему."""
        self.replay_pattern = record

    def _replay(self, record: dict, t_s: float) -> None:
        pid = record.get("pattern_id")
        sub = record.get("sub")
        if not pid or not isinstance(sub, dict):
            self.transitions.append({
                "tick": self._tick_i, "from": self.state, "to": self.state,
                "t_s": float(t_s), "action": "replay_skip"})
            return
        from .pattern_store import classify_sequence_type
        seq = [int(x) for x in (record.get("cycle") or record.get("hop_sequence") or [])]
        record.setdefault("sequence_type", classify_sequence_type(seq, m=self.n_chans))
        record.setdefault("sub_corridor_id", sub.get("sub_corridor_id"))
        record.setdefault("legacy", [])
        record.setdefault("hop_sequence", list(seq))
        record.setdefault("cycle", list(seq))
        record.setdefault("cycle_length", len(record.get("freqs_mhz") or seq))
        record.setdefault("jammed_count", 0)
        record.setdefault("confirmed", True)
        record.setdefault("confirm_count", MIN_CONFIRMS)
        self.store.patterns[pid] = record
        self.pid = pid
        self.sub = sub
        self._jam_by_set = True
        self._until_stop = True
        try:
            self._jam_now(t_s, preload=True)
        except Exception as exc:
            self.transitions.append({
                "tick": self._tick_i, "from": self.state, "to": self.state,
                "t_s": float(t_s), "action": "replay_fail", "error": str(exc)})

    def _note_hop(self, hop, t_s: float) -> None:
        if hop is None:
            return
        self._live.append(int(hop["channel_idx"]))
        self._live = self._live[-self._live_cap():]
        self._last_hop_t = float(t_s)

    def _flush_open(self, freqs_hz, t_s: float):
        """Открытый скачок в ряд до замены окна. С окном его не выбрасываем."""
        if self.rec is None:
            return None
        n_before = len(self.rec.hops)
        self.rec.flush(t_s, freqs_hz)
        published = None
        for hop in self.rec.hops[n_before:]:
            hop["sample_count"] = self.sweeper.sample_count
            self.sweeper.on_hop(hop)
            self._note_hop(hop, t_s)
            published = hop
        return published

    def _take_replay(self, t_s: float) -> bool:
        """Кнопка Передать кладёт записанный ряд. Пока её нет, передатчик молчит."""
        replay = getattr(self, "replay_pattern", None)
        if not replay:
            return False
        self.replay_pattern = None
        if self.jams_sent or self.state in (JAMMING, MULTI_LO, TIMER, MONITORING):
            return False
        self._replay(replay, t_s)
        return True

    def _tick_listening(self, ch_pwr, freqs_hz, t_s: float):
        pair = self._corridor_hz()
        if pair:
            a, b = pair
            if (b - a) > self.ibw_hz:
                self.sweeper.setup(a, b)
                self.sweeper.tune_current(self.sweeper.sample_count)
                w = self.sweeper.current()
                if w:
                    self.lo_hz = w["f_center"]
                self._scan_t0 = float(t_s)
                self._go(INITIAL_SCAN, t_s, windows=len(self.sweeper.windows))
                return None
            self.lo_hz = 0.5 * (float(a) + float(b))
            parent = {"corridor_id": "operator",
                      "f_start": float(a), "f_end": float(b)}
            self._start_learning(t_s, [float(a), float(b)], parent)
            n_before = len(self.rec.hops) if self.rec is not None else 0
            hop = self.rec.update(ch_pwr, freqs_hz, t_s) if self.rec else None
            if self.rec is not None:
                for seen in self.rec.hops[n_before:]:
                    self._note_hop(seen, t_s)
            return hop
        out = self.det.update(ch_pwr, freqs_hz, t_s)
        for b in out["bursts"]:
            self._listen_freqs.append(float(b["f_center"]))
        self._listen_freqs = self._listen_freqs[-64:]
        post = self.det.posterior()
        hops = self._listen_freqs
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
                return None
            self._start_learning(t_s, hops, parent)
        return None

    def _wide(self) -> bool:
        """Коридор шире одного окна 34 МГц — обход не останавливается на первом круге."""
        pair = self._corridor_hz()
        if pair and (pair[1] - pair[0]) > self.ibw_hz + 1.0:
            return True
        return len(self.sweeper.windows) > 1

    def _absorb_lap(self, t_s: float) -> None:
        """stitch() всех окон → один ряд. Коммит и подтверждение по нему, не по первому окну."""
        seed = self.sweeper.stitch()
        if len(seed) > 8192:
            seed = seed[-8192:]
        if not seed:
            return
        learn = getattr(self, "_stitched", None)
        if learn is None:
            pair = self._corridor_hz()
            span = [pair[0], pair[1]] if pair else [
                min(float(h["freq_mhz"]) * 1e6 for h in seed),
                max(float(h["freq_mhz"]) * 1e6 for h in seed),
            ]
            self.sub = extract_subcorridor(span, "scan")
            width = float(self.sub["f_end"]) - float(self.sub["f_start"])
            learn = HopRecorder(self.sub, n_chans=self.n_chans,
                                samples_per_frame=self.spf)
            step = float(learn.chan_step)
            grid_n = max(self.n_chans, int(width / step) + 1)
            learn.n_chans = grid_n
            self.n_chans = grid_n
            self.store.n_chans = grid_n
            learn.load_stitched(seed)
            self._stitched = learn
        else:
            learn.append_stitched(seed)
        self._live = [int(h["channel_idx"]) for h in learn.hops]
        self._live = self._live[-self._live_cap():]
        window_rec = self.rec
        self.rec = learn
        was = self.state
        fresh = [h for h in seed
                 if int(h.get("sample_count") or 0) > self._lap_sc]
        if fresh:
            self._lap_sc = max(int(h.get("sample_count") or 0) for h in fresh)
            # Снимок круга на широком обходе — только кусок. Удар по нему
            # открывался бы на первых частотах, пока остальные ещё не слышны.
            self._count_repeated_freqs(fresh, t_s)
        if was == INITIAL_SCAN and self.state == INITIAL_SCAN:
            self._go(LEARNING, t_s, stitched=len(learn.hops), wide=True)
        if self.state in (INITIAL_SCAN, LEARNING, CONFIRMING):
            self.rec = window_rec
        else:
            self.rec = learn

    def _window_recorder(self) -> None:
        if self.rec is not None:
            return
        w = self.sweeper.current() or {"f_start": self.lo_hz - 8e6,
                                       "f_end": self.lo_hz + 8e6,
                                       "index": 0}
        sub = extract_subcorridor([w["f_start"], w["f_end"]], "scan")
        self.rec = HopRecorder(sub, n_chans=self.n_chans,
                               samples_per_frame=self.spf)

    def hear(self, ch_pwr, freqs_hz, t_s: float) -> None:
        """Короткий кадр спектра в ряд. Стоянку не сдвигает."""
        st = self.state
        if st == INITIAL_SCAN or (self._wide() and st in (LEARNING, CONFIRMING)):
            self._hear_scan(ch_pwr, freqs_hz, t_s)
        elif (st in (LEARNING, CONFIRMING, RE_LEARNING,
                     JAMMING, MULTI_LO, TIMER, MONITORING)
              and self.rec is not None):
            n_before = len(self.rec.hops)
            self.rec.update(ch_pwr, freqs_hz, t_s)
            for seen in self.rec.hops[n_before:]:
                self._note_hop(seen, t_s)
            # Вспышка ещё открыта — это не тишина. Иначе удар гаснет,
            # пока короткий скачок сидит не в последнем столбце кадра.
            if (st in (JAMMING, MULTI_LO, TIMER, MONITORING)
                    and self.rec._open):
                self._last_hop_t = float(t_s)

    def _hear_scan(self, ch_pwr, freqs_hz, t_s: float):
        self._window_recorder()
        n_before = len(self.rec.hops)
        self.rec.update(ch_pwr, freqs_hz, t_s)
        published = None
        sc = int(round(float(t_s) * self.fs_hz))
        for hop in self.rec.hops[n_before:]:
            hop["sample_count"] = sc
            self.sweeper.on_hop(hop)
            self._note_hop(hop, t_s)
            published = hop
        return published

    def _tick_scan(self, ch_pwr, freqs_hz, t_s: float):
        hop = self._hear_scan(ch_pwr, freqs_hz, t_s)
        if self.sweeper.dwell_done(t_s, self._scan_t0):
            hop = self._advance_scan(freqs_hz, t_s, hop)
        return hop

    def _advance_scan(self, freqs_hz, t_s: float, hop=None):
        """Окно собрало стоянку. Следующее окно или склейка круга."""
        flushed = self._flush_open(freqs_hz, t_s)
        if hop is None:
            hop = flushed
        if self.sweeper.advance(self.sweeper.sample_count):
            w = self.sweeper.current()
            if w:
                self.lo_hz = w["f_center"]
                # Сборщик одного окна. Ряд всех окон — в sweeper.hops.
                self.rec = HopRecorder(
                    extract_subcorridor([w["f_start"], w["f_end"]], "scan"),
                    n_chans=self.n_chans, samples_per_frame=self.spf)
            self._live = []
            self._scan_t0 = float(t_s)
            self.sweeper.reset_dwell_samples()
        elif self._wide():
            self._absorb_lap(t_s)
            if self.state not in (INITIAL_SCAN, LEARNING, CONFIRMING):
                self.sweeper.reset_dwell_samples()
                return hop
            self.sweeper.idx = 0
            self.sweeper.tune_current(self.sweeper.sample_count)
            w = self.sweeper.current()
            if w:
                self.lo_hz = w["f_center"]
                self.rec = HopRecorder(
                    extract_subcorridor([w["f_start"], w["f_end"]], "scan"),
                    n_chans=self.n_chans, samples_per_frame=self.spf)
            self._live = []
            self._scan_t0 = float(t_s)
            self.sweeper.reset_dwell_samples()
        else:
            fin = self.sweeper.finish()
            work = fin["work"]
            if work:
                self.lo_hz = work["f_center"]
            seed = list(fin.get("stitched") or [])
            hops = [float(h["freq_mhz"]) * 1e6 for h in seed]
            if not hops:
                hops = list(self._listen_freqs) or [self.lo_hz]
            if seed:
                f1 = min(hops)
                f2 = max(hops)
            elif work:
                f1, f2 = work["f_start"], work["f_end"]
            else:
                f1, f2 = min(hops), max(hops)
            parent = {"corridor_id": "scan", "f_start": f1, "f_end": f2}
            self._start_learning(t_s, hops, parent,
                                 seed=seed if seed else None)
            if self.transitions:
                self.transitions[-1]["coverage"] = fin["coverage"]
                self.transitions[-1]["note"] = fin["note"]
            self.sweeper.reset_dwell_samples()
        return hop

    def feed_freqs(self, freqs, t_s: float) -> None:
        """Узкий коридор. Повтор той же частоты закрывает проход."""
        for mhz in freqs:
            b = freq_bin_mhz(float(mhz))
            if b in self._open_bins and self._open_order:
                self.finish_pass(list(self._open_order), t_s)
                self._open_bins = {b}
                self._open_order = [float(mhz)]
                continue
            if b not in self._open_bins:
                self._open_bins.add(b)
                self._open_order.append(float(mhz))

    def finish_pass(self, freq_mhz, t_s: float) -> None:
        """Один проход. Совпадение списка частот, не порядка прыжков."""
        uniq = []
        bins = []
        seen = set()
        for mhz in freq_mhz:
            b = freq_bin_mhz(float(mhz))
            if b in seen:
                continue
            seen.add(b)
            uniq.append(float(mhz))
            bins.append(b)
        if not bins:
            return
        cur = set(bins)
        was = self.state
        self._set_handled = False
        if was == CONFIRMING and self.pid:
            # Сверяем с запомненным списком. Чужой проход его не подменяет.
            score = set_similarity(cur, self._stored_bins())
            if score >= MATCH_GO:
                self._set_confirm(float(t_s), score)
                if self.state == CONFIRMING:
                    self._set_handled = True
            return
        if self.pid or was not in (LEARNING, INITIAL_SCAN):
            return
        if self._prev_bins is None:
            self._prev_bins = cur
            return
        if (was == LEARNING
                and set_similarity(cur, self._prev_bins) >= MATCH_GO):
            self._commit_freqs(uniq, t_s)
            self._prev_bins = cur

    def _note_hop_gaps(self, hops) -> None:
        """Задержка скачка. Переезд между окнами сюда не входит.

        Пока окон несколько, берём только пары внутри одной стоянки (короче 4 мс).
        Когда пятно уже в одном окне, пара может быть реже: до 50 мс.
        """
        one = len(self.sweeper.windows) <= 1
        limit = 0.050 if one else float(SCAN_DWELL_S)
        ordered = sorted(
            (h for h in hops if not h.get("hole")),
            key=lambda h: float(h.get("t_start") or 0.0))
        for h in ordered:
            win = h.get("window")
            t = float(h.get("t_start") or 0.0)
            prev = self._win_hop_t.get(win)
            if prev is not None:
                dt = t - prev
                if 0.0 < dt < limit:
                    self._hop_gaps.append(dt)
            self._win_hop_t[win] = t
        if len(self._hop_gaps) > 4000:
            del self._hop_gaps[:-4000]

    def _hop_period_s(self) -> float:
        if not self._hop_gaps:
            return float(SCAN_DWELL_S)
        return float(np.median(np.asarray(self._hop_gaps, dtype=float)))

    def _sweep_edges(self):
        ws = self.sweeper.windows
        if not ws:
            return None
        return (min(float(w["f_start"]) for w in ws),
                max(float(w["f_end"]) for w in ws))

    def _maybe_narrow(self, stable, t_s: float) -> None:
        """Пятно уже видно. Пустые окна обхода больше не слушаем."""
        lo = min(stable) * 1e6 - SUB_MARGIN_HZ
        hi = max(stable) * 1e6 + SUB_MARGIN_HZ
        pair = self._corridor_hz()
        if pair:
            lo = max(lo, pair[0])
            hi = min(hi, pair[1])
        edges = self._sweep_edges()
        if edges is None or hi <= lo:
            self._sweep_on_cluster = True
            return
        sweep = edges[1] - edges[0]
        cluster = hi - lo
        if (cluster < sweep - self.ibw_hz
                and (lo > edges[0] + 1.0 or hi < edges[1] - 1.0)):
            self.sweeper.setup(lo, hi)
            self.sweeper.arm_sample_dwell()
            self.sweeper.tune_current(self.sweeper.sample_count)
            w = self.sweeper.current()
            if w:
                self.lo_hz = w["f_center"]
            self._scan_t0 = float(t_s)
            # Этот круг только сузил обход. Ряд дописывается на следующих.
            self._sweep_on_cluster = False
            return
        self._sweep_on_cluster = True

    def _arm_heard_list(self, stable, t_s: float) -> None:
        """Весь услышанный список — один раз на плату."""
        hz = [float(x) * 1e6 for x in stable]
        old = self.sub.get("sub_corridor_id") if self.sub else None
        self.sub = extract_subcorridor(hz, "scan")
        if old:
            self.sub["sub_corridor_id"] = old
        if self.state != CONFIRMING or not self.pid:
            self._commit_freqs(stable, t_s)
        rec = self.store.get(self.pid)
        rec["freqs_mhz"] = list(stable)
        rec["cycle_length"] = len(stable)
        rec["cycle"] = list(range(len(stable)))
        rec["hop_sequence"] = list(rec["cycle"])
        rec["freq_khz"] = [int(round(float(x) * 1000.0)) for x in stable]
        rec["sub"] = dict(self.sub)
        period = self._hop_period_s()
        rec["dwell_s"] = period
        rec["dwell_us"] = period * 1e6
        if int(rec.get("confirm_count") or 0) < MIN_CONFIRMS - 1:
            rec["confirm_count"] = MIN_CONFIRMS - 1
        self._set_confirm(float(t_s), 1.0)

    def _count_repeated_freqs(self, hops, t_s: float) -> None:
        """Частота из трёх кругов входит в ряд. Удар — когда пятно больше не растёт.

        В списке сколько есть: 10, 50 или 100. Первые две частоты удар не открывают,
        пока снаружи ещё приходят новые.
        """
        if self.jams_sent or self.state in (JAMMING, MULTI_LO, TIMER, MONITORING):
            return
        self._note_hop_gaps(hops)
        seen = set()
        for h in hops:
            mhz = float(h["freq_mhz"])
            b = freq_bin_mhz(mhz)
            if b in seen:
                continue
            seen.add(b)
            if b not in self._bin_hits:
                self._bin_hits[b] = 0
                self._bin_order.append(b)
            self._bin_hits[b] += 1
            self._bin_mhz[b] = mhz
        # Пятно — только частоты, слышанные трижды. Одиночный выброс шума
        # на краю коридора не раздвигает ряд и не сбрасывает таймер.
        stable = [self._bin_mhz[b] for b in self._bin_order
                  if self._bin_hits.get(b, 0) >= MIN_CONFIRMS]
        if len(stable) < 2:
            return
        now = float(t_s)
        stable_key = (freq_bin_mhz(min(stable)), freq_bin_mhz(max(stable)))
        # Края встали — середина дописывается за время тишины.
        # Новый бин внутри пятна таймер не сбрасывает: шум окна иначе
        # не даёт ряду закрыться.
        if stable_key != self._span_key:
            self._span_key = stable_key
            self._last_edge_t = now
            self._last_grow_t = now
            self._heard_ready = None
        if self._last_edge_t is None:
            return
        period = self._hop_period_s()
        edge_need = max(EDGE_QUIET_S, 2.0 * period * len(stable))
        if now - float(self._last_edge_t) < edge_need:
            return
        if not self._sweep_on_cluster:
            self._maybe_narrow(stable, t_s)
            if not self._sweep_on_cluster:
                return
        if self._last_grow_t is None:
            return
        grow_need = max(EDGE_QUIET_S, 3.0 * period * len(stable))
        if now - float(self._last_grow_t) < grow_need and len(stable) < 256:
            return
        if not self._hop_gaps:
            return
        # Число прыжков и задержка посчитаны. TX откроет только кнопка Передать.
        self._heard_ready = list(stable)

    def release_heard(self, t_s: float) -> bool:
        """Оператор нажал Передать: на плату уходит весь записанный список."""
        stable = list(self._heard_ready or [])
        if len(stable) < 2:
            stable = [self._bin_mhz[b] for b in self._bin_order
                      if self._bin_hits.get(b, 0) >= MIN_CONFIRMS]
        if len(stable) < 2 or self.jams_sent:
            return False
        self._arm_heard_list(stable, t_s)
        return self.jams_sent >= 1

    def _stored_bins(self) -> set:
        if not self.pid:
            return set()
        rec = self.store.get(self.pid)
        return {freq_bin_mhz(float(x)) for x in (rec.get("freqs_mhz") or [])}

    def _commit_freqs(self, uniq_mhz: list, t_s: float) -> None:
        """Список частот в порядке появления внутри окон. Цикл — весь список."""
        if self.sub is None:
            pair = self._corridor_hz()
            if pair:
                span = [pair[0], pair[1]]
            else:
                hz = [float(x) * 1e6 for x in uniq_mhz]
                span = [min(hz), max(hz)]
            self.sub = extract_subcorridor(span, "scan")
        hops = [{
            "channel_idx": i,
            "freq_mhz": float(mhz),
            "dwell_us": SCAN_DWELL_S * 1e6,
            "t_start": float(t_s),
            "sample_count": i,
            "confidence": 1.0,
            "hole": False,
            "fhsdt_valid": True,
        } for i, mhz in enumerate(uniq_mhz)]
        rows = hops if len(hops) >= 2 else hops * 2
        pid = self.store.add_pattern(self.sub, rows)
        rec = self.store.get(pid)
        rec["cycle_length"] = len(hops)
        rec["cycle"] = [h["channel_idx"] for h in hops]
        rec["hop_sequence"] = list(rec["cycle"])
        rec["freqs_mhz"] = [h["freq_mhz"] for h in hops]
        rec["freq_khz"] = [int(round(h["freq_mhz"] * 1000.0)) for h in hops]
        self.pid = pid
        apply_timer_cycle(rec, energy=[], dt_s=self.dt)
        rec["dwell_us"] = SCAN_DWELL_S * 1e6
        rec["dwell_s"] = SCAN_DWELL_S
        self.drift.set_cycles(len(hops))
        self.drift.reset()
        self._confirm_base = 0
        self._go(CONFIRMING, t_s, hops=len(hops), cycle=len(hops), by="freq_set")

    def _set_confirm(self, t_s: float, score: float) -> None:
        rec = self.store.get(self.pid)
        rec["confidence"] = float(score)
        count = self.store.mark_confirmed(self.pid)
        if count >= MIN_CONFIRMS and rec["confirmed"]:
            self.store.classify_threat_type(self.pid)
            self._jam_by_set = True
            self._jam_now(t_s, preload=True)
            nwin = int((getattr(self, "_lo_plan", None) or {}).get("n") or 1)
            self._go(MULTI_LO if nwin > 1 else JAMMING, t_s, confirms=count,
                     by="freq_set")

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
        # Широкий коридор держит одну сетку от F1. Сужение по первым вспышкам
        # отрезало бы хвост ряда — в LUT оставалось только начало.
        if not self._wide():
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
        if self._set_handled:
            self._set_handled = False
            return
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
            self._jam_by_set = False
            self._jam_now(t_s, preload=True)
            nwin = int((getattr(self, "_lo_plan", None) or {}).get("n") or 1)
            self._go(MULTI_LO if nwin > 1 else JAMMING, t_s, confirms=count)

    def _tick_monitoring(self, ch_pwr, freqs_hz, t_s: float, hop) -> None:
        if self._jam_until is not None and float(t_s) >= float(self._jam_until):
            self._go(RE_SCAN, t_s, note="jam_timer")
            self._rescan_origin(t_s, "jam_timer")
            return
        if self.state in (JAMMING, MULTI_LO) and self._jam_until is not None:
            self.state = TIMER
        pid2, nxt, lp = match_and_predict(self.store, self._live,
                                          self.sub["sub_corridor_id"])
        lp_score = lp if pid2 == self.pid else 0.0
        if nxt is None:
            nxt = self._fb.get("next_channel")
            lp_score = float(self._fb.get("conf") or 0.0)
        d = (self.drift.update(lp_score) if hop is not None
             else {"drift": False})
        dwell_s = max(self.dt, float(self.store.get(self.pid)
                                     .get("dwell_s", self.dt)))
        self.eff.update(expected=self.dt / dwell_s,
                        observed=1.0 if hop is not None else 0.0)
        # Список частот не обязан повторить порядок. Сбой порядка
        # гасил удар, пока скачки 2400–2480 ещё шли.
        if d["drift"] and not self._jam_by_set:
            self._stop_jam(t_s, "drift")
            self._go(DRIFT_DETECTED, t_s, lp_score=round(lp_score, 3))
            self.rec.reset()
            self._live = []
            self._go(RE_LEARNING, t_s)
            return
        if hop is not None:
            rec = self.store.get(self.pid)
            self.position = (self.position + 1) % max(1, int(rec["cycle_length"]))
            if nxt is not None and lp_score >= 0.7:
                self._last_jam_ch = nxt
                self._go(MONITORING, t_s, keep=True)
        if (not getattr(self, "_until_stop", False)
                and self._last_hop_t is not None
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
