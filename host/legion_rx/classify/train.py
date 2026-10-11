#!/usr/bin/env python3
"""Обучение классификатора (шаг 5.4–5.6). ОТДЕЛЬНЫЙ ЭТАП — не прогон агента.

    python3 -m legion_rx.classify.train \
        --synth-per-class 400 \
        --dronerf /data/DroneRFa /data/DroneRFz /data/DroneAttackRF \
        --epochs 40 --out host/models/run1

Критерий 5.5: accuracy > 0.95 на val (DroneRFa val + синтетика) — печатается
в конце; ниже критерия — честный exit 2, не «успех».

Аугментации на спектрограмме: сдвиг по частоте (±8 бинов), сдвиг по времени,
добавление гауссова шума (SNR-джиттер), усиление (gain-джиттер). Всё на
тензорах батча, без повторного синтеза.
"""
from __future__ import annotations

import argparse
import json
import os
import time

import numpy as np
import torch
from torch import nn

from ..synth.dataset import build_synth_dataset
from .datasets import load_dronerf
from .model import SpectroCNN

# Шаг 11 ТЗ: нейросеть сокращена до 3 классов (дрон / Wi-Fi / шум).
GROUP3 = {"wifi_bt": "wifi", "noise": "noise"}


def group3_label(class_name: str) -> str:
    """всё RC/дрон → 'drone'; wifi_bt → 'wifi'; noise → 'noise'."""
    return GROUP3.get(class_name, "drone")


def apply_group3(y, classes) -> tuple:
    """Переразметка в 3 класса; возвращает (y3, classes3)."""
    classes3 = ["drone", "wifi", "noise"]
    idx = {name: i for i, name in enumerate(classes3)}
    import numpy as np

    y3 = np.asarray([idx[group3_label(classes[int(c)])] for c in y],
                    dtype=np.int64)
    return y3, classes3


def _augment(x: torch.Tensor, rng: torch.Generator) -> torch.Tensor:
    b = x.size(0)
    # частотный сдвиг
    sh = int(torch.randint(-8, 9, (1,), generator=rng).item())
    if sh:
        x = torch.roll(x, shifts=sh, dims=2)
    sh = int(torch.randint(-16, 17, (1,), generator=rng).item())
    if sh:
        x = torch.roll(x, shifts=sh, dims=3)
    # SNR-джиттер: аддитивный шум в [0,1]-шкале
    noise = torch.randn(x.shape, generator=rng, device=x.device) * 0.03
    # gain-джиттер
    gain = 1.0 + 0.2 * (torch.rand(b, 1, 1, 1, generator=rng, device=x.device) - 0.5)
    return torch.clamp(x * gain + noise, 0.0, 1.0)


def _split(y: np.ndarray, val_frac: float, seed: int):
    rng = np.random.default_rng(seed)
    tr, va = [], []
    for c in np.unique(y):
        idx = np.where(y == c)[0]
        rng.shuffle(idx)
        k = max(1, int(round(len(idx) * val_frac)))
        va += list(idx[:k])
        tr += list(idx[k:]) if len(idx) > 1 else list(idx)
    return np.asarray(tr), np.asarray(va)


def accuracy(model, x, y, device, bs=256) -> float:
    model.eval()
    correct = 0
    with torch.no_grad():
        for i in range(0, len(y), bs):
            xb = torch.from_numpy(x[i: i + bs]).to(device)
            pred = model(xb).argmax(1).cpu().numpy()
            correct += int((pred == y[i: i + bs]).sum())
    return correct / max(1, len(y))


