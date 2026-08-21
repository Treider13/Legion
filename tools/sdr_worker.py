#!/usr/bin/env python3
"""
LEGION SDR worker — один процесс на сессию радио.

Протокол: одна JSON-строка на stdin → одна JSON-строка на stdout.
Поток TX не пишет в stdout (иначе рассинхрон RPC).

API сверен с:
  https://github.com/pothosware/SoapySDR/wiki/PythonSupport
    Device.enumerate(), Device(args), setupStream CF32,
    readStream/writeStream → StreamResult.ret (сэмплы или код ошибки).
  SoapySDR/Constants.h: TIMEOUT=-1 STREAM_ERROR=-2 CORRUPTION=-3
    OVERFLOW=-4 UNDERFLOW=-7; C++ timeoutUs по умолчанию 100000.
  Deepwave «Transmitting in Python»: timeoutUs=int(1e6), тон не DC.
  MeasureDelay.py: if status.ret != len(tx_pulse): raise.
  SoapyRemote: enumerate/open с driver=remote,remote=tcp://host:55132.

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

# Constants.h — те же числа, если модуль Soapy не импортирован.
SOAPY_SDR_TIMEOUT = -1
SOAPY_SDR_STREAM_ERROR = -2
SOAPY_SDR_CORRUPTION = -3
SOAPY_SDR_OVERFLOW = -4
SOAPY_SDR_UNDERFLOW = -7

try:
    import SoapySDR
    from SoapySDR import SOAPY_SDR_CF32, SOAPY_SDR_RX, SOAPY_SDR_TX

    SOAPY = True
    SOAPY_SDR_TIMEOUT = int(getattr(SoapySDR, "SOAPY_SDR_TIMEOUT", SOAPY_SDR_TIMEOUT))
    SOAPY_SDR_STREAM_ERROR = int(getattr(SoapySDR, "SOAPY_SDR_STREAM_ERROR", SOAPY_SDR_STREAM_ERROR))
    SOAPY_SDR_CORRUPTION = int(getattr(SoapySDR, "SOAPY_SDR_CORRUPTION", SOAPY_SDR_CORRUPTION))
    SOAPY_SDR_OVERFLOW = int(getattr(SoapySDR, "SOAPY_SDR_OVERFLOW", SOAPY_SDR_OVERFLOW))
    SOAPY_SDR_UNDERFLOW = int(getattr(SoapySDR, "SOAPY_SDR_UNDERFLOW", SOAPY_SDR_UNDERFLOW))
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
TX_FAIL_LIMIT = 8
FFT_MIN = 1024  # wiki PythonSupport: буфер 1024, не 64 бина UI


def cw_lo_hz(rf_hz: float, fs: float = TX_FS) -> float:
    """LO так, чтобы тон fs/8 попал на rf. Deepwave: lo = tone_rf - bb."""
    return rf_hz - fs / 8.0


def stream_timeout_us(n: int, fs: float) -> int:
    """Не дефолт 100000 µs. Deepwave: 1e6. Блок + запас на SoapyRemote."""
    block_s = float(n) / max(float(fs), 1.0)
    return max(1_000_000, int(4.0 * block_s * 1e6))


def stream_ret(sr: Any) -> int:
    """Wiki: sr.ret — число сэмплов или код ошибки. Старые биндинги — int."""
    if sr is None:
        return 0
    if hasattr(sr, "ret"):
        try:
            return int(sr.ret)
        except (TypeError, ValueError):
            return 0
    try:
        return int(sr)
    except (TypeError, ValueError):
        return 0


def stream_flags(sr: Any) -> int:
    if sr is None or not hasattr(sr, "flags"):
        return 0
    try:
        return int(sr.flags)
    except (TypeError, ValueError):
        return 0


def stream_kind(ret: int) -> str:
    if ret > 0:
        return "ok"
    if ret == SOAPY_SDR_TIMEOUT:
        return "timeout"
    if ret == SOAPY_SDR_OVERFLOW:
        return "overflow"
    if ret == SOAPY_SDR_UNDERFLOW:
        return "underflow"
    if ret in (SOAPY_SDR_STREAM_ERROR, SOAPY_SDR_CORRUPTION):
        return "error"
    if ret == 0:
        return "empty"
    return "error"


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
        self._tone = None
        self.tx_error: str | None = None
        self.tx_fail = 0

    def tx_live(self) -> bool:
        if self.tx_mhz is None or self.tx_error:
            return False
        if self.fake:
            return True
        return self._thr is not None and self._thr.is_alive()

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
            self.tx_error = None

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
        if not NUMPY:
            return {
                "ok": False,
                "reason": "numpy не установлен — wiki PythonSupport: буферы CF32 это numpy.complex64",
            }
        kw = parse_args(args)
        if not kw:
            # Пустой host в UI = локальный USB. Wiki: Device(результат enumerate).
            try:
                found = list(SoapySDR.Device.enumerate())
            except Exception as e:
                return {"ok": False, "reason": f"enumerate: {e}"}
            if not found:
                return {"ok": False, "reason": "Soapy не видит устройств — укажите IP шлюза/платы"}
            kw = {str(k): str(v) for k, v in dict(found[0]).items()}
        try:
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
        extra = self._scan_extra()
        if not self.full_duplex and self.tx_mhz is not None:
            # GSG HackRF — half-duplex. RX+TX сразу ломает тракт (каталог fullDuplex: false).
            return {
                "ok": True,
                "bins": [],
                "centerMhz": center_mhz,
                "reason": "half-duplex: RX пауза, пока TX на RF out",
                **extra,
            }
        if self.fake:
            return {"ok": True, "bins": _fake_bins(center_mhz, bw, n), "centerMhz": center_mhz, **extra}
        if self.dev is None:
            return {"ok": False, "reason": "SDR не открыт", "bins": [], **extra}
        if not NUMPY:
            return {"ok": False, "reason": "нужен numpy для FFT эфира", "bins": [], **extra}
        # Кепка только по аналоговой BW устройства. Был ещё потолок 40 МГц:
        # при окне 56 МГц (bladeRF) walker шагал на 56, а скан покрывал ±20 —
        # 16 МГц между окнами не сканировались никогда (аудит N1).
        fs = min(max(bw * 1e6, 1e6), self.analog_bw * 1e6)
        with self._lock:
            try:
                self._ensure_rx(fs, center_mhz * 1e6)
                spec = _read_fft(self.dev, self.rx, n, fs, center_mhz)
            except Exception as e:
                return {"ok": False, "reason": f"RX: {e}", "bins": [], **extra}
        return {"ok": True, "bins": spec, "centerMhz": center_mhz, **extra}

    def _scan_extra(self) -> dict[str, Any]:
        out: dict[str, Any] = {"txLive": self.tx_live()}
        if self.tx_error:
            out["txError"] = self.tx_error
        return out

    def tx_cue(self, freq_mhz: float) -> dict[str, Any]:
        if not self.can_tx:
            return {"ok": False, "reason": "нет TX — усилитель подключать некуда", "latencyUs": 0}
        t0 = time.perf_counter()
        if self.fake:
            self.tx_mhz = freq_mhz
            self.tx_error = None
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
        tone = make_cw()
        timeout = stream_timeout_us(len(tone), TX_FS)
        prev_mhz = self.tx_mhz
        created = False
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
                    created = True
                # MeasureDelay: if status.ret != len(tx_pulse): raise
                sr = self.dev.writeStream(self.tx, [tone], len(tone), timeoutUs=timeout)
                ret = stream_ret(sr)
                kind = stream_kind(ret)
                if ret != len(tone):
                    if prev_mhz is not None:
                        self.dev.setFrequency(SOAPY_SDR_TX, 0, cw_lo_hz(prev_mhz * 1e6, TX_FS))
                    elif created and self.tx is not None:
                        try:
                            self.dev.deactivateStream(self.tx)
                            self.dev.closeStream(self.tx)
                        except Exception:
                            pass
                        self.tx = None
                    return {
                        "ok": False,
                        "reason": f"writeStream {kind} ret={ret} (ждали {len(tone)}) — тона на RF out нет",
                        "latencyUs": 0,
                    }
            except Exception as e:
                return {"ok": False, "reason": f"TX tune: {e}", "latencyUs": 0}
        self._tone = tone
        self.tx_mhz = freq_mhz
        self.tx_error = None
        self.tx_fail = 0
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
        tone = self._tone if self._tone is not None else make_cw()
        timeout = stream_timeout_us(len(tone), TX_FS)

        def loop() -> None:
            while not self._stop.is_set() and self.dev is not None and self.tx is not None:
                with self._lock:
                    try:
                        sr = self.dev.writeStream(self.tx, [tone], len(tone), timeoutUs=timeout)
                    except Exception as e:
                        self.tx_error = f"writeStream exception: {e}"
                        break
                    ret = stream_ret(sr)
                    kind = stream_kind(ret)
                    if kind == "ok":
                        self.tx_fail = 0
                        continue
                    if kind == "underflow":
                        # не хватило сэмплов вовремя — пишем снова, это не «нет RF»
                        continue
                    if kind == "error":
                        self.tx_error = f"writeStream {kind} ret={ret}"
                        break
                    self.tx_fail += 1
                    if self.tx_fail >= TX_FAIL_LIMIT:
                        self.tx_error = f"writeStream {kind} ×{self.tx_fail} — TX оборван"
                        break

        self._thr = threading.Thread(target=loop, name="legion-sdr-tx", daemon=True)
        self._thr.start()

    def tx_off(self) -> None:
        self._stop.set()
        if self._thr:
            # writeStream timeoutUs ≥ 1s — join должен переживать один блокирующий write
            self._thr.join(timeout=3.0)
            self._thr = None
        self.tx_mhz = None
        self.tx_error = None
        self.tx_fail = 0
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


def _read_size(dev: Any, rx: Any, n: int) -> int:
    want = max(int(n), FFT_MIN)
    try:
        mtu = int(dev.getStreamMTU(rx))
        if mtu > 0:
            want = max(want, min(mtu, 4096))
    except Exception:
        pass
    return min(max(want, FFT_MIN), 4096)


def _pool_bins(freqs: Any, db: Any, n: int) -> list[dict[str, float]]:
    if len(db) <= n:
        return [{"freqMhz": float(f), "powerDbm": float(p)} for f, p in zip(freqs, db)]
    edges = np.linspace(0, len(db), n + 1, dtype=int)
    out = []
    for i in range(n):
        a, b = int(edges[i]), int(edges[i + 1])
        if b <= a:
            b = a + 1
        j = int(a + np.argmax(db[a:b]))
        out.append({"freqMhz": float(freqs[j]), "powerDbm": float(db[j])})
    return out


def _read_fft(dev: Any, rx: Any, n: int, fs: float, center_mhz: float) -> list[dict[str, float]]:
    """Усредняем |FFT|², не IQ (когерентная сумма фаз гасит тон).
    Wiki: readStream возвращает StreamResult; timeoutUs не дефолт 100ms."""
    if not NUMPY:
        raise RuntimeError("нужен numpy для FFT эфира (pip install numpy)")
    nread = _read_size(dev, rx, n)
    buf = np.zeros(nread, dtype=np.complex64)
    timeout = stream_timeout_us(nread, fs)
    ps = None
    got = 0
    used = nread
    fatal = None
    for _ in range(12):
        sr = dev.readStream(rx, [buf], nread, timeoutUs=timeout)
        ret = stream_ret(sr)
        kind = stream_kind(ret)
        if kind == "error":
            fatal = f"readStream {kind} ret={ret}"
            break
        if ret <= 0:
            continue
        x = buf[:ret]
        if len(x) < 8:
            continue
        # нули в хвосте размазывают спектр (sinc). Только одинаковая длина.
        if ps is not None and len(x) != used:
            continue
        used = len(x)
        win = np.hanning(len(x))
        spec = np.fft.fftshift(np.fft.fft(x * win))
        p = (np.abs(spec) ** 2) / len(x)
        ps = p if ps is None else ps + p
        got += 1
        if got >= 2:
            break
    if fatal:
        raise RuntimeError(fatal)
    if ps is None or got == 0:
        raise RuntimeError("readStream: нет сэмплов (шлюз/кабель/прошивка?)")
    ps = ps / got
    db = 10.0 * np.log10(ps + 1e-12)
    freqs = np.fft.fftshift(np.fft.fftfreq(used, 1.0 / fs)) / 1e6 + center_mhz
    return _pool_bins(freqs, db, n)


def probe(args: str = "") -> dict[str, Any]:
    """Локальный enumerate пустой для SoapyRemote — нужен remote=tcp://host:55132."""
    found: list[dict[str, str]] = []
    if SOAPY:
        try:
            kw = parse_args(args)
            rows = SoapySDR.Device.enumerate(kw) if kw else SoapySDR.Device.enumerate()
            for row in rows:
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
        return {
            "ok": True,
            "soapy": SOAPY,
            "numpy": NUMPY,
            "fake": FAKE or radio.fake,
            "txLive": radio.tx_live(),
            **({"txError": radio.tx_error} if radio.tx_error else {}),
        }
    if op == "probe":
        return probe(str(msg.get("args") or ""))
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
