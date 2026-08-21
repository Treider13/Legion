#!/usr/bin/env python3
"""
LEGION SDR worker — один процесс на сессию радио.

Протокол: одна JSON-строка на stdin → одна JSON-строка на stdout.

API сверен с https://github.com/pothosware/SoapySDR/wiki/PythonSupport
  Device.enumerate(), Device(args), setupStream CF32, readStream/writeStream.

Режим 1: RX FFT (energy) + TX CW на LO → RF out. ESP32 сюда не входит.
LEGION_SDR_FAKE=1 — только проверка протокола (не эфир).
"""
from __future__ import annotations

import json
import math
import os
import sys
import threading
import time
from typing import Any

FAKE = os.environ.get("LEGION_SDR_FAKE", "").strip() in ("1", "true", "yes")

try:
    import SoapySDR
    from SoapySDR import SOAPY_SDR_CF32, SOAPY_SDR_RX, SOAPY_SDR_TX

    SOAPY = True
except ImportError:
    SoapySDR = None  # type: ignore
    SOAPY_SDR_CF32 = SOAPY_SDR_RX = SOAPY_SDR_TX = None  # type: ignore
    SOAPY = False

try:
    import numpy as np

    NUMPY = True
except ImportError:
    np = None  # type: ignore
    NUMPY = False


