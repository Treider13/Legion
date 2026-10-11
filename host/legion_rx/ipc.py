"""IPC пайплайн → вьювер (шаг 8): UDP-датаграммы JSON на localhost.

Отдельный процесс-вьювер (AetherSDR/Qt6 QRhi ИЛИ штатный viewer.py)
читает порт. Встраивание визуализации в Python-пайплайн запрещено —
здесь только публикация, рендер снаружи.

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

    def send_wf_row(self, row_db) -> None:
        self.send("wf", {"v": self._fit(row_db)})

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

    def close(self) -> None:
        self._sock.close()
