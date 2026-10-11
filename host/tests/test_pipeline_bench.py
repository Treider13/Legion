"""Шаг 9: bench-режим пайплайна end-to-end без железа (синтез → PFB →
hop map → запись регистров через legion_fpga.py/FakeTransport)."""
import json
import os
import subprocess
import sys

import pytest

HOST = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


def _run_bench(extra):
    env = dict(os.environ)
    env["PYTHONPATH"] = HOST + os.pathsep + env.get("PYTHONPATH", "")
    return subprocess.run(
        [sys.executable, "-m", "legion_rx.pipeline", "bench"] + extra,
        capture_output=True, text=True, env=env, timeout=600, cwd=HOST)


def test_integrate_rejects_unknown_profile_before_hardware():
    """--profiles валидируются ДО открытия CLI/USB: неизвестное имя —
    понятная ошибка и rc=2 даже без железа."""
    env = dict(os.environ)
    env["PYTHONPATH"] = HOST + os.pathsep + env.get("PYTHONPATH", "")
    cp = subprocess.run(
        [sys.executable, "-m", "legion_rx.pipeline", "integrate",
         "--profiles", "no_such_profile", "--cycles", "1"],
        capture_output=True, text=True, env=env, timeout=60, cwd=HOST)
    assert cp.returncode == 2
    assert "no_such_profile" in cp.stderr
    assert "elrs_24" in cp.stderr  # список доступных в сообщении


def test_bench_elrs24_verdict():
    cp = _run_bench(["--protocol", "elrs_24", "--duration-s", "0.4",
                     "--seed", "7", "--cpu"])
    assert cp.returncode in (0, 2), cp.stderr[-2000:]
    verdict = json.loads(cp.stdout[cp.stdout.index("{"):])
    assert verdict["frames"] > 200
    assert verdict["hop_truth_hz"] == 1000.0
    # темп видимых скачков (часть таблицы вне окна — физика, не баг)
    assert verdict["hop_rate"]["rate_hz"] > 0
    # критерий 9.4 без классификатора вакуумно истинен
    assert verdict["criterion_9_4"] is True
    assert "decision_ms" in verdict


def test_bench_with_torch_classifier(tmp_path):
    """bench + torch-модель: задержка решения+записи измерена реально."""
    pytest.importorskip("torch")
    from legion_rx.classify.model import SpectroCNN
    import torch as th

    labels = ["elrs_24", "noise", "wifi_bt"]
    ckpt = tmp_path / "best.pt"
    th.save({"state_dict": SpectroCNN(3).state_dict(), "classes": labels,
             "spec_shape": (256, 128)}, ckpt)
    lf = tmp_path / "labels.json"
    lf.write_text(json.dumps(labels))
    cp = _run_bench(["--protocol", "elrs_24", "--duration-s", "0.2",
                     "--torch", str(ckpt), "--labels", str(lf), "--cpu"])
    assert cp.returncode in (0, 2), cp.stderr[-2000:]
    verdict = json.loads(cp.stdout[cp.stdout.index("{"):])
    assert verdict["cls_backend"] == "torch"
    lat = verdict["decision_ms"]["p50"]
    assert lat is not None
    # На CPU ноутбука решение+запись обязаны укладываться в десятки мс;
    # жёсткий критерий < 10 мс — на лабораторной RTX (GPU-backend).
    assert lat < 100.0, f"decision p50 {lat} мс — подозрительно медленно"
