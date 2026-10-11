#!/usr/bin/env python3
"""Сборка legion_creader (C-читатель FIFO, шаг 3.8).

    python3 -m legion_rx.reader.build

gcc -shared -fPIC против python3-заголовков текущего интерпретатора.
Без setuptools-скаффолда: один .c → один .so рядом с __init__.py.
"""
from __future__ import annotations

import os
import subprocess
import sys
import sysconfig

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "creader.c")
EXT_SUFFIX = sysconfig.get_config_var("EXT_SUFFIX") or ".so"
OUT = os.path.join(HERE, "legion_creader" + EXT_SUFFIX)


def build() -> str:
    cc = os.environ.get("CC", "gcc")
    cflags = (sysconfig.get_config_var("CFLAGS") or "").split()
    cmd = [
        cc, "-O2", "-shared", "-fPIC", "-Wall", "-Wextra",
        "-I" + sysconfig.get_paths()["include"],
        "-I" + sysconfig.get_paths().get("platinclude", sysconfig.get_paths()["include"]),
        SRC, "-o", OUT,
    ]
    # CFLAGS несут флаги для полной линковки python — для .so читателя
    # достаточно -shared -fPIC; LDFLAGS не тянем: undefined Python-символы
    # резолвятся при импорте в интерпретатор (linux-конвенция python-ext).
    del cflags
    cp = subprocess.run(cmd, capture_output=True, text=True)
    if cp.returncode != 0:
        raise RuntimeError(f"сборка legion_creader не удалась:\n{cp.stderr}")
    return OUT


if __name__ == "__main__":
    out = build()
    sys.path.insert(0, HERE)
    import importlib.util

    spec = importlib.util.spec_from_file_location("legion_creader", out)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    assert mod.mono_ns() > 0
    print(f"OK: {out}")
