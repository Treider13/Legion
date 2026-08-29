"""pytest-обёртка над скриптовыми хостовыми наборами LEGION.

Сами наборы — со своими раннерами (check()/main, не pytest-стиль); здесь
они гоняются как subprocess, чтобы единый `python3 -m pytest` отдавал их
результат стандартно (CI, отчёты о покрытии). HDL/NIOS-наборы сюда не
входят: им нужны ghdl/gcc-обвязка — они остаются шагами CI (ci.yml).
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def _run(script: str) -> None:
    cp = subprocess.run(
        [sys.executable, str(ROOT / script)],
        capture_output=True,
        text=True,
        timeout=300,
    )
    tail = "\n".join((cp.stdout + cp.stderr).splitlines()[-15:])
    assert cp.returncode == 0, f"{script}: exit {cp.returncode}\n{tail}"


def test_sdr_worker_suite() -> None:
    _run("tools/test_sdr_worker.py")


def test_legion_fpga_suite() -> None:
    _run("fpga/test/test_legion_fpga.py")
