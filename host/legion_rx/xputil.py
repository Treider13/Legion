"""Backend numpy/cupy (шаг 4.1). Только CuPy — scikit-cuda запрещён.

Лабораторный режим — GPU (RTX 5050, CUDA ≥ 12.8, CuPy ≥ 13.3): backend()
без GPU падает, если явно не разрешён CPU (тесты/офлайн-разбор).
"""
from __future__ import annotations

_cupy = None
_cupy_err: "BaseException | None" = None
try:
    import cupy as _cp  # type: ignore

    _cupy = _cp
except BaseException as e:  # нет wheel, нет драйвера, нет GPU — фиксируем
    _cupy_err = e


def cupy_available() -> bool:
    if _cupy is None:
        return False
    try:
        _cupy.cuda.runtime.getDeviceCount()
        return True
    except BaseException:
        return False


def cupy_unavailable_reason() -> str:
    if _cupy is None:
        return f"import cupy: {_cupy_err}"
    try:
        _cupy.cuda.runtime.getDeviceCount()
    except BaseException as e:
        return f"CUDA device: {e}"
    return ""


def backend(prefer: str = "gpu"):
    """gpu → cupy (обязателен); cpu → numpy; auto → cupy если жив."""
    if prefer == "cpu":
        import numpy as np

        return np
    if prefer in ("gpu", "auto"):
        if cupy_available():
            return _cupy
        if prefer == "gpu":
            raise RuntimeError(
                "CuPy/CUDA недоступны: " + cupy_unavailable_reason() +
                " (лаборатория: cupy-cuda12x>=13.3, CUDA>=12.8, драйвер Blackwell)")
    import numpy as np

    return np


def to_host(a):
    if _cupy is not None and isinstance(a, _cupy.ndarray):
        return _cupy.asnumpy(a)
    return a


def to_dev(a, xp):
    return xp.asarray(a)
