"""Окно и автомат в одном процессе. USB на ударе держит libbladeRF.

--headless печатает состояние без окна.
Параметры из config.json рядом с этим файлом. Запись при каждом изменении.
Новые длительность и коридор читает следующий цикл, не текущий удар.
"""
from __future__ import annotations

import argparse
import json
import struct
import threading
import time
import zlib
from datetime import datetime
from pathlib import Path

import numpy as np

from .cognitive import CognitiveFSM, LISTENING
from .ops import acquire_lock, install_shutdown, rbf_warning, validate_config
from .pattern_store import PatternStore
from .ipc import InProcessBus

HERE = Path(__file__).resolve().parent
CONFIG_PATH = HERE / "config.json"

DEFAULTS = {
    "f_start_hz": 2.0e9,
    "f_end_hz": 2.5e9,
    "jam_duration_s": 15.0,
    "mute_ns": 0,
    "retune_time_us": None,
    "lna_gain_db": 20,
    "rx_fs_hz": 34.0e6,
    "freq_shift_hz": 15000,
}


def load_config() -> dict:
    cfg = dict(DEFAULTS)
    if CONFIG_PATH.is_file():
        cfg.update(json.loads(CONFIG_PATH.read_text(encoding="utf-8")))
    return validate_config(cfg)


def save_config(cfg: dict) -> None:
    CONFIG_PATH.write_text(
        json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


class App:
    def __init__(self, cfg: dict, headless: bool) -> None:
        self.cfg = cfg
        self.headless = headless
        self.bus = InProcessBus()
        from .lo_sweep import window_hz
        air = window_hz(34.0e6)
        self.fsm = CognitiveFSM(
            PatternStore(), n_chans=256, fs_hz=34.0e6,
            lo_hz=float(cfg["f_start_hz"]), ibw_hz=air)
        self.fsm.jam_duration_s = float(cfg["jam_duration_s"])
        self.fsm.mute_ns = int(cfg["mute_ns"])
        self.fsm.scan_corridor = {
            "f_start": float(cfg["f_start_hz"]),
            "f_end": float(cfg["f_end_hz"]),
            "corridor_id": "operator",
        }
        self.pending = dict(cfg)
        self._stop_live = threading.Event()
        self._radio = None
        stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        self.log_path = HERE / f"log_{stamp}.txt"
        self._log("старт")
        note = rbf_warning(HERE.parents[2])
        if note:
            self._log(note)

    def _log(self, line: str) -> None:
        self._rotate_log()
        with self.log_path.open("a", encoding="utf-8") as f:
            f.write(f"{time.strftime('%H:%M:%S')} {line}\n")

    def _rotate_log(self) -> None:
        if not self.log_path.is_file() or self.log_path.stat().st_size < 10 * 1024 * 1024:
            return
        for i in range(4, 0, -1):
            src = Path(f"{self.log_path}.{i}")
            dst = Path(f"{self.log_path}.{i + 1}")
            if i == 4 and src.is_file():
                src.unlink()
            elif src.is_file():
                src.replace(dst)
        self.log_path.replace(Path(f"{self.log_path}.1"))

    def apply_pending_on_cycle(self) -> None:
        """Следующий цикл слушает новые границы и длительность."""
        if self.fsm.state != LISTENING:
            return
        self.fsm.jam_duration_s = float(self.pending["jam_duration_s"])
        self.fsm.mute_ns = int(self.pending["mute_ns"])
        self.fsm.scan_corridor = {
            "f_start": float(self.pending["f_start_hz"]),
            "f_end": float(self.pending["f_end_hz"]),
            "corridor_id": "operator",
        }
        self.cfg.update(self.pending)
        save_config(self.cfg)

    def handle_cmd(self, t_s: float) -> None:
        cmd, params = self.bus.take()
        if cmd is None:
            return
        if cmd == "start":
            self.fsm._paused = False
            self.start_radio()
            self._log("start")
        elif cmd == "stop":
            self.fsm._stop_jam(t_s, "stop")
            self._stop_live.set()
            self.fsm.store.save()
            save_config(self.cfg)
            self._log("stop")
        elif cmd == "pause":
            self.fsm.pause(t_s)
            self._log("pause")
        elif cmd == "save":
            save_config(self.cfg)
            self.fsm.store.save()
            self._log(f"save {CONFIG_PATH.name}")
        elif cmd == "load":
            self.cfg = load_config()
            self.pending = dict(self.cfg)
            self._log("load")
        elif cmd == "reset":
            self.cfg = dict(DEFAULTS)
            self.pending = dict(self.cfg)
            save_config(self.cfg)
            self._log("reset")
        if params:
            for k in ("f_start_hz", "f_end_hz", "jam_duration_s", "mute_ns",
                      "lna_gain_db"):
                if k in params:
                    self.pending[k] = params[k]

    def tick_status(self, t_s: float) -> dict:
        self.handle_cmd(t_s)
        self.apply_pending_on_cycle()
        self.bus.publish_fsm(self.fsm, t_s)
        return self.bus.state

    def start_radio(self) -> None:
        if self._radio is not None and self._radio.is_alive():
            return
        self._stop_live.clear()
        self._radio = threading.Thread(
            target=self._radio_body, daemon=True, name="legion-live")
        self._radio.start()

    def _radio_body(self) -> None:
        from .pipeline import live_from_app
        try:
            live_from_app(self, self._stop_live)
        except Exception as exc:
            import traceback
            self._log(f"радио: {exc}\n{traceback.format_exc()}")

    def shutdown(self, signum, _frame) -> None:
        self._stop_live.set()
        try:
            self.fsm._stop_jam(time.time(), "signal")
        except Exception:
            pass
        try:
            self.fsm.store.save()
            save_config(self.cfg)
        except Exception:
            pass
        raise SystemExit(128 + int(signum))


WF_ROWS = 180
WF_FLOOR = -120.0
WF_CEIL = -20.0


def waterfall_rgb(db) -> "object":
    """dB → RGB uint8. Низко — синий, высоко — жёлтый."""
    t = np.clip((np.asarray(db, dtype=np.float32) - WF_FLOOR) / (WF_CEIL - WF_FLOOR), 0.0, 1.0)
    r = np.clip(1.6 * t - 0.15, 0.0, 1.0)
    g = np.clip(1.4 * t - 0.35, 0.0, 1.0)
    b = np.clip(0.85 - t, 0.0, 1.0)
    return (np.stack((r, g, b), axis=-1) * 255.0).astype(np.uint8)


def png_bytes(rgb) -> bytes:
    """PNG без внешних библиотек: tkinter 8.6 читает его как картинку водопада."""
    h, w = rgb.shape[:2]
    raw = b"".join(b"\x00" + np.ascontiguousarray(rgb[y]).tobytes() for y in range(h))

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(raw, 1)) + chunk(b"IEND", b""))


