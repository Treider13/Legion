"""CognitiveFSM — непрерывный когнитивный контур FHSS-памяти (ТЗ п.8):

  услышал → понял паттерн → запомнил → немедленно отработал →
  контролирует → адаптируется.

  LISTENING → LEARNING → CONFIRMING → JAMMING → MONITORING →
  (DRIFT_DETECTED | TARGET_SILENT | RE_ACQUIRE) → …

Жёсткие правила ТЗ:
  * confirmed при M >= 3 → помеха НЕМЕДЛЕННО (в том же тике);
  * помеха только в sub-corridor и только по confirmed-паттерну;
  * прослушка НЕ прекращается в JAMMING/MONITORING (параллельный контроль);
  * паттерны не удаляются (pending/legacy).
"""
from __future__ import annotations

import time

import numpy as np

from .corridor import CorridorDetector, extract_subcorridor
from .drift_detector import DriftDetector
from .effectiveness_monitor import EffectivenessMonitor
from .hop_recorder import HopRecorder
from .hopmap import match_and_predict
from .pattern_store import PatternStore

LISTENING = "LISTENING"
LEARNING = "LEARNING"
CONFIRMING = "CONFIRMING"
JAMMING = "JAMMING"
MONITORING = "MONITORING"
TARGET_SILENT = "TARGET_SILENT"
RE_ACQUIRE = "RE_ACQUIRE"
RE_LEARNING = "RE_LEARNING"
DRIFT_DETECTED = "DRIFT_DETECTED"

MIN_CONFIRMS = 3          # фаза 2: 3 цикла → confirmed
MATCH_GO = 0.9            # порог match для подтверждения/ре-захвата
SILENT_S = 0.100          # фаза 4: цель замолчала >100 мс
REACQUIRE_MIN_HOPS = 8    # фаза 5: find_match по 8 скачкам
P_HOPPING_GO = 0.6        # posterior [G2] для выхода из LISTENING