def per_class_acc(model, x, y, classes, device) -> dict:
    model.eval()
    out = {}
    with torch.no_grad():
        for c, name in enumerate(classes):
            idx = np.where(y == c)[0]
            if len(idx) == 0:
                continue
            xb = torch.from_numpy(x[idx]).to(device)
            pred = model(xb).argmax(1).cpu().numpy()
            out[name] = round(float((pred == c).mean()), 4)
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="LEGION lab: обучение CNN классификатора")
    ap.add_argument("--synth-per-class", type=int, default=400)
    ap.add_argument("--dronerf", nargs="*", default=[],
                    help="корни DroneRFa/DroneRFz/DroneAttackRF (шаг 5.1)")
    ap.add_argument("--dronerf-fs", type=float, default=20.0e6,
                    help="fs сегментов датасета, Гц (ресемплинг при ≠20 МГц)")
    ap.add_argument("--epochs", type=int, default=40)
    ap.add_argument("--batch", type=int, default=128)
    ap.add_argument("--lr", type=float, default=3e-4)
    ap.add_argument("--val-frac", type=float, default=0.2)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--no-group3", action="store_true",
                    help="полный набор классов (по умолчанию — 3: дрон/Wi-Fi/шум, шаг 11)")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    device = "cuda" if torch.cuda.is_available() else "cpu"

    # --- данные ---
    synth = build_synth_dataset(args.synth_per_class, seed=args.seed)
    X, y = synth["X"], synth["y"]
    classes = list(synth["classes"])
    off = len(classes)
    for root in args.dronerf:
        ds = load_dronerf(root, fs=args.dronerf_fs)
        X = np.concatenate([X, ds["X"]])
        y = np.concatenate([y, ds["y"] + off])
        classes += [c for c in ds["classes"] if c not in classes]
        off = len(classes)
    if not args.no_group3:
        y, classes = apply_group3(y, classes)  # шаг 11: 3 класса
    tr, va = _split(y, args.val_frac, args.seed)
    print(f"классов: {len(classes)}, образцов: {len(y)} "
          f"(train {len(tr)} / val {len(va)}), device={device}")

    # --- модель ---
    model = SpectroCNN(n_classes=len(classes)).to(device)
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=args.epochs)
    lossf = nn.CrossEntropyLoss(label_smoothing=0.05)
    rng = torch.Generator(device=device).manual_seed(args.seed)

    xtr = torch.from_numpy(X[tr]).to(device)
    ytr = torch.from_numpy(y[tr]).to(device)
    xva, yva = X[va], y[va]

    best = 0.0
    hist = []
    for ep in range(args.epochs):
        model.train()
        perm = torch.randperm(len(ytr), device=device)
        tot, cnt = 0.0, 0
        for i in range(0, len(ytr), args.batch):
            idx = perm[i: i + args.batch]
            xb = _augment(xtr[idx], rng)
            loss = lossf(model(xb), ytr[idx])
            opt.zero_grad(set_to_none=True)
            loss.backward()
            opt.step()
            tot += float(loss) * len(idx)
            cnt += len(idx)
        sched.step()
        acc = accuracy(model, xva, yva, device)
        hist.append({"epoch": ep, "loss": round(tot / max(1, cnt), 5),
                     "val_acc": round(acc, 4)})
        print(f"epoch {ep + 1}/{args.epochs} loss={tot / max(1, cnt):.4f} "
              f"val_acc={acc:.4f}", flush=True)
        if acc > best:
            best = acc
            torch.save({"state_dict": model.state_dict(),
                        "classes": classes,
                        "spec_shape": synth["spec_shape"]},
                       os.path.join(args.out, "best.pt"))
            _export_onnx(model, synth["spec_shape"], device,
                         os.path.join(args.out, "model.onnx"))

    rep = {"val_acc": best, "criterion": 0.95,
           "ok": best > 0.95,
           "per_class": per_class_acc(model, xva, yva, classes, device),
           "classes": classes, "history": hist,
           "finished": time.strftime("%Y-%m-%d %H:%M:%S")}
    with open(os.path.join(args.out, "report.json"), "w") as f:
        json.dump(rep, f, ensure_ascii=False, indent=1)
    with open(os.path.join(args.out, "labels.json"), "w") as f:
        json.dump(classes, f, ensure_ascii=False)
    print(f"val_acc={best:.4f} критерий 0.95 → "
          f"{'DONE' if best > 0.95 else 'FAILED (см. report.json)'}")
    return 0 if best > 0.95 else 2


def _export_onnx(model, spec_shape, device, path: str) -> None:
    model.eval()
    f, t = int(spec_shape[0]), int(spec_shape[1])
    dummy = torch.zeros(1, 1, f, t, device=device)
    torch.onnx.export(
        model, dummy, path, opset_version=17,
        input_names=["spec"], output_names=["logits"],
        dynamic_axes={"spec": {0: "batch"}, "logits": {0: "batch"}})
    model.train()


if __name__ == "__main__":
    raise SystemExit(main())