def run_ui(app: App) -> None:
    import base64
    import tkinter as tk

    root = tk.Tk()
    root.title("Legion")
    root.geometry("1180x760")
    root.minsize(980, 640)
    frm = tk.Frame(root, padx=8, pady=8)
    frm.pack(fill="both", expand=True)
    frm.columnconfigure(1, weight=1)
    frm.rowconfigure(0, weight=1)

    controls = tk.Frame(frm)
    controls.grid(row=0, column=0, sticky="nsw", padx=(0, 12))
    view = tk.Frame(frm)
    view.grid(row=0, column=1, sticky="nsew")
    view.columnconfigure(0, weight=1)
    view.rowconfigure(2, weight=1)

    f0 = tk.StringVar(value=str(int(app.cfg["f_start_hz"])))
    f1 = tk.StringVar(value=str(int(app.cfg["f_end_hz"])))
    jam = tk.StringVar(value=str(app.cfg["jam_duration_s"]))
    mute = tk.StringVar(value=str(app.cfg["mute_ns"]))
    lna = tk.StringVar(value=str(app.cfg["lna_gain_db"]))
    retune = tk.StringVar(
        value="нет замера" if app.cfg["retune_time_us"] is None
        else str(app.cfg["retune_time_us"]))
    status = tk.StringVar(value="")

    def row(r, label, var, editable=True):
        tk.Label(controls, text=label).grid(row=r, column=0, sticky="w")
        e = tk.Entry(controls, textvariable=var, width=18)
        if not editable:
            e.configure(state="readonly")
        e.grid(row=r, column=1, sticky="w")

    row(0, "F_START, Гц", f0)
    row(1, "F_END, Гц", f1)
    row(2, "Jam Duration, с", jam)
    row(3, "Mute Duration, нс", mute)
    row(4, "Retune Time, мкс", retune, editable=False)
    row(5, "LNA Gain, дБ", lna)
    row(6, "RX FS", tk.StringVar(value="34000000"), editable=False)

    def push():
        app.bus.submit(
            "start",
            f_start_hz=float(f0.get()),
            f_end_hz=float(f1.get()),
            jam_duration_s=float(jam.get()),
            mute_ns=int(float(mute.get())),
            lna_gain_db=float(lna.get()))
        app.pending.update({
            "f_start_hz": float(f0.get()),
            "f_end_hz": float(f1.get()),
            "jam_duration_s": float(jam.get()),
            "mute_ns": int(float(mute.get())),
            "lna_gain_db": float(lna.get()),
        })

    tk.Button(controls, text="СТАРТ", command=push).grid(row=7, column=0, sticky="w", pady=(8, 0))
    tk.Button(controls, text="СТОП",
              command=lambda: app.bus.submit("stop")).grid(row=7, column=1, sticky="w", pady=(8, 0))
    tk.Button(controls, text="ПАУЗА",
              command=lambda: app.bus.submit("pause")).grid(row=8, column=0, sticky="w")
    tk.Button(controls, text="СОХРАНИТЬ",
              command=lambda: app.bus.submit("save")).grid(row=8, column=1, sticky="w")
    tk.Button(controls, text="СБРОС",
              command=lambda: app.bus.submit("reset")).grid(row=9, column=0, sticky="w")

    def open_log():
        import subprocess
        subprocess.Popen(["xdg-open", str(app.log_path)])

    tk.Button(controls, text="ЖУРНАЛ", command=open_log).grid(row=9, column=1, sticky="w")

    from .test_capture import TEST_SECONDS, apply_capture, maybe_save_test

    app.fields = {
        "f0": f0, "f1": f1, "jam": jam, "mute": mute,
        "lna": lna, "retune": retune,
    }

    def on_test():
        try:
            app.pending.update({
                "f_start_hz": float(f0.get()),
                "f_end_hz": float(f1.get()),
                "jam_duration_s": float(jam.get()),
                "mute_ns": int(float(mute.get())),
                "lna_gain_db": float(lna.get()),
            })
        except ValueError:
            status.set("тест: в полях числа")
            return
        if getattr(app.fsm, "test_on", False):
            app.fsm.test_finish_now = True
            maybe_save_test(app.fsm, app.bus.viz)
            return
        app.cfg.update(app.pending)
        save_config(app.cfg)
        app.fsm.jam_duration_s = float(app.pending["jam_duration_s"])
        app.fsm.mute_ns = int(app.pending["mute_ns"])
        app.fsm.lna_gain_db = float(app.pending["lna_gain_db"])
        app.fsm.retune_time_us = app.cfg.get("retune_time_us")
        app.fsm.scan_corridor = {
            "f_start": float(app.pending["f_start_hz"]),
            "f_end": float(app.pending["f_end_hz"]),
            "corridor_id": "operator",
        }
        app.fsm.replay_pattern = None
        app.fsm.test_jams_base = int(app.fsm.jams_sent)
        app.fsm.test_on = True
        app.fsm.test_saved = False
        app.fsm.test_finish_now = False
        app.fsm.test_file = None
        app.fsm.test_note = "тест идёт — включи ELRS рядом"
        app.fsm.test_deadline = time.time() + TEST_SECONDS
        app.fsm.test_log_path = str(app.log_path)
        app._log("тест: слушаю коридор")
        push()

    def on_load():
        from tkinter import filedialog
        from .test_capture import CAPTURE_DIR
        CAPTURE_DIR.mkdir(parents=True, exist_ok=True)
        path = filedialog.askopenfilename(
            initialdir=str(CAPTURE_DIR),
            filetypes=[("захват", "*.json"), ("все", "*")])
        if not path:
            return
        try:
            note = apply_capture(app, Path(path))
            save_config(app.cfg)
        except Exception as exc:
            note = f"не загрузился: {exc}"
        app._log(note)
        app.fsm.test_note = note

    tk.Button(controls, text="ТЕСТ", command=on_test).grid(row=10, column=0, sticky="w")
    tk.Button(controls, text="ЗАГРУЗИТЬ", command=on_load).grid(row=10, column=1, sticky="w")
    tk.Label(controls, textvariable=status, justify="left", wraplength=360).grid(
        row=11, column=0, columnspan=2, sticky="w", pady=(8, 0))

    tk.Label(view, text="Спектр и водопад", anchor="w").grid(row=0, column=0, sticky="w")
    spec_cv = tk.Canvas(view, height=150, bg="#0b0e14", highlightthickness=0)
    spec_cv.grid(row=1, column=0, sticky="ew")
    wf_img = tk.Label(view, bg="#0b0e14")
    wf_img.grid(row=2, column=0, sticky="nsew", pady=(6, 0))
    hold = {"photo": None}

    def paint():
        try:
            app.pending["f_start_hz"] = float(f0.get())
            app.pending["f_end_hz"] = float(f1.get())
            app.pending["jam_duration_s"] = float(jam.get())
            app.pending["mute_ns"] = int(float(mute.get()))
            app.pending["lna_gain_db"] = float(lna.get())
        except ValueError:
            pass
        st = app.tick_status(time.time())
        viz = app.bus.viz.snapshot()
        spec = viz["spec"]
        band = ""
        if viz["f0"] is not None and viz["f1"] is not None:
            band = f"  {viz['f0']/1e6:.3f}–{viz['f1']/1e6:.3f} МГц"
        spec_note = "спектр ждёт кадр" if spec is None else f"спектр {spec.size} точек{band}"
        extra = ""
        if getattr(app.fsm, "test_on", False):
            left = max(0.0, float(app.fsm.test_deadline) - time.time())
            extra = f"\nтест, осталось {left:.0f} с — включи ELRS рядом"
            radio = app._radio
            stalled = radio is None or not radio.is_alive()
            if left <= 0 and stalled:
                maybe_save_test(app.fsm, app.bus.viz)
            elif time.time() >= float(app.fsm.test_deadline) + 3.0:
                maybe_save_test(app.fsm, app.bus.viz)
        note = getattr(app.fsm, "test_note", None)
        if note:
            extra += f"\n{note}"
        status.set(
            f"{st['state']}  осталось {st['jam_remaining_s']:.1f} с  "
            f"pattern {st['pattern_id']}  цикл {st['cycle_length']}  "
            f"ударов {st['jams_count']}  окно {st['current_lo_window']}  "
            f"сдвиг {st['freq_shift_hz']} Гц  threat {st['threat']}\n"
            f"{spec_note}{extra}")
        spec_cv.delete("all")
        w = max(spec_cv.winfo_width(), 640)
        h = 150
        if spec is not None and spec.size:
            ys = np.clip((spec - WF_FLOOR) / (WF_CEIL - WF_FLOOR), 0.0, 1.0)
            n = ys.size
            pts = []
            for i, yv in enumerate(ys):
                x = 8 + (w - 16) * i / max(n - 1, 1)
                y = 12 + (h - 24) * (1.0 - float(yv))
                pts.extend((x, y))
            if len(pts) >= 4:
                spec_cv.create_line(*pts, fill="#7fd0ff", width=1)
            if viz["f0"] is not None:
                spec_cv.create_text(8, h - 8, anchor="w", fill="#89a",
                                    text=f"{viz['f0']/1e6:.3f} МГц")
            if viz["f1"] is not None:
                spec_cv.create_text(w - 8, h - 8, anchor="e", fill="#89a",
                                    text=f"{viz['f1']/1e6:.3f} МГц")
        else:
            spec_cv.create_text(16, 24, anchor="w", fill="#89a",
                                text="После СТАРТ здесь живой спектр с платы")
        wf = viz["wf"]
        if wf is not None:
            rgb = waterfall_rgb(wf)
            photo = tk.PhotoImage(data=base64.b64encode(png_bytes(rgb)))
            hold["photo"] = photo
            wf_img.configure(image=photo)
        root.after(80, paint)

    paint()
    root.mainloop()


