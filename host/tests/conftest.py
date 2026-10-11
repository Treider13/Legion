"""conftest для host/tests: пути host/ и fpga/host, сборка C-читателя."""
import os
import sys

import pytest

_REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
_HOST = os.path.join(_REPO, "host")
_FPGA_HOST = os.path.join(_REPO, "fpga", "host")
for p in (_HOST, _FPGA_HOST, _REPO):
    if p not in sys.path:
        sys.path.insert(0, p)


@pytest.fixture(scope="session")
def creader():
    """Собранный legion_creader (gcc на машине обязателен для шага 3.8)."""
    from legion_rx.reader import load_creader

    return load_creader()
