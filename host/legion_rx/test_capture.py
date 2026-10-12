"""Захват живого ELRS: один JSON, который потом можно загрузить."""
from __future__ import annotations

import json
import threading
import time
from datetime import datetime
from pathlib import Path

import numpy as np

from .cognitive import LOOKTHROUGH_HOPS, MATCH_GO, MIN_CONFIRMS, JAMMING, MULTI_LO
from .corridor import SUB_MARGIN_HZ
from .drift_detector import DRIFT_THRESHOLD
from .lo_sweep import RETUNE_CACHED_S, RETUNE_FULL_S, plan_windows, window_hz
from .lo_window_planner import plan_stations

HERE = Path(__file__).resolve().parent
CAPTURE_DIR = HERE.parent / "tests" / "captures"
TEST_SECONDS = 40
DONE_STATES = (JAMMING, MULTI_LO)
_CLAIM = threading.Lock()


def claim_test(fsm) -> bool:
    with _CLAIM:
        if not getattr(fsm, "test_on", False) or getattr(fsm, "test_saved", False):
            return False
        fsm.test_saved = True
        fsm.test_on = False
        return True


def test_ready(fsm, now: float | None = None) -> bool:
    if not getattr(fsm, "test_on", False):
        return False
    if getattr(fsm, "test_finish_now", False):
        return True
    if (fsm.state in DONE_STATES
            and int(getattr(fsm, "jams_sent", 0)) > int(getattr(fsm, "test_jams_base", 0))):
        return True
    deadline = float(getattr(fsm, "test_deadline", 0) or 0)
    return deadline > 0 and float(now if now is not None else time.time()) >= deadline


def maybe_save_test(fsm, viz=None) -> "str | None":
    if not test_ready(fsm):
        return None
    if not claim_test(fsm):
        return None
    try:
        path = save_capture(build_report(fsm, viz))
    except Exception as exc:
        fsm.test_saved = False
        fsm.test_on = True
        fsm.test_note = f"тест не записан: {exc}"
        return None
    fsm.test_file = str(path)
    fsm.test_note = f"тест записан: {path.name}"
    _append_log(getattr(fsm, "test_log_path", None), fsm.test_note)
    return str(path)


def save_capture(report: dict) -> Path:
    CAPTURE_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    path = CAPTURE_DIR / f"elrs_{stamp}.json"
    path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8")
    return path


def load_capture(path: Path) -> dict:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if data.get("kind") != "elrs-capture":
        raise ValueError("это не файл теста ELRS")
    return data


def apply_capture(app, path: Path) -> str:
    """Кладёт коридор и паттерн из файла. СТАРТ бьёт по логу, не учит заново."""
    data = load_capture(path)
    cfg = data.get("config") or {}
    for key in ("f_start_hz", "f_end_hz", "jam_duration_s", "mute_ns",
                "lna_gain_db", "rx_fs_hz", "freq_shift_hz", "retune_time_us"):
        if key in cfg:
            app.cfg[key] = cfg[key]
            app.pending[key] = cfg[key]
    fields = getattr(app, "fields", None) or {}
    if "f0" in fields:
        fields["f0"].set(str(int(app.cfg["f_start_hz"])))
    if "f1" in fields:
        fields["f1"].set(str(int(app.cfg["f_end_hz"])))
    if "jam" in fields:
        fields["jam"].set(str(app.cfg["jam_duration_s"]))
    if "mute" in fields:
        fields["mute"].set(str(int(app.cfg["mute_ns"])))
    if "lna" in fields:
        fields["lna"].set(str(app.cfg["lna_gain_db"]))
    if "retune" in fields:
        rt = app.cfg.get("retune_time_us")
        fields["retune"].set("нет замера" if rt is None else str(rt))
    app.fsm.jam_duration_s = float(app.cfg["jam_duration_s"])
    app.fsm.mute_ns = int(app.cfg["mute_ns"])
    app.fsm.scan_corridor = {
        "f_start": float(app.cfg["f_start_hz"]),
        "f_end": float(app.cfg["f_end_hz"]),
        "corridor_id": "operator",
    }
    record = data.get("pattern")
    if isinstance(record, dict) and record.get("pattern_id") and record.get("sub"):
        app.fsm.arm_replay(record)
        app.fsm.store.patterns[record["pattern_id"]] = record
        app.fsm.store.save()
        note = (f"загружен {Path(path).name}, паттерн {record['pattern_id']}. "
                "СТАРТ бьёт по этому логу.")
    else:
        app.fsm.replay_pattern = None
        note = (f"загружен {Path(path).name}, паттерна нет. "
                "СТАРТ снова слушает коридор.")
    app.fsm.test_file = str(path)
    app.fsm.test_note = note
    return note


