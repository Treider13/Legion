#!/usr/bin/env python3
"""viewer.py — ОТДЕЛЬНЫЙ ПРОЦЕСС визуализации (шаг 8).

Читает UDP JSON от UdpPublisher (ipc.py), рендерит 60 FPS:
спектр + водопад, CH_PWR_gpu по каналам, классификация, hop map.
В пайплайн не встраивается (запрещено); AetherSDR/Qt6 QRhi может
читать тот же порт — формат в ipc.py.

    python3 -m legion_rx.viewer --port 5590

Зависимости: PyQt6, pyqtgraph (requirements-lab.txt). Без них — сообщение
об ошибке, не traceback.
"""
from __future__ import annotations

import argparse
import json
import socket
import sys

import numpy as np

WF_ROWS = 512
FPS_MS = 16  # 60 FPS


def main() -> int:
    ap = argparse.ArgumentParser(description="LEGION lab viewer (отдельный процесс)")
    ap.add_argument("--port", type=int, default=5590)
    ap.add_argument("--host", default="127.0.0.1")
    args = ap.parse_args()
    try:
        from PyQt6 import QtCore, QtWidgets
        import pyqtgraph as pg
    except ImportError as e:
        print(f"viewer: {e} — установите PyQt6 pyqtgraph "
              f"(host/requirements-lab.txt); пайплайн без вьювера работает")
        return 2

    # [F2] GPU-рендер кривых через QOpenGLWidget (по умолчанию pyqtgraph —
    # CPU raster). antialias=False: CPU не жечь на сглаживание. 60 FPS —
    # критерий лабораторного замера (AetherSDR/Qt6 QRhi читает тот же UDP
    # JSON, если pyqtgraph не вытянет — интерфейс уже разнесён по процессам).
    pg.setConfigOptions(useOpenGL=True, antialias=False)

    app = QtWidgets.QApplication(sys.argv)
    win = QtWidgets.QMainWindow()
    win.setWindowTitle("LEGION lab — спектр/водопад/CH_PWR/hop map")
    cw = pg.GraphicsLayoutWidget()
    win.setCentralWidget(cw)

    p_spec = cw.addPlot(row=0, col=0, title="Спектр, dB")
    spec_curve = p_spec.plot(pen=pg.mkPen((80, 200, 255)))
    p_ch = cw.addPlot(row=0, col=1, title="CH_PWR_gpu по каналам")
    ch_bars = pg.BarGraphItem(x=[], height=[], width=0.8,
                              brush=pg.mkBrush(120, 220, 120, 180))
    p_ch.addItem(ch_bars)
    p_wf = cw.addPlot(row=1, col=0, colspan=2, title="Водопад")
    wf_img = pg.ImageItem(axisOrder="row-major")
    lut = pg.colormap.get("viridis").getLookupTable(0.0, 1.0, 256)
    wf_img.setLookupTable(lut)
    p_wf.addItem(wf_img)
    # Когнитивный контур (ТЗ п.9): parent — тонкая рамка, sub — яркая;
    # маркер предсказанного скачка; строка state/pattern.
    reg_parent = pg.LinearRegionItem(values=(0, 0), movable=False,
                                     pen=pg.mkPen((150, 150, 150), width=1))
    reg_sub = pg.LinearRegionItem(values=(0, 0), movable=False,
                                  pen=pg.mkPen((255, 220, 0), width=3))
    for r in (reg_parent, reg_sub):
        r.setVisible(False)
        p_spec.addItem(r)
    pred_mark = pg.ScatterPlotItem(symbol="v", size=14,
                                   brush=pg.mkBrush(255, 80, 80))
    p_spec.addItem(pred_mark)
    label = QtWidgets.QLabel("ожидание данных…")
    label.setStyleSheet("font-family: monospace; font-size: 14px; padding: 4px")
    cw.addItem(label, row=2, col=0, colspan=2)

    state = {
        "wf": np.full((WF_ROWS, 1024), -120.0, dtype=np.float32),
        "cls": "—", "conf": 0.0, "hop": {}, "stat": {},
        "corridor": {}, "fsm": {},
    }

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((args.host, args.port))
    sock.setblocking(False)

    def poll() -> None:
        for _ in range(256):  # дренируем очередь датаграмм за тик
            try:
                data, _ = sock.recvfrom(1 << 20)
            except (BlockingIOError, InterruptedError):
                break
            try:
                msg = json.loads(data.decode("utf-8", "replace"))
            except json.JSONDecodeError:
                continue
            kind = msg.get("kind")
            v = np.asarray(msg.get("v", []), dtype=np.float32)
            if kind == "spec" and v.size:
                spec_curve.setData(v)
            elif kind == "wf" and v.size:
                wf = state["wf"]
                if v.size != wf.shape[1]:
                    wf = np.full((WF_ROWS, v.size), -120.0, dtype=np.float32)
                    state["wf"] = wf
                wf[:] = np.roll(wf, 1, axis=0)
                wf[0] = v
                wf_img.setImage(wf, autoLevels=False,
                                levels=(-120.0, -20.0))
            elif kind == "ch" and v.size:
                ch_bars.setOpts(x=np.arange(v.size), height=v)
            elif kind == "cls":
                state["cls"] = msg.get("class") or "—"
                state["conf"] = msg.get("conf", 0.0)
            elif kind == "hop":
                state["hop"] = msg
            elif kind == "stat":
                state["stat"] = msg
            elif kind == "corridor":
                parent, sub = msg.get("parent"), msg.get("sub")
                axis = msg.get("axis") or []
                if axis and parent and sub and parent[0] is not None:
                    if len(axis) >= 3:
                        f0, f1, nfft = (float(axis[0]), float(axis[1]),
                                        float(axis[2]) or 1024.0)
                        den = (f1 - f0) or 1.0
                        hz2bin = lambda f: (float(f) - f0) / den * nfft
                    else:
                        f0, step = float(axis[0]), float(axis[1]) or 1.0
                        hz2bin = lambda f: (float(f) - f0) / step
                    reg_parent.setRegion((hz2bin(parent[0]),
                                          hz2bin(parent[1])))
                    reg_parent.setVisible(True)
                    reg_sub.setRegion((hz2bin(sub[0]), hz2bin(sub[1])))
                    reg_sub.setVisible(True)
                else:
                    reg_parent.setVisible(False)
                    reg_sub.setVisible(False)
            elif kind == "pred":
                ch = msg.get("channel")
                if ch is not None:
                    pred_mark.setData([ch], [-20.0])
            elif kind == "fsm":
                state["fsm"] = msg
        h, s = state["hop"], state["stat"]
        fsm = state.get("fsm", {})
        fsm_txt = ""
        if fsm:
            fsm_txt = (f"state: {fsm.get('state', '—')}   "
                       f"pattern: {fsm.get('pattern_id') or '—'}   "
                       f"type: {fsm.get('sequence_type') or '—'}   "
                       f"jams: {fsm.get('jams_sent', '—')}   "
                       f"PDR: {fsm.get('pdr_target', '—')}   ")
        label.setText(
            fsm_txt +
            f"класс: {state['cls']} ({state['conf']:.2f})   "
            f"hop: {h.get('rate_hz', '—')} Гц → {h.get('match') or '—'}   "
            f"next: ch{h.get('next_channel', '—')}   "
            f"поток: {s.get('throughput_mb_s', '—')} МБ/с   "
            f"overruns: {s.get('overruns_total', '—')}")

    timer = QtCore.QTimer()
    timer.timeout.connect(poll)
    timer.start(FPS_MS)
    win.resize(1400, 900)
    win.show()
    rc = app.exec()
    sock.close()
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
