"""Синтез протоколов лаборатории (шаг 5.3) и датасет спектрограмм."""
from .protocols import (CLASS_LO_HZ, CLASSES, GENERATORS, PARAMS,
                        synth_analog_fpv, synth_crossfire_fsk,
                        synth_crossfire_lora, synth_elrs_24, synth_elrs_900,
                        synth_mavlink, synth_miller, synth_noise,
                        synth_orangerx_dsmx, synth_orangerx_fhss,
                        synth_ttlrs, synth_wifi_bt)
from .dataset import build_synth_dataset

__all__ = ["CLASSES", "CLASS_LO_HZ", "GENERATORS", "PARAMS",
           "build_synth_dataset"] + [f"synth_{c}" if c != "wifi_bt" else "synth_wifi_bt"
                                     for c in CLASSES]