def build_report(fsm, viz=None) -> dict:
    pair = fsm._corridor_hz() if hasattr(fsm, "_corridor_hz") else None
    f0 = float(pair[0]) if pair else None
    f1 = float(pair[1]) if pair else None
    fs = float(getattr(fsm, "fpga_fs_hz", None) or getattr(fsm, "fs_hz", 34e6))
    pat = None
    if getattr(fsm, "pid", None):
        try:
            pat = dict(fsm.store.get(fsm.pid))
        except Exception:
            pat = None
    sub = getattr(fsm, "sub", None)
    hops_hz = []
    if pat and pat.get("freqs_mhz"):
        hops_hz = [float(x) * 1e6 for x in pat["freqs_mhz"]]
    stations = None
    if isinstance(sub, dict) and "f_start" in sub and "f_end" in sub:
        stations = plan_stations(sub["f_start"], sub["f_end"], fs, hops_hz or None)
    windows = []
    if f0 is not None and f1 is not None:
        windows = plan_windows(f0, f1, window_hz(fs))
    snap = {}
    if viz is not None and hasattr(viz, "snapshot"):
        snap = viz.snapshot()
    spec = snap.get("spec") if isinstance(snap, dict) else None
    rec = getattr(fsm, "rec", None)
    raw_hops = list(getattr(rec, "hops", []) or [])[-512:]
    post = {}
    det = getattr(fsm, "det", None)
    if det is not None and hasattr(det, "posterior"):
        try:
            post = det.posterior()
        except Exception:
            post = {}
    usb = getattr(fsm, "usb", None)
    retune = getattr(fsm, "retune_time_us", None)
    notes = []
    if retune is None:
        notes.append(
            "retune на плате не замерен; в файле паспортные 3800 мкс полный "
            "и 500 мкс из кэша")
    if int(getattr(fsm, "mute_ns", 0) or 0) == 0:
        notes.append("mute_ns=0: при смене стоянки передача не глушится")
    if pat is None:
        notes.append("паттерн не подтверждён — рядом не было устойчивых прыжков")
    elif not pat.get("confirmed"):
        notes.append("паттерн записан, три совпадения ещё не закрыты")
    return _plain({
        "kind": "elrs-capture",
        "version": 1,
        "saved_at": datetime.now().isoformat(timespec="seconds"),
        "config": {
            "f_start_hz": f0,
            "f_end_hz": f1,
            "jam_duration_s": float(getattr(fsm, "jam_duration_s", 15.0)),
            "mute_ns": int(getattr(fsm, "mute_ns", 0) or 0),
            "retune_time_us": retune,
            "lna_gain_db": float(getattr(fsm, "lna_gain_db", 20.0) or 20.0),
            "rx_fs_hz": fs,
            "freq_shift_hz": 15000,
        },
        "thresholds": {
            "confirms": MIN_CONFIRMS,
            "similarity": MATCH_GO,
            "drift_lp": DRIFT_THRESHOLD,
            "lookthrough_every_hops": LOOKTHROUGH_HOPS,
            "lookthrough_listen_hops": 1,
            "sub_margin_hz": SUB_MARGIN_HZ,
            "corridor_k_sigma": float(getattr(det, "k", 6.0) or 6.0),
            "retune_full_us_passport": int(RETUNE_FULL_S * 1e6),
            "retune_cached_us_passport": int(RETUNE_CACHED_S * 1e6),
        },
        "state": fsm.state,
        "pattern_id": getattr(fsm, "pid", None),
        "pattern": pat,
        "sub": sub,
        "hops": raw_hops,
        "confirm": {
            "count": None if pat is None else pat.get("confirm_count"),
            "confidence": None if pat is None else pat.get("confidence"),
            "confirmed": None if pat is None else pat.get("confirmed"),
            "p_hopping": post.get("p_hopping"),
            "hop_rate_hz": post.get("hop_rate_hz"),
        },
        "stations": stations,
        "scan_windows": len(windows),
        "drift_scores": list(getattr(getattr(fsm, "drift", None), "_window", []) or []),
        "transitions": list(getattr(fsm, "transitions", []) or [])[-100:],
        "spectrum": {
            "f0_hz": snap.get("f0") if isinstance(snap, dict) else None,
            "f1_hz": snap.get("f1") if isinstance(snap, dict) else None,
            "bins": _down(spec) if spec is not None else [],
        },
        "usb_overruns": int(getattr(usb, "overruns", 0) or 0),
        "notes": notes,
    })


def _append_log(path, line: str) -> None:
    if not path:
        return
    try:
        with open(path, "a", encoding="utf-8") as f:
            f.write(f"{time.strftime('%H:%M:%S')} {line}\n")
    except OSError:
        return


def _down(values, n: int = 256) -> list:
    v = np.asarray(values, dtype=float).ravel()
    if v.size == 0:
        return []
    if v.size > n:
        idx = np.linspace(0, v.size - 1, n).astype(int)
        v = v[idx]
    return [round(float(x), 2) for x in v]


def _plain(value):
    if isinstance(value, dict):
        return {str(k): _plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain(v) for v in value]
    if isinstance(value, np.ndarray):
        return _plain(value.tolist())
    if isinstance(value, np.floating):
        return float(value)
    if isinstance(value, np.integer):
        return int(value)
    if isinstance(value, float):
        return float(value)
    if isinstance(value, int) and not isinstance(value, bool):
        return int(value)
    if value is None or isinstance(value, (str, bool)):
        return value
    return str(value)
