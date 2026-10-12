"""legion_rx — ПК-сторона лаборатории LEGION (шаги 3–9 ТЗ).

Приём I/Q (bladeRF-cli → FIFO → C reader), GPU-канализация (CuPy PFB),
классификация (PyTorch→ONNX→TensorRT), hop map, управление FPGA через
репозиторный legion_fpga.py (NIOS PIO, без raw poke).
"""
__version__ = "1.3.0"
