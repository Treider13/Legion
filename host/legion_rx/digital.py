"""Цифровой режим. Третий путь, не умная атака и не обычная.

Оператор задаёт коридоры и профиль подавления. Хост считает окна
(по умолчанию 7 МГц), схлопывает одинаковые частоты, снимает
quick_tune, ставит очередь schedule_retune и шлёт выбранную волну.
В FPGA: регистр 0x65 развязывает retune от hop LUT умной атаки,
mux = PASS. Нового генератора волн в HDL нет.
"""
from __future__ import annotations

import json
import math
import time
from pathlib import Path

import numpy as np

PROFILE_HZ = 7.0e6
MAX_CORRIDOR_HZ = 56.0e6
HW_SLOTS = 8
NIOS_SLOTS = 256
QUEUE_AHEAD = 14
# ADI EZ: PLL lock 15–20 µs. Это не длительность стоянки.
PLL_LOCK_S = 20e-6
HW_SWITCH_S = PLL_LOCK_S
NIOS_SWITCH_S = 100e-6
HOP_DWELL_US_DEFAULT = 100
HOP_DWELL_US_MIN = 20
HOP_DWELL_US_WARN = 30
HOP_DWELL_US_MAX = 10000
FS_HZ = 34.0e6
TX_BW_HZ = PROFILE_HZ
LEAD_S = 0.002
CHUNK = 8192
# libbladeRF sync TX: больше буферов — запас на джиттер хоста, не отдельная железная FIFO.
USB_TX_BUFFERS = 32
USB_TX_XFER = 16
AMP_MIN = 0.1
AMP_MAX = 0.9
# Повторный get_quick_tune. 15 мин — середина окна 10–30 мин. 0 = не обновлять.
REFRESH_S = 900.0
TONE_BW_HZ = 0.5e6
# Модулятор ЧМ. Девиация задана полосой профиля, не этим числом.
FM_MOD_HZ = 100e3
# Запас цикла = dwell / MARGIN. Это правило оператора, не замер эфира.
TUNE_MARGIN = 4
# Половина и четверть закрытой сетки 7 МГц. Аналог AD9361 ставится тем же API.
PROFILE_WIDTHS_HZ = (7.0e6, 3.5e6, 1.75e6)

WALKS = ("sequential", "random", "static")
WAVES = ("saw", "chirp", "noise", "tone", "fm")
JOB_PATH = Path(__file__).resolve().parent / "digital_job.json"

# dwell — период пакета 1/rate. Сетка ELRS 2.4 в дереве: 1 МГц, не 500 кГц.
# Crossfire 868 — из fpga_control.py (150 Гц FSK, 50 Гц LoRa). 915 не выдумывал.
PRESETS = {
    "elrs_500": {
        "dwell_s": 0.002, "profile_hz": 7.0e6,
        "label": "ELRS 500 Гц", "src": "спека: dwell 2 мс",
    },
    "elrs_250": {
        "dwell_s": 0.004, "profile_hz": 7.0e6,
        "label": "ELRS 250 Гц", "src": "спека: dwell 4 мс",
    },
    "elrs_150": {
        "dwell_s": 1.0 / 150.0, "profile_hz": 7.0e6,
        "label": "ELRS 150 Гц", "src": "период 1/150 с",
    },
    "elrs_50": {
        "dwell_s": 0.020, "profile_hz": 3.5e6,
        "label": "ELRS 50 Гц", "src": "период 20 мс; 3.5 МГц — мельче сетка, бюджет позволяет",
    },
    "crossfire_868_150": {
        "dwell_s": 1.0 / 150.0, "profile_hz": 7.0e6,
        "label": "Crossfire 868 150 Гц", "src": "fpga_control proto_period 1/150",
    },
    "crossfire_868_50": {
        "dwell_s": 0.020, "profile_hz": 7.0e6,
        "label": "Crossfire 868 50 Гц", "src": "fpga_control proto_period 1/50",
    },
    "custom": {
        "dwell_s": 0.004, "profile_hz": 7.0e6,
        "label": "Пользовательский", "src": "dwell и ширину задаёт оператор",
    },
}