class CognitiveFSM:
    def __init__(self, store: PatternStore, n_chans: int, fs_hz: float,
                 lo_hz: float, fpga=None, pub=None, frame_dt_s: float = 1e-3):
        self.store = store
        self.n_chans = int(n_chans)
        self.fs_hz = float(fs_hz)
        self.lo_hz = float(lo_hz)
        self.fpga = fpga
        self.pub = pub
        self.dt = float(frame_dt_s)
        self.det = CorridorDetector()
        self.eff = EffectivenessMonitor()
        self.drift = DriftDetector()
        self.rec: "HopRecorder | None" = None
        self.sub: "dict | None" = None
        self.parent: "dict | None" = None
        self.state = LISTENING
        self.pid: "str | None" = None
        self.position = 0
        self.jams_sent = 0
        self.transitions: list[dict] = []
        self._live: list[int] = []        # последние каналы (find_match)
        self._last_hop_t: "float | None" = None
        self._silent_since: "float | None" = None
        self._reacquire_hops = 0
        self._confirm_base = 0
        self._tick_i = 0
        self._listen_freqs: list[float] = []

    # ---- служебное ----

    def _go(self, to: str, t_s: float, **extra) -> None:
        rec = {"tick": self._tick_i, "from": self.state, "to": to,
               "t_s": round(float(t_s), 6), "pattern_id": self.pid,
               "jams_sent": self.jams_sent, **extra}
        self.transitions.append(rec)
        self.state = to

    def _publish(self, t_s: float, confidence: float = 0.0) -> None:
        if self.pub:
            rec = self.store.get(self.pid) if self.pid else {}
            self.pub.send_fsm(self.state, {
                "pattern_id": self.pid, "position": self.position,
                "confidence": confidence,
                "sequence_type": rec.get("sequence_type"),
                "jams_sent": self.jams_sent,
                "pdr_target": self.eff.pdr})

    def _jam_now(self, t_s: float, preload: bool = False) -> dict:
        """НЕМЕДЛЕННАЯ упреждающая помеха (фаза 3): в том же тике.
        preload LUT — только на (ре)захвате (первый удар / RE_ACQUIRE):
        FPGA дальше работает АВТОНОМНО по карте, ПК шлёт per-hop удары;
        20 записей на каждый скачок — избыточно (замер в логе)."""
        from .fpga_control import apply_predictive_jam
        from .fpga_preload import preload_hop_sequence

        if self.fpga is None:
            raise RuntimeError("FSM: помеха без FPGA-транспорта")
        pat = self.store.get(self.pid)
        jam = apply_predictive_jam(self.fpga, self.sub, pat,
                                   position=self.position, lo_hz=self.lo_hz,
                                   fs_hz=self.fs_hz, horizon=1)
        pre_n = 0
        if preload:
            pre_n = preload_hop_sequence(self.fpga, pat, self.sub,
                                         position=self.position,
                                         next_n=20)["written"]
        self.store.mark_jammed(self.pid)
        self.jams_sent += 1
        self.eff.mark_jam_applied()
        self._go(JAMMING, t_s, action="apply_predictive_jam+preload",
                 f_jam_hz=jam["f_jam_hz"], preload_n=pre_n,
                 immediate=True)
        if self.pub and self.pid:
            nxt = match_and_predict(self.store, self._live,
                                    self.sub["sub_corridor_id"])
            self.pub.send_pred(nxt[1], t_s, self.pid)
        return jam

    def _stop_jam(self, t_s: float, why: str) -> None:
        from .fpga_control import stop_jam

        if self.fpga is not None:
            stop_jam(self.fpga)
        self.transitions.append({"tick": self._tick_i, "from": self.state,
                                 "to": self.state, "t_s": round(float(t_s), 6),
                                 "action": "stop_jam", "why": why,
                                 "pattern_id": self.pid})

    # ---- главный тик ----

    def tick(self, ch_pwr, freqs_hz, t_s: float) -> dict:
        self._tick_i += 1
        st = self.state
        hop = None
        if st == LISTENING:
            self._tick_listening(ch_pwr, freqs_hz, t_s)
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
                self._live = self._live[-24:]
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

    # ---- состояния ----

    def _tick_listening(self, ch_pwr, freqs_hz, t_s: float) -> None:
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
            self.parent = parent
            # sub из всех услышанных скачков (±400 кГц), не из одного рана
            self.sub = extract_subcorridor(hops, parent["corridor_id"])
            self.rec = HopRecorder(self.sub)
            self._go(LEARNING, t_s, p_hopping=round(post["p_hopping"], 3),
                     sub=[self.sub["f_start"], self.sub["f_end"]])
            if self.pub:
                self.pub.send_corridor(
                    {"f_start": parent.get("f_start", min(hops)),
                     "f_end": parent.get("f_end", max(hops))},
                    self.sub)

    def _expand_sub(self) -> None:
        """Sub растёт по услышанным скачкам (±400 кГц), не по parent.
        sub_corridor_id не менять — иначе PatternStore теряет матч."""
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
            self._confirm_base = self.rec.valid_count
            self._go(CONFIRMING, t_s, hops=self.rec.valid_count)

    def _tick_confirming(self, t_s: float) -> None:
        rec = self.store.get(self.pid)
        cyc = max(1, int(rec["cycle_length"]))
        if self.rec.valid_count < self._confirm_base + cyc:
            return
        m = self.store.find_match(self._live[-cyc:],
                                  self.sub["sub_corridor_id"], min_match=8)
        self._confirm_base = self.rec.valid_count
        if m is None or m[2] < MATCH_GO:
            return
        self.position = m[1]
        count = self.store.mark_confirmed(self.pid)
        if count >= MIN_CONFIRMS and rec["confirmed"]:
            self._jam_now(t_s, preload=True)  # НЕМЕДЛЕННО + карта в FPGA
            self._go(MONITORING, t_s, confirms=count)

    def _tick_monitoring(self, ch_pwr, freqs_hz, t_s: float, hop) -> None:
        # прослушка НЕ прекращается (параллельный контроль, фаза 3–4)
        pid2, nxt, lp = match_and_predict(self.store, self._live[-16:],
                                          self.sub["sub_corridor_id"])
        lp_score = lp if pid2 == self.pid else 0.0
        d = self.drift.update(lp_score)
        # эффективность: expected 1 всплеск/тик при активной помехе
        self.eff.update(expected=1, observed=1 if hop is not None else 0)
        if d["drift"]:
            self._stop_jam(t_s, "drift")
            self._go(DRIFT_DETECTED, t_s, lp_score=round(lp_score, 3))
            self.rec.reset()
            self._live = []
            self._go(RE_LEARNING, t_s)
            return
        ev = self.eff.evaluate()
        if ev["verdict"] != getattr(self, "_eff_verdict", None):
            self._eff_verdict = ev["verdict"]
            if ev["verdict"] == "ineffective":
                self.transitions.append({"tick": self._tick_i, "from": MONITORING,
                                         "to": MONITORING, "t_s": float(t_s),
                                         "action": "adjust_strategy",
                                         "pdr_target": ev["pdr_target"]})
        # упреждающий удар на следующий цикл по паттерну
        if nxt is not None and lp_score >= 0.7:
            self.position = (self.position + 1) % len(
                self.store.get(self.pid)["hop_sequence"])
            self._jam_now(t_s)
            self._go(MONITORING, t_s, keep=True)
        # цель замолчала > 100 мс → «попадание», фаза 5
        if (self._last_hop_t is not None
                and float(t_s) - self._last_hop_t > SILENT_S):
            self._stop_jam(t_s, "target_silent")
            self._silent_since = float(t_s)
            self._live = []  # окно ре-захвата — только НОВЫЕ скачки
            self._reacquire_hops = 0
            self._go(TARGET_SILENT, t_s, note="попадание зафиксировано")

    def _tick_target_silent(self, t_s: float) -> None:
        # фаза 5: слушаем; цель появилась → find_match по 8 скачкам
        self._reacquire_hops = len(self._live)
        if self._reacquire_hops < REACQUIRE_MIN_HOPS:
            return
        self._go(RE_ACQUIRE, t_s, live_hops=self._reacquire_hops)
        m = self.store.find_match(self._live[-REACQUIRE_MIN_HOPS:],
                                  self.sub["sub_corridor_id"], min_match=8)
        if m is not None and m[0] == self.pid and m[2] >= MATCH_GO:
            self.position = m[1]
            self.drift.reset()
            self._jam_now(t_s, preload=True)  # быстрый удар по памяти
            self._go(MONITORING, t_s, reacquire_conf=round(m[2], 3))
        else:
            self.rec.reset()                # новый паттерн — фаза 1
            self._live = []
            self.pid = None
            self._go(LEARNING, t_s, note="новый паттерн")

    def _tick_relearning(self, t_s: float) -> None:
        if self.rec.valid_count >= 16:
            self.store.update_pattern(self.pid, self.rec.hops)
            self._confirm_base = self.rec.valid_count
            self.drift.reset()
            self._go(CONFIRMING, t_s, relearned=True)
