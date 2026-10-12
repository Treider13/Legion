"""Замок процесса, сигналы, схема config, сверка md5 RBF, фильтр лога."""
from __future__ import annotations

import fcntl
import hashlib
import os
import signal
from pathlib import Path

LOCK_PATH = "/tmp/legion.lock"
RBF_MD5 = "4db61f199a08b8e6f3ed1e67caed5ed5"
_SECRET = ("password", "passwd", "token", "secret", "authorization", "api_key")

_lock_fd: "int | None" = None


def acquire_lock(path: str = LOCK_PATH) -> None:
    """Один процесс. flock снимается, когда процесс умирает."""
    global _lock_fd
    fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o644)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(fd)
        raise SystemExit(f"legion уже запущен: {path}")
    os.ftruncate(fd, 0)
    os.write(fd, f"{os.getpid()}\n".encode())
    _lock_fd = fd


def rbf_warning(root: Path) -> str:
    """Пустая строка — md5 совпал. Иначе текст предупреждения."""
    path = (root / "fpga/vendor/bladerf/hdl/quartus"
            / "timing_close_2026-10-12/hop-lt-68mhz-frozen/legionxA4.rbf")
    if not path.is_file():
        return f"RBF v1.3 не найден: {path}"
    digest = hashlib.md5(path.read_bytes()).hexdigest()
    if digest != RBF_MD5:
        return f"RBF md5 {digest} не равен frozen {RBF_MD5}"
    return ""


def sanitize(rec: dict) -> dict:
    out = {}
    for key, val in rec.items():
        if any(s in str(key).lower() for s in _SECRET):
            out[key] = "***"
        elif isinstance(val, dict):
            out[key] = sanitize(val)
        else:
            out[key] = val
    return out


def install_shutdown(handler) -> None:
    signal.signal(signal.SIGINT, handler)
    signal.signal(signal.SIGTERM, handler)


CONFIG_TYPES = {
    "f_start_hz": (int, float),
    "f_end_hz": (int, float),
    "jam_duration_s": (int, float),
    "mute_ns": (int, float),
    "lna_gain_db": (int, float),
    "rx_fs_hz": (int, float),
    "freq_shift_hz": (int, float),
}


def validate_config(cfg: dict) -> dict:
    for key, types in CONFIG_TYPES.items():
        if key not in cfg or not isinstance(cfg[key], types):
            raise ValueError(f"config: поле {key}")
    if cfg.get("retune_time_us") is not None and not isinstance(
            cfg["retune_time_us"], (int, float)):
        raise ValueError("config: retune_time_us")
    if float(cfg["f_end_hz"]) <= float(cfg["f_start_hz"]):
        raise ValueError("config: f_end_hz не больше f_start_hz")
    if int(cfg["mute_ns"]) < 0:
        raise ValueError("config: mute_ns")
    cfg["rx_fs_hz"] = 34.0e6
    return cfg
