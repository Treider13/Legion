#!/usr/bin/env python3
"""ONNX → TensorRT FP16 (шаг 5.4): сборка движка и класс инференса.

Требования лаборатории: TensorRT >= 10.8 (Blackwell + FP16), CUDA >= 12.8,
PyTorch (CUDA-контекст и буферы ввода/вывода — стандартная связка
TRT-python + torch, без pycuda).

    python3 -m legion_rx.classify.export_trt model.onnx model.engine

Замер инференса (warmup + p50/p95) печатается сборкой --bench.
"""
from __future__ import annotations

import argparse
import time

import numpy as np

TRT_LOG_SEVERITY = "kWARNING"


def _import_trt():
    try:
        import tensorrt as trt  # type: ignore

        return trt
    except ImportError as e:
        raise RuntimeError(
            "tensorrt не установлен: лаборатория — TensorRT>=10.8 "
            "(pip install tensorrt, CUDA>=12.8)") from e


def build_engine(onnx_path: str, engine_path: str, fp16: bool = True) -> str:
    trt = _import_trt()
    logger = trt.Logger(getattr(trt.Logger, TRT_LOG_SEVERITY.split("k")[1]))
    builder = trt.Builder(logger)
    flags = 1 << int(trt.NetworkDefinitionCreationFlag.EXPLICIT_BATCH)
    network = builder.create_network(flags)
    parser = trt.OnnxParser(network, logger)
    with open(onnx_path, "rb") as f:
        if not parser.parse(f.read()):
            errs = "; ".join(str(parser.get_error(i))
                             for i in range(parser.num_errors))
            raise RuntimeError(f"ONNX parse: {errs}")
    cfg = builder.create_builder_config()
    if fp16:
        if not builder.platform_has_fast_fp16:
            raise RuntimeError("платформа без fast FP16 — FP32-движок не по ТЗ")
        cfg.set_flag(trt.BuilderFlag.FP16)
    cfg.set_memory_pool_limit(trt.MemoryPoolType.WORKSPACE, 1 << 30)
    blob = builder.build_serialized_network(network, cfg)
    if blob is None:
        raise RuntimeError("build_serialized_network вернул None")
    with open(engine_path, "wb") as f:
        f.write(blob)
    return engine_path


class TrtClassifier:
    """Инференс движка: (1,1,F,T) float32 → probs + latency (мс)."""

    def __init__(self, engine_path: str, labels: list):
        trt = _import_trt()
        import torch  # CUDA-контекст и буферы

        if not torch.cuda.is_available():
            raise RuntimeError("TrtClassifier: нужен CUDA (лабораторная RTX)")
        self._torch = torch
        self.labels = list(labels)
        logger = trt.Logger(getattr(trt.Logger, TRT_LOG_SEVERITY.split("k")[1]))
        runtime = trt.Runtime(logger)
        with open(engine_path, "rb") as f:
            self._engine = runtime.deserialize_cuda_engine(f.read())
        if self._engine is None:
            raise RuntimeError(f"движок не прочитан: {engine_path}")
        self._ctx = self._engine.create_execution_context()
        names = [self._engine.get_tensor_name(i)
                 for i in range(self._engine.num_io_tensors)]
        self._in = next(n for n in names
                        if self._engine.get_tensor_mode(n) == trt.TensorIOMode.INPUT)
        self._out = next(n for n in names
                         if self._engine.get_tensor_mode(n) == trt.TensorIOMode.OUTPUT)
        shape = tuple(self._engine.get_tensor_shape(self._in))
        self._f, self._t = int(shape[-2]), int(shape[-1])
        self._xin = torch.zeros(1, 1, self._f, self._t,
                                dtype=torch.float32, device="cuda")
        self._yout = torch.zeros(1, len(self.labels),
                                 dtype=torch.float32, device="cuda")
        self._ctx.set_tensor_address(self._in, int(self._xin.data_ptr()))
        self._ctx.set_tensor_address(self._out, int(self._yout.data_ptr()))
        self._stream = torch.cuda.Stream()

    @property
    def spec_shape(self) -> tuple:
        return (self._f, self._t)

    def infer(self, spec: np.ndarray) -> dict:
        """spec (1,F,T) float32 [0,1] → {class, probs, latency_ms}."""
        torch = self._torch
        x = torch.from_numpy(np.ascontiguousarray(
            spec.reshape(1, 1, self._f, self._t).astype(np.float32)))
        t0 = time.perf_counter()
        with torch.cuda.stream(self._stream):
            self._xin.copy_(x, non_blocking=True)
            self._ctx.execute_async_v3(self._stream.cuda_stream)
            probs = torch.softmax(self._yout, dim=1)
            host = probs.to("cpu", non_blocking=False)
        self._stream.synchronize()
        dt = (time.perf_counter() - t0) * 1000.0
        p = host.numpy()[0]
        k = int(p.argmax())
        return {"class": self.labels[k], "class_idx": k,
                "conf": float(p[k]), "probs": p, "latency_ms": dt}

    def warmup(self, n: int = 16) -> None:
        dummy = np.zeros((1, self._f, self._t), dtype=np.float32)
        for _ in range(n):
            self.infer(dummy)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("onnx")
    ap.add_argument("engine")
    ap.add_argument("--labels", default=None, help="labels.json для --bench")
    ap.add_argument("--bench", action="store_true")
    args = ap.parse_args()
    build_engine(args.onnx, args.engine)
    print(f"OK: {args.engine}")
    if args.bench:
        import json

        labels = json.load(open(args.labels)) if args.labels else ["c0"]
        clf = TrtClassifier(args.engine, labels)
        clf.warmup()
        lat = [clf.infer(np.zeros((1,) + clf.spec_shape,
                                dtype=np.float32))["latency_ms"]
               for _ in range(200)]
        lat.sort()
        print(f"infer p50={lat[100]:.3f} ms p95={lat[190]:.3f} ms "
              f"(критерий петли: вся цепочка < 10 мс)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
