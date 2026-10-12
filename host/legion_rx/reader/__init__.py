"""C-читатель FIFO (шаг 3.8): legion_creader собирается из creader.c."""
from __future__ import annotations

import os


def load_creader():
    """Импорт legion_creader; при отсутствии .so — собрать на месте (gcc)."""
    here = os.path.dirname(os.path.abspath(__file__))
    try:
        import legion_creader  # type: ignore
        return legion_creader
    except ImportError:
        pass
    from . import build

    out = build.build()
    import importlib.util

    spec = importlib.util.spec_from_file_location("legion_creader", out)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


__all__ = ["load_creader", "HERE"]
HERE = os.path.dirname(os.path.abspath(__file__))
