"""Окно и автомат в одном процессе. USB на ударе держит libbladeRF.

--headless печатает состояние без окна.
Параметры из config.json рядом с этим файлом. Запись при каждом изменении.
Новые длительность и коридор читает следующий цикл, не текущий удар.
"""
from __future__ import annotations

import argparse
import json
import time
from datetime import datetime
from pathlib import Path

from .cognitive import CognitiveFSM, LISTENING
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
    cfg["rx_fs_hz"] = 34.0e6
    return cfg


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
        stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        self.log_path = HERE / f"log_{stamp}.txt"
        self._log("старт")

    def _log(self, line: str) -> None:
        with self.log_path.open("a", encoding="utf-8") as f:
            f.write(f"{time.strftime('%H:%M:%S')} {line}\n")

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
            self._log("start")
        elif cmd == "stop":
            self.fsm._stop_jam(t_s, "stop")
            self._log("stop")
        elif cmd == "pause":
            self.fsm.pause(t_s)
            self._log("pause")
        elif cmd == "save":
            save_config(self.cfg)
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


def run_ui(app: App) -> None:
    import tkinter as tk

    root = tk.Tk()
    root.title("Legion")
    frm = tk.Frame(root, padx=8, pady=8)
    frm.pack(fill="both", expand=True)

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
        tk.Label(frm, text=label).grid(row=r, column=0, sticky="w")
        e = tk.Entry(frm, textvariable=var, width=18)
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

    tk.Button(frm, text="СТАРТ", command=push).grid(row=7, column=0, sticky="w")
    tk.Button(frm, text="СТОП",
              command=lambda: app.bus.submit("stop")).grid(row=7, column=1, sticky="w")
    tk.Button(frm, text="ПАУЗА",
              command=lambda: app.bus.submit("pause")).grid(row=8, column=0, sticky="w")
    tk.Button(frm, text="СОХРАНИТЬ",
              command=lambda: app.bus.submit("save")).grid(row=8, column=1, sticky="w")
    tk.Button(frm, text="СБРОС",
              command=lambda: app.bus.submit("reset")).grid(row=9, column=0, sticky="w")

    def open_log():
        import subprocess
        subprocess.Popen(["xdg-open", str(app.log_path)])

    tk.Button(frm, text="ЖУРНАЛ", command=open_log).grid(row=9, column=1, sticky="w")
    tk.Label(frm, textvariable=status, justify="left").grid(
        row=10, column=0, columnspan=2, sticky="w")

    parent = tk.Canvas(frm, width=420, height=80, bg="#111")
    parent.grid(row=11, column=0, columnspan=2, pady=6)
    sub = tk.Canvas(frm, width=420, height=40, bg="#222")
    sub.grid(row=12, column=0, columnspan=2)

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
        status.set(
            f"{st['state']}  осталось {st['jam_remaining_s']:.1f} с  "
            f"pattern {st['pattern_id']}  цикл {st['cycle_length']}  "
            f"ударов {st['jams_count']}  окно {st['current_lo_window']}  "
            f"сдвиг {st['freq_shift_hz']} Гц  threat {st['threat']}")
        parent.delete("all")
        sub.delete("all")
        parent.create_rectangle(20, 20, 400, 60, outline="#6cf")
        parent.create_text(30, 10, anchor="w", fill="#6cf", text="коридор")
        sub.create_rectangle(80, 8, 260, 32, outline="#fc6")
        sub.create_text(90, 4, anchor="w", fill="#fc6", text="пятно")
        sub.create_line(170, 4, 170, 36, fill="#f44")
        root.after(200, paint)

    paint()
    root.mainloop()


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--headless", action="store_true")
    args = p.parse_args()
    app = App(load_config(), args.headless)
    if args.headless:
        st = app.tick_status(time.time())
        print(json.dumps(st, ensure_ascii=False))
        return
    run_ui(app)


if __name__ == "__main__":
    main()
