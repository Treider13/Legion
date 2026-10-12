"""Classifier — единая точка инференса пайплайна (шаги 5, 9).

Backend:
  * "trt"   — TensorRT FP16 (engine + labels.json), целевой для лаборатории;
  * "torch" — PyTorch best.pt (CPU или CUDA) — реальный инференс теми же
              весами до сборки TRT-движка (офлайн-разбор, отладка, CI без
              GPU). Не заглушка: тот же SpectroCNN, тот же вход (1,F,T).
  * "auto"  — engine, если задан и TRT жив; иначе torch.
"""
from __future__ import annotations

import json
import os
import time

import numpy as np


class Classifier:
    def __init__(self, backend: str = "auto",
                 engine_path: "str | None" = None,
                 torch_path: "str | None" = None,
                 labels_path: "str | None" = None):
        self.labels: list = []
        if labels_path:
            with open(labels_path) as f:
                self.labels = json.load(f)
        self.backend = ""
        self._impl = None
        errors = []
        if backend in ("auto", "trt") and engine_path and os.path.isfile(engine_path):
            try:
                from .export_trt import TrtClassifier

                if not self.labels:
                    raise RuntimeError("для TRT нужен labels_path")
                self._impl = TrtClassifier(engine_path, self.labels)
                self.backend = "trt"
            except Exception as e:
                errors.append(f"trt: {e}")
                if backend == "trt":
                        raise
        if self._impl is None and backend in ("auto", "torch") and torch_path:
            self._impl = _TorchImpl(torch_path, self.labels or None)
            self.labels = self._impl.labels
            self.backend = "torch"
        if self._impl is None:
            raise RuntimeError(
                "Classifier: нет рабочего backend "
                f"({'; '.join(errors) or 'нет engine_path/torch_path'})")

    @property
    def spec_shape(self) -> tuple:
        return self._impl.spec_shape

    def warmup(self, n: int = 8) -> None:
        f, t = self.spec_shape
        dummy = np.zeros((1, f, t), dtype=np.float32)
        for _ in range(n):
            self.infer(dummy)

    def infer(self, spec: np.ndarray) -> dict:
        return self._impl.infer(spec)


class _TorchImpl:
    def __init__(self, ckpt_path: str, labels: "list | None"):
        import torch

        from .model import SpectroCNN

        self._torch = torch
        ckpt = torch.load(ckpt_path, map_location="cpu", weights_only=False)
        self.labels = list(labels or ckpt.get("classes") or [])
        if not self.labels:
            raise RuntimeError(f"{ckpt_path}: нет classes и labels_path")
        self.model = SpectroCNN(n_classes=len(self.labels))
        self.model.load_state_dict(ckpt["state_dict"])
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.model.to(self.device).eval()
        f, t = (ckpt.get("spec_shape") or (256, 128))
        self._shape = (int(f), int(t))

    @property
    def spec_shape(self) -> tuple:
        return self._shape

    def warmup(self, n: int = 8) -> None:
        f, t = self._shape
        self.infer(np.zeros((1, f, t), dtype=np.float32))

    def infer(self, spec: np.ndarray) -> dict:
        torch = self._torch
        f, t = self._shape
        x = torch.from_numpy(np.ascontiguousarray(
            spec.reshape(1, 1, f, t).astype(np.float32))).to(self.device)
        t0 = time.perf_counter()
        with torch.no_grad():
            logits = self.model(x)
            p = torch.softmax(logits, dim=1)[0].cpu().numpy()
        dt = (time.perf_counter() - t0) * 1000.0
        k = int(p.argmax())
        return {"class": self.labels[k], "class_idx": k, "conf": float(p[k]),
                "probs": p, "latency_ms": dt}