def _cfg_from_args(args) -> dict:
    cfg = load_config()
    if args.f_start is not None:
        cfg["f_start_hz"] = float(args.f_start)
    if args.f_end is not None:
        cfg["f_end_hz"] = float(args.f_end)
    if args.jam is not None:
        cfg["jam_duration_s"] = float(args.jam)
    if args.mute is not None:
        cfg["mute_ns"] = int(args.mute)
    if args.lna is not None:
        cfg["lna_gain_db"] = float(args.lna)
    save_config(cfg)
    return cfg


def _design_hops(fsm) -> list:
    """Записанные частоты коридора. Кнопка Передать бьёт по этому списку."""
    ready = getattr(fsm, "_heard_ready", None)
    if ready:
        return [round(float(x), 3) for x in list(ready)[:256]]
    order = getattr(fsm, "_bin_order", None) or []
    hits = getattr(fsm, "_bin_hits", None) or {}
    mhz = getattr(fsm, "_bin_mhz", None) or {}
    heard = [round(float(mhz[b]), 3) for b in order
             if hits.get(b, 0) >= 1 and b in mhz]
    if heard:
        return heard[:256]
    sweeper = getattr(fsm, "sweeper", None)
    if sweeper is None:
        return []
    try:
        rows = sweeper.stitch()
    except Exception:
        return []
    out = []
    for hop in rows:
        freq = hop.get("freq_mhz")
        if freq:
            out.append(round(float(freq), 3))
    return out[:256]


