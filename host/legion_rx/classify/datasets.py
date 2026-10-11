"""Загрузчики внешних датасетов (шаг 5.1): DroneRFa, DroneRFz, DroneAttackRF.

Датасеты в репозиторий не входят (объём + лицензии): загрузчик работает
с распакованным деревом. Ожидаемый лейаут (адаптируется --layout):

    <root>/<class_name>/**/*.{npy,csv,mat}

Форматы сегментов:
  .npy — complex64/Complex128 I/Q ИЛИ float/int (2, N) I,Q ИЛИ (N*2,) interleaved;
  .csv — колонки I,Q (с заголовком или без);
  .mat — первая complex-переменная (scipy.io).
Сегменты режутся окном классификатора (5 мс) и превращаются в спектрограммы
той же spec_from_iq, что и синтетика — иначе домены не совпадут.
"""
from __future__ import annotations

import os

import numpy as np

from ..synth.dataset import spec_from_iq

SEG_EXT = (".npy", ".csv", ".mat")


class DatasetLayoutError(RuntimeError):
    pass


def _load_segment(path: str) -> np.ndarray:
    ext = os.path.splitext(path)[1].lower()
    if ext == ".npy":
        a = np.load(path, allow_pickle=False)
        return _as_complex(a, path)
    if ext == ".csv":
        try:
            a = np.loadtxt(path, delimiter=",", skiprows=1)
        except ValueError:
            a = np.loadtxt(path, delimiter=",")
        return _as_complex(np.asarray(a), path)
    if ext == ".mat":
        from scipy.io import loadmat

        d = loadmat(path)
        for k, v in d.items():
            if k.startswith("__"):
                continue
            arr = np.asarray(v).squeeze()
            if np.iscomplexobj(arr):
                return arr.astype(np.complex64).ravel()
        raise DatasetLayoutError(f"{path}: complex-переменная не найдена")
    raise DatasetLayoutError(f"{path}: неизвестное расширение {ext}")


def _as_complex(a: np.ndarray, path: str) -> np.ndarray:
    if np.iscomplexobj(a):
        return a.astype(np.complex64).ravel()
    a = np.asarray(a)
    if a.ndim == 2 and a.shape[0] == 2:  # (2, N) I,Q
        return (a[0].astype(np.float32) + 1j * a[1].astype(np.float32)).astype(np.complex64)
    if a.ndim == 1 and a.size % 2 == 0:  # interleaved
        f = a.astype(np.float32)
        return (f[0::2] + 1j * f[1::2]).astype(np.complex64)
    raise DatasetLayoutError(f"{path}: форма {a.shape} не I/Q")


def scan_segments(root: str) -> dict:
    """{class_name: [paths]} — класс = имя каталога первого уровня."""
    out: dict[str, list[str]] = {}
    for dirpath, _dirnames, filenames in os.walk(root):
        for fn in filenames:
            if not fn.lower().endswith(SEG_EXT):
                continue
            rel = os.path.relpath(dirpath, root)
            cls = rel.split(os.sep)[0]
            if cls == ".":
                continue
            out.setdefault(cls, []).append(os.path.join(dirpath, fn))
    return out


def load_dronerf(root: str, fs: float, win_s: float = 0.005,
                 max_per_class: "int | None" = None) -> dict:
    """Дерево сегментов → (X, y, classes, meta) в формате build_synth_dataset.

    fs — частота дискретизации СЕГМЕНТОВ датасета: если она отличается от
    лабораторной 20 МГц, ресемплинг обязателен (scipy.resample_poly по
    рациональному приближению), иначе спектрограммы «поплывут».
    """
    import math

    found = scan_segments(root)
    if not found:
        raise DatasetLayoutError(
            f"{root}: сегментов не найдено — ожидается <root>/<class>/*.{SEG_EXT}")
    xs, ys, metas = [], [], []
    names = sorted(found)
    n_win = int(round(fs * win_s))
    g = math.gcd(int(round(fs)), 20_000_000)
    up, down = 20_000_000 // g, int(round(fs)) // g
    for ci, cls in enumerate(names):
        paths = found[cls][:max_per_class]
        for p in paths:
            iq = _load_segment(p)
            if (up, down) != (1, 1):
                from scipy.signal import resample_poly

                iq = resample_poly(iq, up, down).astype(np.complex64)
            n_lab = int(round(20.0e6 * win_s))
            for off in range(0, len(iq) - n_lab + 1, n_lab):
                xs.append(spec_from_iq(iq[off: off + n_lab]))
                ys.append(ci)
                metas.append({"class": cls, "source": os.path.basename(p)})
    if not xs:
        raise DatasetLayoutError(
            f"{root}: ни одного полного окна {win_s * 1e3:g} мс — сегменты короче окна")
    return {"X": np.stack(xs).astype(np.float32),
            "y": np.asarray(ys, dtype=np.int64),
            "classes": names, "meta": metas}
