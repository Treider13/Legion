"""SpectroCNN — компактный CNN для спектрограмм (шаг 5.4).

Вход: (B, 1, 256, 128) float32 [0,1] (5 мс окна при 20 MSPS).
~280k параметров: инференс на RTX 5050 << 1 мс, бюджет петли 10 мс
съедают транспорт и PFB, не сеть. GAP вместо FC по картам — устойчиво
к сдвигу числа классов между DroneRFa и синтетикой (меняется только head).
"""
from __future__ import annotations

import torch
from torch import nn


def _block(cin: int, cout: int) -> nn.Sequential:
    return nn.Sequential(
        nn.Conv2d(cin, cout, 3, stride=2, padding=1, bias=False),
        nn.BatchNorm2d(cout),
        nn.ReLU(inplace=True),
        nn.Conv2d(cout, cout, 3, stride=1, padding=1, bias=False),
        nn.BatchNorm2d(cout),
        nn.ReLU(inplace=True),
    )


class SpectroCNN(nn.Module):
    def __init__(self, n_classes: int, width: int = 24):
        super().__init__()
        w = width
        self.features = nn.Sequential(
            _block(1, w),        # 256×128 → 128×64
            _block(w, w * 2),    # → 64×32
            _block(w * 2, w * 4),  # → 32×16
            _block(w * 4, w * 8),  # → 16×8
        )
        self.pool = nn.AdaptiveAvgPool2d(1)
        self.drop = nn.Dropout(0.25)
        self.head = nn.Linear(w * 8, n_classes)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        z = self.features(x)
        z = self.pool(z).flatten(1)
        return self.head(self.drop(z))
