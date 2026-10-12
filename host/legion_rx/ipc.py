"""IPC пайплайн → окно (шаг 8).

Живой спектр и водопад рисует главное окно (`main_app`). Пайплайн только
публикует кадры: в том же процессе — `VizBus`, снаружи — UDP JSON.
Отдельного процесса-вьювера нет.

Типы кадров:
  spec  — усреднённый спектр (F,) dB, до 1024 точек (даунсэмпл max);
  wf    — строка водопада (F,) dB;
  ch    — CH_PWR_gpu (M,) линейные (НЕ пишется в FPGA — только отображение);
  cls   — классификация {class, conf, latency_ms};
  hop   — hop map {rate_hz, match, next_channel, conf, acc};
  stat  — статус {overruns, throughput_mb_s, ...}.
"""
from __future__ import annotations

import json
import socket
import threading

import numpy as np

DEFAULT_PORT = 5590


class UdpPublisher:
    def __init__(self, host: str = "127.0.0.1", port: int = DEFAULT_PORT,
                 max_points: int = 1024):
        self._addr = (host, int(port))
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self._max = int(max_points)
        self.dropped = 0

    def _fit(self, a) -> list:
        v = np.asarray(a, dtype=np.float32)
        if v.size > self._max:
            k = v.size // self._max + 1
            v = v[: (v.size // k) * k].reshape(-1, k).max(axis=1)
        return [round(float(x), 2) for x in v]

    def send(self, kind: str, payload: dict) -> None:
        msg = json.dumps({"kind": kind, **payload},
                         ensure_ascii=False).encode()
        try:
            self._sock.sendto(msg, self._addr)
        except OSError:
            self.dropped += 1

    def send_spec(self, spec_db) -> None:
        self.send("spec", {"v": self._fit(spec_db)})

    def send_wf_row(self, row_db, f_start_hz=None, f_end_hz=None) -> None:
        payload = {"v": self._fit(row_db)}
        if f_start_hz is not None:
            payload["f0"] = float(f_start_hz)
        if f_end_hz is not None:
            payload["f1"] = float(f_end_hz)
        self.send("wf", payload)

    def send_ch_pwr(self, ch_pwr) -> None:
        self.send("ch", {"v": self._fit(ch_pwr)})

    def send_cls(self, cls: dict) -> None:
        self.send("cls", {"class": cls.get("class"),
                          "conf": round(float(cls.get("conf", 0.0)), 3),
                          "latency_ms": round(float(cls.get("latency_ms", 0.0)), 3)})

    def send_hop(self, hop: dict) -> None:
        self.send("hop", {k: hop.get(k) for k in
                          ("rate_hz", "match", "next_channel", "conf", "how")})

    def send_stat(self, stat: dict) -> None:
        self.send("stat", stat)

    # ---- когнитивный контур (ТЗ п.9) ----

    def send_corridor(self, parent: dict, sub: dict,
                      axis: "tuple | None" = None) -> None:
        """axis = (f_start_hz, f_end_hz, nfft) спектра fftshift.
        bin = (f − f_start) / (f_end − f_start) × nfft. Без axis рамки скрыты."""
        msg = {"parent": [parent.get("f_start"), parent.get("f_end")],
               "sub": [sub.get("f_start"), sub.get("f_end")]}
        if axis is not None:
            msg["axis"] = [float(x) for x in axis]
        self.send("corridor", msg)

    def send_pred(self, channel, t_s: float, pattern_id: "str | None") -> None:
        self.send("pred", {"channel": channel, "t": round(float(t_s), 4),
                           "pattern_id": pattern_id})

    def send_fsm(self, state: str, rec: dict) -> None:
        self.send("fsm", {"state": state,
                          "pattern_id": rec.get("pattern_id"),
                          "position": rec.get("position"),
                          "confidence": rec.get("confidence"),
                          "sequence_type": rec.get("sequence_type"),
                          "jams_sent": rec.get("jams_sent"),
                          "pdr_target": rec.get("pdr_target"),
                          "threat": rec.get("threat")})

    def close(self) -> None:
        self._sock.close()


class VizBus:
    """Кадры спектра в том же процессе, где окно. Поток радио пишет, окно читает."""

    def __init__(self, wf_rows: int = 180, max_points: int = 1024) -> None:
        self._lock = threading.Lock()
        self._wf_rows = int(wf_rows)
        self._max = int(max_points)
        self.spec = None
        self.wf = None
        self.f0 = None
        self.f1 = None
        self.ch = None
        self.stat: dict = {}
        self.cls: dict = {}
        self.hop: dict = {}
        self.corridor = None
        self.pred = None
        self.seq = 0

    def _fit(self, a):
        v = np.asarray(a, dtype=np.float32).ravel()
        if v.size > self._max:
            k = v.size // self._max + 1
            v = v[: (v.size // k) * k].reshape(-1, k).max(axis=1)
        return v

    def send_spec(self, spec_db) -> None:
        v = self._fit(spec_db)
        if v.size == 0:
            return
        with self._lock:
            self.spec = v
            self.seq += 1

    def send_wf_row(self, row_db, f_start_hz=None, f_end_hz=None) -> None:
        v = self._fit(row_db)
        if v.size == 0:
            return
        with self._lock:
            if self.wf is None or self.wf.shape[1] != v.size:
                self.wf = np.full((self._wf_rows, v.size), -120.0, dtype=np.float32)
            self.wf[1:] = self.wf[:-1]
            self.wf[0] = v
            self.spec = v
            if f_start_hz is not None:
                self.f0 = float(f_start_hz)
            if f_end_hz is not None:
                self.f1 = float(f_end_hz)
            self.seq += 1

    def send_ch_pwr(self, ch_pwr) -> None:
        v = self._fit(ch_pwr)
        with self._lock:
            self.ch = v
            self.seq += 1

    def send_cls(self, cls: dict) -> None:
        with self._lock:
            self.cls = {
                "class": cls.get("class"),
                "conf": float(cls.get("conf", 0.0)),
            }

    def send_hop(self, hop: dict) -> None:
        with self._lock:
            self.hop = {k: hop.get(k) for k in
                        ("rate_hz", "match", "next_channel", "conf", "how")}

    def send_stat(self, stat: dict) -> None:
        with self._lock:
            self.stat = dict(stat)

    def send_corridor(self, parent: dict, sub: dict,
                      axis: "tuple | None" = None) -> None:
        msg = {"parent": [parent.get("f_start"), parent.get("f_end")],
               "sub": [sub.get("f_start"), sub.get("f_end")]}
        if axis is not None:
            msg["axis"] = [float(x) for x in axis]
        with self._lock:
            self.corridor = msg

    def send_pred(self, channel, t_s: float, pattern_id: "str | None") -> None:
        with self._lock:
            self.pred = {"channel": channel, "t": float(t_s),
                         "pattern_id": pattern_id}

    def send_fsm(self, state: str, rec: dict) -> None:
        with self._lock:
            self.stat = {
                **self.stat,
                "fsm_state": state,
                "pattern_id": rec.get("pattern_id"),
            }

    def close(self) -> None:
        return None

    def snapshot(self) -> dict:
        with self._lock:
            return {
                "spec": None if self.spec is None else self.spec.copy(),
                "wf": None if self.wf is None else self.wf.copy(),
                "f0": self.f0,
                "f1": self.f1,
                "ch": None if self.ch is None else self.ch.copy(),
                "stat": dict(self.stat),
                "cls": dict(self.cls),
                "hop": dict(self.hop),
                "corridor": None if self.corridor is None else dict(self.corridor),
                "pred": None if self.pred is None else dict(self.pred),
                "seq": self.seq,
            }


class InProcessBus:
    """Команды окна в тот же процесс, где FSM. USB один.

    Команды: start, stop, pause, save, load, reset.
    Кадр состояния и водопад читает то же окно.
    """

    COMMANDS = ("start", "stop", "pause", "save", "load", "reset")

    def __init__(self) -> None:
        self.viz = VizBus()
        self.cmd: "str | None" = None
        self.params: dict = {}
        self.state: dict = {
            "state": "LISTENING",
            "jam_remaining_s": 0.0,
            "jam_duration_s": 15.0,
            "pattern_id": None,
            "cycle_length": 0,
            "jams_count": 0,
            "current_lo_window": None,
            "freq_shift_hz": 15000,
            "threat": None,
            "scan_cycle_count": 0,
        }

    def submit(self, cmd: str, **params) -> None:
        if cmd not in self.COMMANDS:
            raise ValueError(cmd)
        self.cmd = cmd
        self.params = dict(params)

    def take(self) -> "tuple[str | None, dict]":
        cmd, params = self.cmd, self.params
        self.cmd = None
        self.params = {}
        return cmd, params

    def publish_fsm(self, fsm, t_s: float) -> None:
        until = getattr(fsm, "_jam_until", None)
        remain = 0.0 if until is None else max(0.0, float(until) - float(t_s))
        plan = getattr(fsm, "_lo_plan", None) or {}
        self.state = {
            "state": fsm.state,
            "jam_remaining_s": remain,
            "jam_duration_s": float(getattr(fsm, "jam_duration_s", 15.0)),
            "pattern_id": fsm.pid,
            "cycle_length": int((fsm.store.get(fsm.pid) or {}).get("cycle_length") or 0)
            if fsm.pid else 0,
            "jams_count": int(getattr(fsm, "jams_sent", 0)),
            "current_lo_window": plan.get("n"),
            "freq_shift_hz": 15000,
            "threat": (fsm.store.get(fsm.pid) or {}).get("threat") if fsm.pid else None,
            "scan_cycle_count": int(getattr(fsm, "_tick_i", 0)),
        }