def _emit_rx(app: App, running: bool) -> None:
    from .test_capture import _down

    viz = app.bus.viz.snapshot()
    spec = viz.get("spec")
    left = None
    if getattr(app.fsm, "test_on", False):
        left = max(0.0, float(app.fsm.test_deadline) - time.time())
    sweeper = getattr(app.fsm, "sweeper", None)
    line = {
        "kind": "rx",
        "running": running,
        "state": app.fsm.state,
        "note": getattr(app.fsm, "test_note", "") or "",
        "file": getattr(app.fsm, "test_file", None),
        "pattern_id": app.fsm.pid,
        "left_s": left,
        "f0_hz": viz.get("f0"),
        "f1_hz": viz.get("f1"),
        "db": _down(spec, 96) if spec is not None else [],
        "hops_mhz": _design_hops(app.fsm),
        "dwell_us": int(round(float(app.fsm._hop_period_s()) * 1e6)),
        "heard_ready": bool(getattr(app.fsm, "_heard_ready", None))
        and bool(getattr(app.fsm, "_hop_gaps", None)),
        "window_i": int(getattr(sweeper, "idx", 0) or 0),
        "windows": len(getattr(sweeper, "windows", []) or []),
    }
    print(json.dumps(line, ensure_ascii=False), flush=True)