def clamp_profile_hz(hz: float) -> float:
    w = float(hz)
    if w < 200e3:
        raise ValueError("ширина профиля меньше 0.2 МГц")
    if w > MAX_CORRIDOR_HZ + 1.0:
        raise ValueError("ширина профиля больше 56 МГц")
    return w


def corridor_n(start_hz: float, end_hz: float, profile_hz: float = PROFILE_HZ) -> int:
    span = float(end_hz) - float(start_hz)
    step = clamp_profile_hz(profile_hz)
    if span <= 0:
        raise ValueError("коридор: конец должен быть больше начала")
    if span > MAX_CORRIDOR_HZ + 1.0:
        raise ValueError("коридор шире 56 МГц")
    return int(math.ceil(span / step))


def corridor_freqs(start_hz: float, end_hz: float,
                   profile_hz: float = PROFILE_HZ) -> list[float]:
    step = clamp_profile_hz(profile_hz)
    n = corridor_n(start_hz, end_hz, step)
    return [float(start_hz) + 0.5 * step + i * step for i in range(n)]


def _corridor_edges(raw: dict) -> tuple[float, float, float]:
    start = float(raw["start_hz"] if "start_hz" in raw else float(raw["start_mhz"]) * 1e6)
    end = float(raw["end_hz"] if "end_hz" in raw else float(raw["end_mhz"]) * 1e6)
    pri = float(raw.get("priority") or 1.0)
    if pri <= 0:
        raise ValueError("приоритет должен быть больше нуля")
    return start, end, pri


def _hz_key(hz: float) -> int:
    return int(round(float(hz)))


def collapse_pool(pool: list[dict]) -> list[dict]:
    """Одна частота — одна запись. При равенстве герца остаётся больший приоритет."""
    best: dict[int, dict] = {}
    order: list[int] = []
    for p in pool:
        k = _hz_key(p["hz"])
        if k not in best:
            best[k] = {
                "hz": float(p["hz"]),
                "corridor": int(p["corridor"]),
                "priority": float(p["priority"]),
                "profile_hz": float(p["profile_hz"]),
                "hw": False,
            }
            order.append(k)
        elif float(p["priority"]) > float(best[k]["priority"]):
            best[k]["priority"] = float(p["priority"])
            best[k]["corridor"] = int(p["corridor"])
    out: list[dict] = []
    for i, k in enumerate(order):
        row = best[k]
        row["index"] = i
        out.append(row)
    return out


def pool_n(corridors: list[dict], profile_hz: float = PROFILE_HZ,
           collapse: bool = True) -> int:
    return len(build_pool(corridors, profile_hz, collapse=collapse))


def build_pool(corridors: list[dict], profile_hz: float = PROFILE_HZ,
               collapse: bool = True) -> list[dict]:
    """Общий пул. По умолчанию одинаковые частоты схлопываются. Слоты — по приоритету."""
    if not corridors:
        raise ValueError("нужен хотя бы один коридор")
    step = clamp_profile_hz(profile_hz)
    pool: list[dict] = []
    for i, raw in enumerate(corridors):
        start, end, pri = _corridor_edges(raw)
        freqs = corridor_freqs(start, end, step)
        for hz in freqs:
            pool.append({
                "index": len(pool),
                "hz": hz,
                "corridor": i,
                "priority": pri,
                "hw": False,
                "profile_hz": step,
            })
    if collapse:
        pool = collapse_pool(pool)
    if len(pool) > NIOS_SLOTS:
        raise ValueError(
            f"больше {NIOS_SLOTS} профилей: NIOS слоты 0…{NIOS_SLOTS - 1}, старт отвергнут"
        )
    ranked = sorted(pool, key=lambda p: (-float(p["priority"]), int(p["index"])))
    for i, row in enumerate(ranked):
        row["hw"] = i < HW_SLOTS
    return pool


