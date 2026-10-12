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
        self.fsm = CognitiveFSM(
            PatternStore(), n_chans=256, fs_hz=34.0e6,
            lo_hz=float(cfg["f_start_hz"]))
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
            self._log(f"радио: {exc}")

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


def main() -> None:
    acquire_lock()
    p = argparse.ArgumentParser()
    p.add_argument("--headless", action="store_true")
    args = p.parse_args()
    app = App(load_config(), args.headless)
    install_shutdown(app.shutdown)
    if args.headless:
        st = app.tick_status(time.time())
        print(json.dumps(st, ensure_ascii=False))
        return
    run_ui(app)


if __name__ == "__main__":
    main()