def _arm_operator(app: App) -> None:
    app.fsm.jam_duration_s = float(app.cfg["jam_duration_s"])
    app.fsm.mute_ns = int(app.cfg["mute_ns"])
    app.fsm.lna_gain_db = float(app.cfg["lna_gain_db"])
    app.fsm.retune_time_us = app.cfg.get("retune_time_us")
    app.fsm.scan_corridor = {
        "f_start": float(app.cfg["f_start_hz"]),
        "f_end": float(app.cfg["f_end_hz"]),
        "corridor_id": "operator",
    }


def _take_operator_go(app: App) -> None:
    """Файл кнопки Передать. Пока его нет, обход только пишет частоты."""
    from .cognitive import JAMMING, MONITORING, MULTI_LO, TIMER
    from .test_capture import clear_replay, read_replay

    if getattr(app.fsm, "replay_pattern", None):
        return
    if app.fsm.jams_sent or app.fsm.state in (JAMMING, MULTI_LO, TIMER, MONITORING):
        return
    pending = read_replay()
    record = (pending or {}).get("record") if isinstance(pending, dict) else None
    if not isinstance(record, dict) or not record.get("freqs_mhz"):
        return
    clear_replay()
    app.fsm.arm_replay(record)


def _stream(app: App, until_file: bool) -> None:
    from .test_capture import maybe_save_test

    while not app._stop_live.is_set():
        _take_operator_go(app)
        _emit_rx(app, True)
        if until_file and getattr(app.fsm, "test_file", None):
            break
        if until_file and not getattr(app.fsm, "test_on", False):
            break
        radio = app._radio
        if until_file and radio is not None and not radio.is_alive():
            app.fsm.test_finish_now = True
            maybe_save_test(app.fsm, app.bus.viz)
            if not getattr(app.fsm, "test_note", ""):
                app.fsm.test_note = "радио остановилось"
            break
        time.sleep(0.05)
    if until_file and getattr(app.fsm, "test_on", False):
        app.fsm.test_finish_now = True
        maybe_save_test(app.fsm, app.bus.viz)
    _emit_rx(app, False)