def hop_dwell_us(raw) -> int:
    """Стоянка на окне, мкс. 20 — наследие CLI; короче 30 — lock-time, игла на SA."""
    us = int(round(float(raw)))
    if us < HOP_DWELL_US_MIN:
        raise ValueError(f"dwell короче {HOP_DWELL_US_MIN} мкс")
    if us > HOP_DWELL_US_MAX:
        raise ValueError(f"dwell длиннее {HOP_DWELL_US_MAX} мкс")
    return us


def hop_samples(hop_us, fs_hz: float = FS_HZ) -> int:
    return max(1, int(round(float(hop_dwell_us(hop_us)) * float(fs_hz) / 1e6)))


def clamp_amp(raw) -> float:
    a = float(raw)
    if a < AMP_MIN - 1e-12:
        raise ValueError(f"амплитуда меньше {AMP_MIN}")
    if a > AMP_MAX + 1e-12:
        raise ValueError(f"амплитуда больше {AMP_MAX}")
    return min(AMP_MAX, max(AMP_MIN, a))


def switch_s(key, hop_us=None) -> float:
    """Длительность стоянки в секундах. key оставлен: слот HW/NIOS больше не режет dwell."""
    del key
    return hop_dwell_us(HOP_DWELL_US_DEFAULT if hop_us is None else hop_us) * 1e-6


def walk_us(n: int, hop_us=None) -> int:
    hop = hop_dwell_us(HOP_DWELL_US_DEFAULT if hop_us is None else hop_us)
    return max(0, int(n)) * hop


def beats_elrs(n: int, hop_us=None) -> dict:
    us = walk_us(n, hop_us)
    return {
        "n": n,
        "walk_us": us,
        "elrs_250": us <= 4000,
        "elrs_500": us <= 2000,
    }


