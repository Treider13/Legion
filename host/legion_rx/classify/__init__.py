"""Классификация на ПК (шаг 5): CNN PyTorch → ONNX → TensorRT FP16."""
from .model import SpectroCNN
from .infer import Classifier

__all__ = ["SpectroCNN", "Classifier"]