def run_test_headless(args) -> int:
    from .test_capture import TEST_SECONDS, clear_replay

    cfg = _cfg_from_args(args)
    clear_replay()
    app = App(cfg, True)
    _arm_operator(app)
    app.fsm.replay_pattern = None
    app.fsm.test_jams_base = int(app.fsm.jams_sent)
    app.fsm.test_on = True
    app.fsm.test_saved = False
    app.fsm.test_finish_now = False
    app.fsm.test_file = None
    app.fsm.test_note = "тест идёт — включи ELRS рядом"
    app.fsm.test_deadline = time.time() + TEST_SECONDS
    app.fsm.test_log_path = str(app.log_path)
    app._log("тест: слушаю коридор")

    def _stop(signum, frame):
        app.fsm.test_finish_now = True
        app._stop_live.set()

    install_shutdown(_stop)
    app.start_radio()
    _stream(app, until_file=True)
    app.shutdown(0, None)
    return 0 if app.fsm.test_file else 1


def run_live_headless(args) -> int:
    """Коридор F1–F2, lo_sweep по 34 МГц, пока не придёт Стоп."""
    from .test_capture import clear_replay

    cfg = _cfg_from_args(args)
    clear_replay()
    app = App(cfg, True)
    _arm_operator(app)
    app.fsm.replay_pattern = None
    app.fsm.test_on = False
    app.fsm.test_note = "коридор: окна 34 МГц, 4 мс"

    def _stop(signum, frame):
        app._stop_live.set()

    install_shutdown(_stop)
    app.start_radio()
    _stream(app, until_file=False)
    return 0


def run_from_log(args) -> int:
    from .test_capture import read_replay

    cfg = _cfg_from_args(args)
    app = App(cfg, True)
    _arm_operator(app)
    pending = read_replay()
    record = (pending or {}).get("record")
    if not isinstance(record, dict):
        print(json.dumps({
            "kind": "rx", "running": False,
            "note": "нет загруженного лога", "file": None, "db": [],
        }, ensure_ascii=False), flush=True)
        return 2
    app.fsm.arm_replay(record)
    app.fsm.test_note = str((pending or {}).get("note") or "удар по логу")
    install_shutdown(app.shutdown)
    app.start_radio()
    _stream(app, until_file=False)
    app.shutdown(0, None)
    return 0


def run_load(path: str) -> int:
    from .test_capture import apply_capture, clear_replay, write_replay

    app = App(load_config(), True)
    note = apply_capture(app, Path(path))
    save_config(app.cfg)
    record = getattr(app.fsm, "replay_pattern", None)
    if isinstance(record, dict):
        write_replay(record, note, str(path))
    else:
        clear_replay()
    print(json.dumps({"ok": True, "note": note}, ensure_ascii=False), flush=True)
    return 0


def main() -> None:
    acquire_lock()
    p = argparse.ArgumentParser()
    p.add_argument("--headless", action="store_true")
    p.add_argument("--test", action="store_true")
    p.add_argument("--live", action="store_true")
    p.add_argument("--run", action="store_true")
    p.add_argument("--load", default="")
    p.add_argument("--f-start", type=float, dest="f_start")
    p.add_argument("--f-end", type=float, dest="f_end")
    p.add_argument("--jam", type=float)
    p.add_argument("--mute", type=int)
    p.add_argument("--lna", type=float)
    args = p.parse_args()
    if args.load:
        raise SystemExit(run_load(args.load))
    if args.test:
        raise SystemExit(run_test_headless(args))
    if args.live:
        raise SystemExit(run_live_headless(args))
    if args.run:
        raise SystemExit(run_from_log(args))
    app = App(load_config(), args.headless)
    install_shutdown(app.shutdown)
    if args.headless:
        st = app.tick_status(time.time())
        print(json.dumps(st, ensure_ascii=False))
        return
    run_ui(app)


if __name__ == "__main__":
    main()