def _reply(**kw: Any) -> None:
    sys.stdout.write(json.dumps(kw, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def parse_args(s: str) -> dict[str, str]:
    """Soapy Kwargs из строки. SoapyRemote: driver=remote,remote=tcp://host:55132
    (wiki SoapyRemote / 0xfeed). Не режем tcp:// по запятой — запятых в URL нет."""
    out: dict[str, str] = {}
    for part in (s or "").split(","):
        if "=" not in part:
            continue
        k, v = part.split("=", 1)
        k, v = k.strip(), v.strip()
        if k:
            out[k] = v
    return out


TX_FS = 2.0e6
TX_N = 4096  # кратно 8 → целое число периодов при bb = fs/8 (Deepwave AIR-T)


def cw_lo_hz(rf_hz: float, fs: float = TX_FS) -> float:
    """LO так, чтобы тон fs/8 попал на rf. Deepwave: lo = tone_rf - bb."""
    return rf_hz - fs / 8.0


def make_cw(n: int = TX_N, fs: float = TX_FS, amp: float = 0.25):
    """Непрерывный синус, не DC. DC на LMS/AD9361 часто давит IQ-коррекция.
    Источник: Deepwave transmit_tone + пример SoapySDR writeStream CF32."""
    if not NUMPY:
        raise RuntimeError("numpy required")
    t = np.arange(n, dtype=np.float64) / fs
    bb = fs / 8.0
    return (amp * np.exp(1j * 2.0 * np.pi * bb * t)).astype(np.complex64)


class Radio:
    def __init__(self) -> None:
        self.dev = None
        self.rx = None
        self.tx = None
        self.args = ""
        self.fake = FAKE
        self.tx_mhz: float | None = None
        self._stop = threading.Event()
        self._thr: threading.Thread | None = None
        self._lock = threading.Lock()
        self.can_tx = True
        self.full_duplex = True
        self.analog_bw = 20.0
        self._rx_on = False

    def close(self) -> None:
        self.tx_off()
        with self._lock:
            if self.dev is not None and SOAPY:
                try:
                    if self.rx is not None:
                        self.dev.deactivateStream(self.rx)
                        self.dev.closeStream(self.rx)
                except Exception:
                    pass
                try:
                    if self.tx is not None:
                        self.dev.deactivateStream(self.tx)
                        self.dev.closeStream(self.tx)
                except Exception:
                    pass
            self.dev = None
            self.rx = None
            self.tx = None
            self._rx_on = False
            self.args = ""

    def open(self, args: str, analog_bw: float, can_tx: bool, full_duplex: bool) -> dict[str, Any]:
        self.close()
        self.analog_bw = analog_bw if analog_bw > 0 else 20.0
        self.can_tx = can_tx
        self.full_duplex = full_duplex
        self.args = args
        if self.fake or args.startswith("driver=fake"):
            self.fake = True
            return {"ok": True, "reason": "FAKE worker — не эфир", "fake": True}
        if not SOAPY:
            return {"ok": False, "reason": "SoapySDR Python не установлен (пакет python3-soapysdr / pip SoapySDR)"}
        kw = parse_args(args)
        if not kw:
            return {"ok": False, "reason": "пустые Soapy args — укажите Ethernet/шлюз"}
        try:
            # Wiki: Device(dict(...)). Строка тоже валидна в C++ make().
            self.dev = SoapySDR.Device(kw)
            _setup_front_end(self.dev, self.can_tx)
        except Exception as e:
            return {"ok": False, "reason": f"Soapy Device(): {e}"}
        return {"ok": True, "reason": f"открыт Soapy {kw}", "fake": False}

    def _ensure_rx(self, fs: float, center_hz: float) -> None:
        assert self.dev is not None
        self.dev.setSampleRate(SOAPY_SDR_RX, 0, fs)
        try:
            self.dev.setBandwidth(SOAPY_SDR_RX, 0, min(fs, self.analog_bw * 1e6))
        except Exception:
            pass
        self.dev.setFrequency(SOAPY_SDR_RX, 0, center_hz)
        if self.rx is None:
            self.rx = self.dev.setupStream(SOAPY_SDR_RX, SOAPY_SDR_CF32)
            self.dev.activateStream(self.rx)
            self._rx_on = True
        elif not self._rx_on:
            # half-duplex: после TX поток есть, но deactivate — wiki: activate снова
            self.dev.activateStream(self.rx)
            self._rx_on = True

    def scan(self, center_mhz: float, bw_mhz: float, bins: int) -> dict[str, Any]:
        n = max(8, min(int(bins), 4096))
        bw = max(0.2, float(bw_mhz))
        if self.fake:
            return {"ok": True, "bins": _fake_bins(center_mhz, bw, n), "centerMhz": center_mhz}
        if self.dev is None:
            return {"ok": False, "reason": "SDR не открыт", "bins": []}
        if not NUMPY:
            return {"ok": False, "reason": "нужен numpy для FFT эфира", "bins": []}
        fs = min(max(bw * 1e6, 1e6), min(self.analog_bw * 1e6, 40e6))
        with self._lock:
            try:
                self._ensure_rx(fs, center_mhz * 1e6)
                spec = _read_fft(self.dev, self.rx, n, fs, center_mhz)
            except Exception as e:
                return {"ok": False, "reason": f"RX: {e}", "bins": []}
        return {"ok": True, "bins": spec, "centerMhz": center_mhz}

    def tx_cue(self, freq_mhz: float) -> dict[str, Any]:
        if not self.can_tx:
            return {"ok": False, "reason": "нет TX — усилитель подключать некуда", "latencyUs": 0}
        t0 = time.perf_counter()
        if self.fake:
            self.tx_mhz = freq_mhz
            us = int((time.perf_counter() - t0) * 1e6)
            return {"ok": True, "reason": f"FAKE TX {freq_mhz:.6f} МГц", "latencyUs": us, "freqMhz": freq_mhz}
        if self.dev is None:
            return {"ok": False, "reason": "SDR не открыт", "latencyUs": 0}
        if not SOAPY:
            return {"ok": False, "reason": "нет Soapy", "latencyUs": 0}
        if not NUMPY:
            return {"ok": False, "reason": "нет numpy — TX stream нечем кормить", "latencyUs": 0}
        rf_hz = freq_mhz * 1e6
        lo_hz = cw_lo_hz(rf_hz, TX_FS)
        with self._lock:
            try:
                if not self.full_duplex and self.rx is not None and self._rx_on:
                    self.dev.deactivateStream(self.rx)
                    self._rx_on = False
                self.dev.setSampleRate(SOAPY_SDR_TX, 0, TX_FS)
                self.dev.setFrequency(SOAPY_SDR_TX, 0, lo_hz)
                if self.tx is None:
                    self.tx = self.dev.setupStream(SOAPY_SDR_TX, SOAPY_SDR_CF32)
                    self.dev.activateStream(self.tx)
            except Exception as e:
                return {"ok": False, "reason": f"TX tune: {e}", "latencyUs": 0}
        self.tx_mhz = freq_mhz
        self._start_tx_loop()
        us = int((time.perf_counter() - t0) * 1e6)
        return {
            "ok": True,
            "reason": f"SDR TX {freq_mhz:.6f} МГц (тон fs/8, LO {(lo_hz/1e6):.6f}) · {us} µs host",
            "latencyUs": us,
            "freqMhz": freq_mhz,
        }

    def _start_tx_loop(self) -> None:
        if self._thr and self._thr.is_alive():
            return
        self._stop.clear()
        tone = make_cw()

        def loop() -> None:
            # Wiki / Deepwave: writeStream(stream, [buff], len) — без 4-го positional (это flags).
            while not self._stop.is_set() and self.dev is not None and self.tx is not None:
                with self._lock:
                    try:
                        self.dev.writeStream(self.tx, [tone], len(tone))
                    except Exception:
                        break

        self._thr = threading.Thread(target=loop, name="legion-sdr-tx", daemon=True)
        self._thr.start()

    def tx_off(self) -> None:
        self._stop.set()
        if self._thr:
            self._thr.join(timeout=1.0)
            self._thr = None
        self.tx_mhz = None
        if self.dev is not None and self.tx is not None and SOAPY:
            with self._lock:
                try:
                    self.dev.deactivateStream(self.tx)
                    self.dev.closeStream(self.tx)
                except Exception:
                    pass
                self.tx = None


def _fake_bins(center: float, bw: float, n: int) -> list[dict[str, float]]:
    half = bw / 2
    out = []
    for i in range(n):
        f = center - half + (bw * i) / max(n - 1, 1)
        p = -92 + 1.5 * math.sin(f * 0.017)
        out.append({"freqMhz": f, "powerDbm": p})
    return out


def _setup_front_end(dev: Any, can_tx: bool) -> None:
    """Антенна/gain — как в wiki listAntennas + Deepwave setGain. Иначе TX часто в 0."""
    try:
        rx_ants = list(dev.listAntennas(SOAPY_SDR_RX, 0) or [])
        pick = next((a for a in rx_ants if str(a).upper() in ("RX", "RX1", "RX2", "LNAL", "LNAH")), None)
        if pick or rx_ants:
            dev.setAntenna(SOAPY_SDR_RX, 0, pick or rx_ants[0])
    except Exception:
        pass
    try:
        dev.setGainMode(SOAPY_SDR_RX, 0, True)
    except Exception:
        try:
            dev.setGain(SOAPY_SDR_RX, 0, 30)
        except Exception:
            pass
    if not can_tx:
        return
    try:
        tx_ants = list(dev.listAntennas(SOAPY_SDR_TX, 0) or [])
        pick = next((a for a in tx_ants if "TX" in str(a).upper()), None)
        if pick or tx_ants:
            dev.setAntenna(SOAPY_SDR_TX, 0, pick or tx_ants[0])
    except Exception:
        pass
    try:
        rng = dev.getGainRange(SOAPY_SDR_TX, 0)
        lo, hi = float(rng.minimum()), float(rng.maximum())
        dev.setGain(SOAPY_SDR_TX, 0, lo + 0.4 * (hi - lo))
    except Exception:
        try:
            dev.setGain(SOAPY_SDR_TX, 0, 20)
        except Exception:
            pass


def _read_fft(dev: Any, rx: Any, n: int, fs: float, center_mhz: float) -> list[dict[str, float]]:
    """Усредняем |FFT|², не IQ (когерентная сумма фаз гасит тон). Wiki: readStream 3 аргумента."""
    if not NUMPY:
        raise RuntimeError("нужен numpy для FFT эфира (pip install numpy)")
    buf = np.zeros(n, dtype=np.complex64)
    ps = None
    got = 0
    used = n
    for _ in range(12):
        sr = dev.readStream(rx, [buf], n)
        ret = int(getattr(sr, "ret", 0) or 0)
        if ret <= 0:
            continue
        x = buf[:ret]
        if len(x) < 8:
            continue
        win = np.hanning(len(x))
        spec = np.fft.fftshift(np.fft.fft(x * win))
        p = (np.abs(spec) ** 2) / len(x)
        ps = p if ps is None else ps + p
        used = len(x)
        got += 1
        if got >= 2:
            break
    if ps is None or got == 0:
        raise RuntimeError("readStream: нет сэмплов (шлюз/кабель/прошивка?)")
    ps = ps / got
    db = 10.0 * np.log10(ps + 1e-12)
    freqs = np.fft.fftshift(np.fft.fftfreq(used, 1.0 / fs)) / 1e6 + center_mhz
    return [{"freqMhz": float(f), "powerDbm": float(p)} for f, p in zip(freqs, db)]


def probe() -> dict[str, Any]:
    found: list[dict[str, str]] = []
    if SOAPY:
        try:
            for row in SoapySDR.Device.enumerate():
                found.append({str(k): str(v) for k, v in dict(row).items()})
        except Exception as e:
            return {"ok": False, "reason": f"enumerate: {e}", "soapy": True, "devices": []}
    return {
        "ok": True,
        "soapy": SOAPY,
        "numpy": NUMPY,
        "fake": FAKE,
        "devices": found,
        "reason": "SoapySDR ок" if SOAPY else "SoapySDR не найден — поставьте python3-soapysdr на хосте/шлюзе",
    }


def handle(msg: dict[str, Any], radio: Radio) -> dict[str, Any]:
    op = msg.get("op")
    if op == "ping":
        return {"ok": True, "soapy": SOAPY, "numpy": NUMPY, "fake": FAKE or radio.fake}
    if op == "probe":
        return probe()
    if op == "open":
        return radio.open(
            str(msg.get("args") or ""),
            float(msg.get("analogBwMhz") or 20),
            bool(msg.get("canTx", True)),
            bool(msg.get("fullDuplex", True)),
        )
    if op == "scan":
        return radio.scan(float(msg["centerMhz"]), float(msg["bwMhz"]), int(msg.get("bins") or 64))
    if op == "tx":
        return radio.tx_cue(float(msg["freqMhz"]))
    if op == "tx_off":
        radio.tx_off()
        return {"ok": True, "reason": "TX off"}
    if op == "close":
        radio.close()
        return {"ok": True, "reason": "closed"}
    return {"ok": False, "reason": f"unknown op {op}"}


def main() -> int:
    radio = Radio()
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError as e:
            _reply(ok=False, reason=f"JSON: {e}")
            continue
        try:
            _reply(**handle(msg, radio))
        except Exception as e:
            _reply(ok=False, reason=str(e))
    radio.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
