"""Шаг 5: модель, датасет-загрузчики, torch-инференс, обучение (smoke)."""
import json
import os
import subprocess
import sys

import numpy as np
import pytest

torch = pytest.importorskip("torch")

from legion_rx.classify.datasets import load_dronerf, scan_segments
from legion_rx.classify.infer import Classifier
from legion_rx.classify.model import SpectroCNN
from legion_rx.synth.dataset import build_synth_dataset, spec_from_iq


def test_model_forward_shape():
    m = SpectroCNN(n_classes=13)
    x = torch.zeros(2, 1, 256, 128)
    assert m(x).shape == (2, 13)


def test_spec_from_iq_shape():
    iq = np.random.standard_normal(100_000).astype(np.complex64)
    s = spec_from_iq(iq)
    assert s.shape == (1, 256, 128)
    assert 0.0 <= s.min() and s.max() <= 1.0


def test_build_synth_dataset_small():
    ds = build_synth_dataset(2, seed=1)
    assert ds["X"].shape[1:] == (1, 256, 128)
    assert len(ds["y"]) == 2 * len(ds["classes"])
    assert set(ds["y"].tolist()) == set(range(len(ds["classes"])))


def test_dronerf_loader_npy(tmp_path):
    """Дерево <root>/<class>/*.npy complex64 → окна 5 мс в спектрограммы."""
    rng = np.random.default_rng(1)
    for cls in ("dji_tello", "noise_rf"):
        d = tmp_path / cls
        d.mkdir(parents=True)
        seg = (rng.standard_normal(250_000) +
               1j * rng.standard_normal(250_000)).astype(np.complex64)
        np.save(d / "seg0.npy", seg)
    found = scan_segments(str(tmp_path))
    assert set(found) == {"dji_tello", "noise_rf"}
    ds = load_dronerf(str(tmp_path), fs=20.0e6)
    assert ds["X"].shape[1:] == (1, 256, 128)
    # 250 000 сэмплов / 100 000-с окно = 2 полных окна на класс
    assert ds["X"].shape[0] == 4
    assert sorted(set(ds["y"].tolist())) == [0, 1]


def test_dronerf_loader_rejects_short_segments(tmp_path):
    from legion_rx.classify.datasets import DatasetLayoutError

    d = tmp_path / "cls"
    d.mkdir()
    np.save(d / "short.npy", np.zeros(1000, dtype=np.complex64))
    with pytest.raises(DatasetLayoutError, match="окна"):
        load_dronerf(str(tmp_path), fs=20.0e6)


def test_classifier_torch_backend(tmp_path):
    labels = ["a", "b", "c"]
    m = SpectroCNN(n_classes=3)
    ckpt = tmp_path / "best.pt"
    torch.save({"state_dict": m.state_dict(), "classes": labels,
                "spec_shape": (256, 128)}, ckpt)
    lf = tmp_path / "labels.json"
    lf.write_text(json.dumps(labels))
    clf = Classifier(backend="torch", torch_path=str(ckpt),
                     labels_path=str(lf))
    assert clf.backend == "torch"
    assert clf.spec_shape == (256, 128)
    res = clf.infer(np.zeros((1, 256, 128), dtype=np.float32))
    assert res["class"] in labels
    assert res["probs"].sum() == pytest.approx(1.0, abs=1e-5)
    assert res["latency_ms"] >= 0.0


def test_train_smoke_one_epoch(tmp_path):
    """train.py end-to-end: 1 эпоха, 2 образца/класс — пайплайн живой,
    report.json/labels.json/best.pt/model.onnx на месте. acc за 1 эпоху
    не требуем (критерий 0.95 — отдельный этап обучения, шаг 5.6)."""
    env = dict(os.environ)
    host = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    env["PYTHONPATH"] = host + os.pathsep + env.get("PYTHONPATH", "")
    cp = subprocess.run(
        [sys.executable, "-m", "legion_rx.classify.train",
         "--synth-per-class", "2", "--epochs", "1", "--batch", "8",
         "--out", str(tmp_path / "run")],
        capture_output=True, text=True, env=env, timeout=900)
    assert cp.returncode in (0, 2), cp.stderr[-2000:]
    out = tmp_path / "run"
    assert (out / "best.pt").is_file()
    assert (out / "model.onnx").is_file()
    rep = json.loads((out / "report.json").read_text())
    assert 0.0 <= rep["val_acc"] <= 1.0
    assert len(rep["classes"]) == 12
    assert rep["ok"] == (rep["val_acc"] > 0.95)