def _tune_one(corridors: list[dict], profile_hz: float, dwell_s: float,
              collapse: bool = True, hop_us=None) -> dict:
    step = clamp_profile_hz(profile_hz)
    hop = hop_dwell_us(HOP_DWELL_US_DEFAULT if hop_us is None else hop_us)
    n = pool_n(corridors, step, collapse=collapse)
    us = walk_us(n, hop)
    dwell_us = max(1, int(round(float(dwell_s) * 1e6)))
    budget_us = max(1, dwell_us // TUNE_MARGIN)
    circles = (dwell_us // us) if us else 0
    return {
        "profile_hz": step,
        "n": n,
        "walk_us": us,
        "hop_us": hop,
        "dwell_us": dwell_us,
        "budget_us": budget_us,
        "fits": circles >= 2,
        "circles": circles,
    }


def auto_tune(corridors: list[dict], dwell_s: float,
              profile_hz: float | None = None,
              collapse: bool = True, hop_us=None) -> dict:
    """Считает N и цикл. Круги = dwell/walk — арифметика, не эфир.

    Уже сетка не ускоряет цикл: меньше шаг → больше N → дольше обход.
    7 МГц — закрытая ширина. 3.5/1.75 только если оператор так задал
    или пресет медленный и бюджет позволяет мельче сетку.
    """
    chosen = clamp_profile_hz(profile_hz if profile_hz is not None else PROFILE_HZ)
    main = _tune_one(corridors, chosen, dwell_s, collapse=collapse, hop_us=hop_us)
    alts = [_tune_one(corridors, w, dwell_s, collapse=collapse, hop_us=hop_us)
            for w in PROFILE_WIDTHS_HZ]
    main["alts"] = alts
    return main


def apply_preset(preset: str, corridors: list[dict],
                 profile_hz: float | None = None,
                 dwell_s: float | None = None,
                 collapse: bool = True, hop_us=None) -> dict:
    if preset not in PRESETS:
        raise ValueError(f"профиль подавления {preset}")
    spec = PRESETS[preset]
    dwell = float(dwell_s) if dwell_s is not None else float(spec["dwell_s"])
    width = float(profile_hz) if profile_hz is not None else float(spec["profile_hz"])
    tune = auto_tune(corridors, dwell, width, collapse=collapse, hop_us=hop_us)
    tune["preset"] = preset
    tune["label"] = spec["label"]
    tune["src"] = spec["src"]
    return tune


def digital_status_note(tune: dict, walk: str, wave: str, amp: float) -> str:
    return (
        f"цифровой: {tune['label']}, {tune['n']} окон по {tune['profile_hz'] / 1e6:g} МГц, "
        f"обход {walk}, волна {wave}, dwell {int(tune['hop_us'])} мкс, "
        f"круг {tune['walk_us']} мкс, амплитуда {amp:g}, "
        f"проходов за dwell {tune['circles']}"
    )


def next_index(walk: str, pool: list[dict], step: int, rng: np.random.Generator,
               static_k: int = 0) -> int:
    if not pool:
        raise ValueError("пул пуст")
    if walk not in WALKS:
        raise ValueError(f"режим обхода {walk}")
    if walk == "sequential":
        return int(step % len(pool))
    group = [p for p in pool if int(p["corridor"]) == int(static_k)]
    if walk == "static":
        if not group:
            raise ValueError("статичный: в выбранном коридоре нет профилей")
        return int(group[int(step % len(group))]["index"])
    ids = sorted({int(p["corridor"]) for p in pool})
    pri: dict[int, float] = {}
    for p in pool:
        pri.setdefault(int(p["corridor"]), float(p["priority"]))
    w = np.asarray([pri[i] for i in ids], dtype=np.float64)
    w = w / w.sum()
    corridor = int(ids[int(rng.choice(len(ids), p=w))])
    inside = [p for p in pool if int(p["corridor"]) == corridor]
    return int(inside[int(rng.integers(0, len(inside)))]["index"])


def schedule_order(walk: str, pool: list[dict], n: int, seed: int = 1,
                   static_k: int = 0) -> list[int]:
    rng = np.random.default_rng(int(seed))
    return [next_index(walk, pool, i, rng, static_k) for i in range(int(n))]


def make_wave(kind: str, n: int, fs_hz: float, amp: float = AMP_MAX,
              chirp_dir: str = "up", saw_period_s: float = 10e-6,
              phase: float = 0.0, span_hz: float = PROFILE_HZ) -> np.ndarray:
    if kind not in WAVES:
        raise ValueError(f"тип сигнала {kind}")
    a = clamp_amp(amp)
    t = np.arange(int(n), dtype=np.float64) / float(fs_hz)
    span = clamp_profile_hz(span_hz)
    if kind == "tone":
        return (a * np.exp(1j * phase) * np.ones(int(n))).astype(np.complex64)
    if kind == "noise":
        rng = np.random.default_rng(int(abs(phase * 1e6)) + 1)
        x = (rng.standard_normal(int(n)) + 1j * rng.standard_normal(int(n))) / np.sqrt(2.0)
        x *= a / 2.0
        mag = np.abs(x)
        over = mag > a
        x[over] *= a / mag[over]
        return x.astype(np.complex64)
    if kind == "saw":
        period = max(1e-7, float(saw_period_s))
        frac = np.mod(t, period) / period
        inst = -span / 2.0 + span * frac
        ph = float(phase) + 2.0 * np.pi * np.cumsum(inst) / float(fs_hz)
        return (a * np.exp(1j * ph)).astype(np.complex64)
    sign = -1.0 if chirp_dir == "down" else 1.0
    f0 = -sign * span / 2.0
    k = sign * span / (n / float(fs_hz))
    if kind == "chirp":
        return (a * np.exp(1j * (2.0 * np.pi * (f0 * t + 0.5 * k * t * t) + phase))).astype(np.complex64)
    delta = span / 2.0
    inst = delta * np.sin(2.0 * np.pi * FM_MOD_HZ * t)
    ph = float(phase) + 2.0 * np.pi * np.cumsum(inst) / float(fs_hz)
    return (a * np.exp(1j * ph)).astype(np.complex64)


def to_sc16(iq: np.ndarray) -> bytes:
    x = np.asarray(iq, dtype=np.complex64)
    scale = 2047.0
    i = np.clip(np.round(x.real * scale), -2047, 2047).astype(np.int16)
    q = np.clip(np.round(x.imag * scale), -2047, 2047).astype(np.int16)
    out = np.empty(i.size * 2, dtype=np.int16)
    out[0::2] = i
    out[1::2] = q
    return out.tobytes()


def load_job(path: "Path | None" = None) -> dict:
    p = Path(path) if path is not None else JOB_PATH
    if not p.is_file():
        return {}
    return json.loads(p.read_text(encoding="utf-8"))


def _band_corridor(start_hz: float, end_hz: float) -> list[dict]:
    start = float(start_hz)
    end = float(end_hz)
    if end <= start:
        end = start + MAX_CORRIDOR_HZ
    if end - start > MAX_CORRIDOR_HZ:
        end = start + MAX_CORRIDOR_HZ
    return [{"start_hz": start, "end_hz": end, "priority": 1.0}]


def job_from_args(args) -> dict:
    """CLI бьёт файл. Файл читается только при --digital-job (кино пишет путь).

    Иначе leftover digital_job.json глушил --digital-wave и --f-start/--f-end.
    """
    job_path = getattr(args, "digital_job", None)
    job = load_job(Path(job_path)) if job_path else {}

    f_start = getattr(args, "f_start", None)
    f_end = getattr(args, "f_end", None)
    if job_path and job.get("corridors"):
        pass
    elif f_start is not None or f_end is not None:
        start = float(f_start if f_start is not None else 2.4e9)
        end = float(f_end if f_end is not None else (start + MAX_CORRIDOR_HZ))
        job["corridors"] = _band_corridor(start, end)
    elif not job.get("corridors"):
        job["corridors"] = _band_corridor(2.4e9, 2.4e9 + MAX_CORRIDOR_HZ)

    wave = getattr(args, "digital_wave", None)
    if wave:
        job["wave"] = str(wave)
    else:
        job.setdefault("wave", "chirp")
    walk = getattr(args, "digital_walk", None)
    if walk:
        job["walk"] = str(walk)
    else:
        job.setdefault("walk", "sequential")
    static = getattr(args, "digital_static", None)
    if static is not None:
        job["static_index"] = int(static)
    else:
        job.setdefault("static_index", 0)
    chirp = getattr(args, "digital_chirp", None)
    if chirp:
        job["chirp_dir"] = str(chirp)
    else:
        job.setdefault("chirp_dir", "up")
    saw_us = getattr(args, "digital_saw_us", None)
    if saw_us is not None:
        job["saw_period_s"] = float(saw_us) * 1e-6
    else:
        job.setdefault("saw_period_s", 10e-6)
    amp = getattr(args, "digital_amp", None)
    if amp is None:
        amp = getattr(args, "digital_amplitude", None)
    if amp is not None:
        job["amp"] = clamp_amp(amp)
    elif "amp" in job:
        job["amp"] = clamp_amp(job["amp"])
    else:
        job["amp"] = AMP_MAX
    tone_mhz = getattr(args, "digital_tone_mhz", None)
    if tone_mhz is not None:
        job["tone_width_hz"] = float(tone_mhz) * 1e6
    else:
        job.setdefault("tone_width_hz", TONE_BW_HZ)
    job.setdefault("seed", 1)
    preset = str(getattr(args, "digital_preset", None) or job.get("preset") or "elrs_250")
    if preset not in PRESETS:
        preset = "elrs_250"
    job["preset"] = preset
    spec = PRESETS[preset]
    if getattr(args, "digital_dwell_ms", None):
        job["dwell_s"] = float(args.digital_dwell_ms) * 1e-3
    else:
        job.setdefault("dwell_s", float(spec["dwell_s"]))
    if getattr(args, "digital_profile_mhz", None):
        job["profile_hz"] = float(args.digital_profile_mhz) * 1e6
    else:
        job.setdefault("profile_hz", float(spec["profile_hz"]))
    if getattr(args, "digital_refresh_s", None) is not None:
        job["refresh_s"] = float(args.digital_refresh_s)
    else:
        job.setdefault("refresh_s", REFRESH_S)
    if getattr(args, "digital_collapse", None) is not None:
        job["collapse"] = bool(args.digital_collapse)
    else:
        job.setdefault("collapse", True)
    hop_cli = getattr(args, "digital_dwell_us", None)
    if hop_cli is not None:
        job["hop_dwell_us"] = hop_dwell_us(hop_cli)
    elif "hop_dwell_us" in job:
        job["hop_dwell_us"] = hop_dwell_us(job["hop_dwell_us"])
    else:
        job["hop_dwell_us"] = HOP_DWELL_US_DEFAULT
    return job


def _fpga_digital(on: bool) -> None:
    """Защёлка 0x65, mux PASS. USB потом отдаём стриму. Нет платы — тишина."""
    try:
        from .fpga_control import FpgaBridge
        import legion_fpga as lf
    except Exception:
        return
    try:
        with FpgaBridge() as br:
            if br.fpga is None:
                return
            if on:
                br.fpga.write_reg(lf.REG_SCAN_CTRL, 0)
                br.fpga.write_reg(lf.REG_GRID_FLAGS, 0)
                br.fpga.write_reg(lf.REG_DIGITAL, 1)
                br.fpga.arm(lf.MODE_PASS, False)
            else:
                br.fpga.write_reg(lf.REG_DIGITAL, 0)
                br.fpga.disarm()
    except Exception:
        return


def emit(note: str, running: bool, extra: dict | None = None) -> None:
    line = {"kind": "rx", "running": running, "note": note, "digital": True}
    if extra:
        line.update(extra)
    print(json.dumps(line, ensure_ascii=False), flush=True)


def run_live(job: dict, stop_event, note=None) -> int:
    """Снимает профили, ставит очередь, шлёт волну. Эфир здесь не утверждается."""
    def _note(line: str) -> None:
        if note:
            note(line)
        emit(line, True)

    preset = str(job.get("preset") or "elrs_250")
    collapse = bool(True if job.get("collapse") is None else job.get("collapse"))
    hop_us = hop_dwell_us(job.get("hop_dwell_us", HOP_DWELL_US_DEFAULT))
    tune = apply_preset(
        preset, job["corridors"],
        job.get("profile_hz"), job.get("dwell_s"),
        collapse=collapse, hop_us=hop_us,
    )
    profile_hz = float(tune["profile_hz"])
    pool = build_pool(job["corridors"], profile_hz, collapse=collapse)
    walk = str(job.get("walk") or "sequential")
    wave = str(job.get("wave") or "chirp")
    if walk not in WALKS:
        raise ValueError(f"режим обхода {walk}")
    if wave not in WAVES:
        raise ValueError(f"тип сигнала {wave}")
    static_k = int(job.get("static_index") or 0)
    chirp_dir = str(job.get("chirp_dir") or "up")
    saw_s = float(job.get("saw_period_s") or 10e-6)
    amp = clamp_amp(job.get("amp", AMP_MAX))
    seed = int(job.get("seed") or 1)
    tone_bw = float(job.get("tone_width_hz") or TONE_BW_HZ)
    tone_bw = min(profile_hz, max(200e3, tone_bw))
    tx_bw = int(tone_bw) if wave == "tone" else int(profile_hz)
    refresh_s = float(job.get("refresh_s") if job.get("refresh_s") is not None else REFRESH_S)
    _note(digital_status_note(tune, walk, wave, amp))
    if hop_us < HOP_DWELL_US_WARN:
        _note(f"предупреждение: dwell {hop_us} мкс короче {HOP_DWELL_US_WARN} мкс — lock-time PLL")
    if tune["circles"] < 2:
        _note("предупреждение: проходов за dwell меньше 2")
    if collapse:
        _note("цифровой: перекрытие схлопнуто")
    if refresh_s > 0:
        _note(f"цифровой: обновление профилей {refresh_s:.0f} с")
    else:
        _note("цифровой: без обновления профилей")

    from .libbladerf_owner import (
        BLADERF_ERR_TIME_PAST, BLADERF_RETUNE_NOW, CH_TX, UsbOwner,
    )

    _fpga_digital(True)
    usb = UsbOwner()
    try:
        rc = usb.acquire()
        if rc:
            raise RuntimeError(f"плата не открылась {rc}")
        first = int(round(pool[0]["hz"]))
        rc = usb.configure(first, int(FS_HZ), int(tx_bw), tx_only=True)
        if rc:
            raise RuntimeError(f"настройка {rc}")
        rc = usb.set_bandwidth(CH_TX, int(tx_bw))
        if rc:
            raise RuntimeError(f"полоса TX {rc}")
        captured = 0
        for p in pool:
            if stop_event.is_set():
                _note("цифровой: стоп во время снимков")
                return 0
            rc = usb.capture_one(int(p["index"]), int(round(p["hz"])))
            if rc:
                _note(
                    f"снимок профиля {p['index']} не вышел {rc}: "
                    "этот шаг ~6 мс, обгон ELRS для него не считается"
                )
                continue
            captured += 1
        if stop_event.is_set():
            _note("цифровой: стоп до потока TX")
            return 0
        _note(f"снято профилей {captured} из {len(pool)}")
        rc = usb.arm_tx_meta_stream()
        if rc:
            raise RuntimeError(f"поток TX {rc}")
        loaded = 0
        for p in pool:
            if stop_event.is_set():
                _note("цифровой: стоп во время загрузки слотов")
                return 0
            if not p["hw"] or int(p["index"]) not in usb.digital_tunes:
                continue
            rc = usb.schedule_one(int(p["index"]), int(round(p["hz"])),
                                  BLADERF_RETUNE_NOW)
            if rc == 0:
                loaded += 1
        if stop_event.is_set():
            _note("цифровой: стоп до TX")
            return 0
        _note(f"в слоты AD9361 загружено {loaded}")
        rc = usb.enable_tx(True)
        if rc:
            raise RuntimeError(f"TX {rc}")
        rng = np.random.default_rng(seed)
        step = 0
        queued: list[tuple[int, int]] = []
        ts_rc, now = usb.get_timestamp(1)
        if ts_rc:
            raise RuntimeError(f"метка {ts_rc}")
        t = int(now) + int(LEAD_S * FS_HZ)
        step_samp = hop_samples(hop_us)

        def _push() -> None:
            nonlocal step, t
            ts_rc, now = usb.get_timestamp(1)
            if ts_rc == 0 and t <= int(now):
                t = int(now) + int(LEAD_S * FS_HZ)
                _note("ошибка: метка в прошлом, сдвиг вперёд")
            idx = next_index(walk, pool, step, rng, static_k)
            hz = int(round(pool[idx]["hz"]))
            rc = usb.schedule_one(idx, hz, t)
            if rc == BLADERF_ERR_TIME_PAST:
                ts_rc, now = usb.get_timestamp(1)
                if ts_rc == 0:
                    t = int(now) + int(LEAD_S * FS_HZ)
                rc = usb.schedule_one(idx, hz, t)
            if rc:
                _note(f"очередь {rc}")
                return
            queued.append((t, idx))
            t += step_samp
            step += 1

        while len(queued) < min(QUEUE_AHEAD, max(1, len(pool))) and not stop_event.is_set():
            before = len(queued)
            _push()
            if len(queued) == before:
                break

        phase0 = float(rng.uniform(0.0, 2.0 * np.pi)) if wave == "fm" else 0.0
        buf = to_sc16(make_wave(wave, CHUNK, FS_HZ, amp, chirp_dir, saw_s, phase0,
                                span_hz=profile_hz))
        hop_phase = phase0
        last_idx = queued[0][1] if queued else 0
        burst = False
        empty_n = 0
        usb_fail = 0
        last_beat = time.monotonic()
        last_refresh = time.monotonic()

        def _reload_profiles() -> None:
            nonlocal queued, t, burst
            usb.enable_tx(False)
            try:
                usb.cancel_one()
            except Exception:
                pass
            usb.digital_tunes.clear()
            got = 0
            for p in pool:
                if stop_event.is_set():
                    _note("цифровой: стоп во время обновления профилей")
                    return
                rc = usb.capture_one(int(p["index"]), int(round(p["hz"])))
                if rc:
                    _note(f"обновление профиля {p['index']} не вышло {rc}")
                    continue
                got += 1
            loaded = 0
            for p in pool:
                if stop_event.is_set():
                    _note("цифровой: стоп во время обновления слотов")
                    return
                if not p["hw"] or int(p["index"]) not in usb.digital_tunes:
                    continue
                if usb.schedule_one(int(p["index"]), int(round(p["hz"])),
                                    BLADERF_RETUNE_NOW) == 0:
                    loaded += 1
            if stop_event.is_set():
                return
            usb.enable_tx(True)
            queued = []
            ts_rc, now = usb.get_timestamp(1)
            if ts_rc == 0:
                t = int(now) + int(LEAD_S * FS_HZ)
            burst = False
            _note(f"цифровой: профили обновлены {got} из {len(pool)}, слотов {loaded}")

        while not stop_event.is_set():
            if refresh_s > 0 and time.monotonic() - last_refresh >= refresh_s:
                _note("цифровой: обновление fastlocks по таймеру")
                _reload_profiles()
                last_refresh = time.monotonic()
            ts_rc, now = usb.get_timestamp(1)
            if ts_rc == 0:
                while queued and queued[0][0] + step_samp < int(now):
                    queued.pop(0)
            while len(queued) < QUEUE_AHEAD and not stop_event.is_set():
                before = len(queued)
                _push()
                if len(queued) == before:
                    time.sleep(0.0002)
                    break
            if not queued:
                empty_n += 1
                if empty_n == 1 or empty_n % 50 == 0:
                    _note(f"ошибка: очередь пуста ({empty_n}), цикл рвётся")
            if wave == "fm" and queued and queued[0][1] != last_idx:
                hop_phase = float(rng.uniform(0.0, 2.0 * np.pi))
                buf = to_sc16(make_wave(
                    wave, CHUNK, FS_HZ, amp, chirp_dir, saw_s, hop_phase,
                    span_hz=profile_hz,
                ))
                last_idx = queued[0][1]
            wrc = usb.write_sc16_tx(buf, timeout_ms=1000, start=not burst)
            burst = burst or wrc == 0
            if wrc:
                usb_fail += 1
                _note(f"TX {wrc} поток не ушёл ({usb_fail}), TX выкл")
                try:
                    usb.cancel_one()
                except Exception:
                    pass
                usb.enable_tx(False)
                break
            if time.monotonic() - last_beat >= 2.0:
                last_beat = time.monotonic()
                _note(f"цифровой: шаг {step}, очередь {len(queued)}, TX жив")
        if burst:
            usb.write_sc16_tx(buf, timeout_ms=200, end=True)
        try:
            usb.cancel_one()
        except Exception:
            pass
        usb.enable_tx(False)
        _note(
            "цифровой: стоп, очередь снята, TX выкл, защёлка 0x65 снята"
            + (f", пустых очередей {empty_n}" if empty_n else "")
            + (f", срывов USB {usb_fail}" if usb_fail else "")
        )
        return 0
    finally:
        if usb.open:
            try:
                usb.cancel_one()
            except Exception:
                pass
            try:
                usb.enable_tx(False)
            except Exception:
                pass
            usb.release()
        _fpga_digital(False)
