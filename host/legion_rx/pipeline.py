#!/usr/bin/env python3
"""Пайплайн лаборатории (шаги 3–9):

    FIFO → C reader → CuPy PFB → TensorRT → hopMap → legion_fpga.py → окно

Режимы (подкоманды):
  rx-cli    шаг 3: bladeRF-cli → /tmp/iq → C-читатель → OverrunMonitor.
            Критерий 3.10: 20 MSPS, overruns=0 за 60 с (+ байтовая сверка:
            пропавшие сэмплы = пропавшие байты FIFO).
  gpu       шаг 4: + PFB/CH_PWR_gpu/спектр. Критерий 4.5: кадр < 5 мс.
  classify  шаг 5: + классификатор (backend trt/torch, шаг 5.4).
  integrate шаг 9: burst-циклы с кооперативным USB (один владелец FX3!):
            стрим (bladeRF-cli) → rx stop → FpgaBridge (legion_fpga.py)
            → профиль класса → release → стрим. Реактивная петля —
            в FPGA (шаг 7.4); ПК — надзорный контур. Замеры: decision_ms
            (кадр→решение, критерий 9.4 <10 мс при живом GPU) и
            usb_handoff_ms (честная цена перехвата — в отчёт, не в критерий).
  bench     офлайн без железа: синтез → PFB → классификатор → hop map →
            замеры задержек и точности предсказания (критерии 6.4, 9.4
            проверяются здесь до выезда в лабораторию).
  cognitive  FHSS-память. Без --live — синтетика и FakeTransport.
            --live --corridor F1 F2: консоль задаёт частоту, LNA и полосу
            и закрывается. Дальше USB держит UsbOwner (SC16_Q11_META):
            кадры в FIFO, C-читатель → PFB → FSM. Запись регистров на
            время кадра отпускает libbladeRF и забирает его обратно.
            Консоль во время удара устройство не открывает.

Журнал каждого прогона: host/logs/<ts>-<mode>.jsonl.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from .ops import sanitize

_LIVE: dict = {}


def _on_signal(signum, _frame) -> None:
    raise SystemExit(128 + int(signum))
import queue
import sys
import threading
import time

import numpy as np

from . import xputil
from .cli_session import BladerfCliSession
from .fifo_source import FifoSource, ensure_fifo
from .hopmap import HopTracker
from .ipc import UdpPublisher
from .overrun import OverrunMonitor
from .pfb import Channelizer
from .spectrogram import spectrum_db, stft_db
from .synth import GENERATORS, CLASS_LO_HZ
from .synth.dataset import spec_from_iq

LOG_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "logs")
FIFO_PATH = "/tmp/iq"
FS_LAB = 20.0e6  # USB I/Q на ПК (Nuand [F1], не эфир RBF)
FRAME_SAMPLES = 20_000  # 1 мс при 20 MSPS


class JsonLog:
    def __init__(self, mode: str):
        os.makedirs(LOG_DIR, exist_ok=True)
        ts = time.strftime("%Y%m%d-%H%M%S")
        self.path = os.path.join(LOG_DIR, f"{ts}-{mode}.jsonl")
        self._f = open(self.path, "a", buffering=1)

    def write(self, rec: dict) -> None:
        line = json.dumps(sanitize(rec), ensure_ascii=False) + "\n"
        self._rotate(len(line.encode()))
        self._f.write(line)

    def _rotate(self, incoming: int) -> None:
        """10 МБ, пять файлов: path, path.1 … path.4."""
        try:
            size = os.path.getsize(self.path)
        except OSError:
            size = 0
        if size + incoming < 10 * 1024 * 1024:
            return
        self._f.close()
        for i in range(4, 0, -1):
            src = f"{self.path}.{i}"
            dst = f"{self.path}.{i + 1}"
            if i == 4 and os.path.exists(src):
                os.remove(src)
            elif os.path.exists(src):
                os.replace(src, dst)
        os.replace(self.path, f"{self.path}.1")
        self._f = open(self.path, "a", buffering=1)

    def close(self) -> None:
        self._f.close()


def _percentiles(v: list, ps=(50, 95, 99)) -> dict:
    if not v:
        return {f"p{p}": None for p in ps}
    a = np.sort(np.asarray(v, dtype=np.float64))
    return {f"p{p}": round(float(np.percentile(a, p)), 3) for p in ps}


# ---------------------------------------------------------------- шаг 3

def _preflight(args, log: JsonLog) -> bool:
    """Pre-flight [F8]: USB SuperSpeed + rx config format=bin (шаг 3.7).
    SuperSpeed отсутствует — предупреждение (не фатал: может быть стенд
    на USB 2.0 с пониженным fs); format=bin не принят — отказ старта."""
    from .cli_session import preflight

    pf = preflight(device=args.device)
    log.write({"kind": "preflight", **pf})
    if pf["usb_superspeed"] is False:
        print("preflight: USB НЕ SuperSpeed — 20 MSPS недостижимо, "
              "ожидайте overruns (критерий 3.10 под угрозой)", file=sys.stderr)
    if pf["usb_superspeed"] is None:
        print("preflight: USB speed не распознан в `info` — продолжаем "
              "(формат версии иной)", file=sys.stderr)
    for e in pf["errors"]:
        print(f"preflight: {e}", file=sys.stderr)
    return bool(pf["format_bin_ok"])


def run_rx_cli(args, log: JsonLog, pub: "UdpPublisher | None") -> int:
    if not _preflight(args, log):
        print("preflight: rx config format=bin не принят — старт отменён",
              file=sys.stderr)
        return 2
    ensure_fifo(args.fifo)
    src = FifoSource(args.fifo, args.frame_samples, args.fs)
    sess = BladerfCliSession(device=args.device)
    state = {"fs": args.fs}

    def escalate(total: int) -> None:
        """[F3] Реакция на overrun: рестарт стрима с понижением 20→10 MSPS.
        На 10 MSPS overrun'ов быть не должно — иначе проблема не в линке."""
        if state["fs"] <= 10.0e6:
            log.write({"kind": "escalate_giveup", "total": total,
                       "reason": "уже на 10 MSPS — проблема не samplerate"})
            print(f"overrun×{total}: уже 10 MSPS, эскалация исчерпана",
                  file=sys.stderr)
            return
        state["fs"] = 10.0e6
        src.fs_hz = state["fs"]
        log.write({"kind": "escalation", "total": total,
                   "action": "rx_stop → set samplerate 10M → rx_start"})
        print(f"overrun×{total}: эскалация — рестарт стрима на 10 MSPS",
              file=sys.stderr)
        sess.rx_stop()
        sess.set_samplerate_rx(state["fs"])
        sess.rx_start()

    mon = OverrunMonitor(sess, log_path=None, on_escalate=escalate,
                         escalate_threshold=10)
    verdict = {}
    try:
        sess.set_frequency_rx(args.freq)          # 3.2
        sess.set_samplerate_rx(args.fs)           # 3.3
        sess.set_bandwidth_rx(args.bw)            # 3.4
        sess.rx_config(file=args.fifo, fmt="bin", n=0)  # 3.5 (bin = SC16_Q11, 3.7)
        src.start()
        sess.rx_start()                           # 3.6
        mon.start()                               # 3.9
        t0 = time.perf_counter()
        frames = 0
        first_t = last_t = None
        while time.perf_counter() - t0 < args.duration_s:
            try:
                fr = src.frames.get(timeout=0.5)
                frames += 1
                first_t = fr.t_first if first_t is None else first_t
                last_t = fr.t_done
            except queue.Empty:
                if src.eof:
                    break
            if int(time.perf_counter() - t0) % 5 == 0 and pub:
                pub.send_stat({"throughput_mb_s": src.stats(
                    time.perf_counter() - t0)["throughput_mb_s"]})
        sess.rx_stop()
        time.sleep(0.2)
        sess.close()
        src.stop()
        mon.stop()
        el = time.perf_counter() - t0
        st = src.stats(el)
        ov = mon.verdict()
        expected_mb = state["fs"] * 4 * el / 1e6  # fs мог снизиться эскалацией
        verdict = {
            **st, **ov, "frames": frames,
            "expected_mbytes": round(expected_mb, 2),
            "byte_ratio": round(st["mbytes"] / expected_mb, 4) if expected_mb else 0.0,
            "duration_s": round(el, 2),
        }
        # Критерий 3.10: overruns=0 И байты сошлись (≥99.5% потока) И
        # наш консьюмер не ронял кадры.
        verdict["ok"] = bool(ov["ok"] and verdict["byte_ratio"] >= 0.995
                             and st["dropped_frames"] == 0)
        log.write({"kind": "verdict", **verdict})
        print(json.dumps(verdict, ensure_ascii=False, indent=1))
        return 0 if verdict["ok"] else 2
    finally:
        mon.stop()
        src.stop()
        sess.close()


# ---------------------------------------------------------------- шаг 4

class GpuChain:
    """PFB + CH_PWR_gpu + спектр; замер задержки кадра (шаги 4.4–4.7)."""

    def __init__(self, n_chans: int, taps: int, xp):
        self.xp = xp
        self.ch = Channelizer(n_chans, taps, xp=xp)
        self.lat_ms: list[float] = []

    def process(self, fr, pub: "UdpPublisher | None"):
        xp = self.xp
        x = xp.asarray(fr.complex64())
        y = self.ch.channelize(x)
        pwr = self.ch.ch_power(y)
        t_done = time.perf_counter()
        self.lat_ms.append((t_done - fr.t_done) * 1000.0)
        if pub:
            pwr_h = xputil.to_host(pwr)
            pub.send_ch_pwr(pwr_h)
            spec = spectrum_db(x[: 4 * 1024 * 8], 1024, 512, xp)
            pub.send_spec(xputil.to_host(spec))
            pub.send_wf_row(xputil.to_host(spec))
        return pwr


def run_gpu(args, log: JsonLog, pub: "UdpPublisher | None") -> int:
    if not _preflight(args, log):
        return 2
    xp = xputil.backend("cpu" if args.cpu else "gpu")
    ensure_fifo(args.fifo)
    src = FifoSource(args.fifo, args.frame_samples, args.fs)
    sess = BladerfCliSession(device=args.device)
    mon = OverrunMonitor(sess)
    chain = GpuChain(args.n_chans, args.taps, xp)
    tracker = HopTracker(args.n_chans, args.frame_samples / args.fs)
    try:
        sess.set_frequency_rx(args.freq)
        sess.set_samplerate_rx(args.fs)
        sess.set_bandwidth_rx(args.bw)
        sess.rx_config(file=args.fifo, fmt="bin", n=0)
        src.start()
        sess.rx_start()
        mon.start()
        t0 = time.perf_counter()
        while time.perf_counter() - t0 < args.duration_s:
            try:
                fr = src.frames.get(timeout=0.5)
            except queue.Empty:
                if src.eof:
                    break
                continue
            pwr = chain.process(fr, pub)
            hop = tracker.update(xputil.to_host(pwr), fr.t_done)
            if hop["hop"] and pub:
                pub.send_hop({**tracker.protocol_match(),
                              **tracker.predict_next()})
        sess.rx_stop()
        time.sleep(0.2)
        sess.close()
        src.stop()
        mon.stop()
        lat = _percentiles(chain.lat_ms)
        verdict = {"frames": len(chain.lat_ms), "latency_ms": lat,
                   "criterion_ms": 5.0,
                   "latency_ok": (lat["p50"] is not None and lat["p50"] < 5.0),
                   "pfb_backend": chain.ch.backend_name,
                   "hop": tracker.protocol_match(),
                   "hop_pred_acc": tracker.prediction_accuracy(),
                   "overruns": mon.verdict()}
        verdict["ok"] = bool(verdict["latency_ok"] and verdict["overruns"]["ok"])
        log.write({"kind": "verdict", **verdict})
        print(json.dumps(verdict, ensure_ascii=False, indent=1, default=str))
        return 0 if verdict["ok"] else 2
    finally:
        mon.stop()
        src.stop()
        sess.close()


# ---------------------------------------------------------------- шаг 5

def _make_classifier(args):
    if not (args.engine or args.torch):
        return None
    from .classify import Classifier

    clf = Classifier(backend="auto", engine_path=args.engine,
                     torch_path=args.torch, labels_path=args.labels)
    clf.warmup()
    return clf


def run_classify(args, log: JsonLog, pub: "UdpPublisher | None") -> int:
    xp = xputil.backend("cpu" if args.cpu else "gpu")
    clf = _make_classifier(args)
    if clf is None:
        print("classify: нужен --engine или --torch", file=sys.stderr)
        return 2
    if not _preflight(args, log):
        return 2
    ensure_fifo(args.fifo)
    src = FifoSource(args.fifo, args.frame_samples * 5, args.fs)  # 5 мс окно
    sess = BladerfCliSession(device=args.device)
    mon = OverrunMonitor(sess)
    chain = GpuChain(args.n_chans, args.taps, xp)
    tracker = HopTracker(args.n_chans, args.frame_samples / args.fs)
    cls_lat: list[float] = []
    classes_seen: dict = {}
    try:
        sess.set_frequency_rx(args.freq)
        sess.set_samplerate_rx(args.fs)
        sess.set_bandwidth_rx(args.bw)
        sess.rx_config(file=args.fifo, fmt="bin", n=0)
        src.start()
        sess.rx_start()
        mon.start()
        t0 = time.perf_counter()
        while time.perf_counter() - t0 < args.duration_s:
            try:
                fr = src.frames.get(timeout=0.5)
            except queue.Empty:
                if src.eof:
                    break
                continue
            iq = fr.complex64()
            x = xp.asarray(iq)
            # 5 подкадров по 1 мс сквозь PFB — hop map живёт на 1 мс
            for i in range(5):
                sub = x[i * args.frame_samples: (i + 1) * args.frame_samples]
                y = chain.ch.channelize(sub)
                tracker.update(xputil.to_host(chain.ch.ch_power(y)),
                               fr.t_first + i * args.frame_samples / args.fs)
            spec = spec_from_iq(iq)
            res = clf.infer(spec)
            cls_lat.append(res["latency_ms"])
            classes_seen[res["class"]] = classes_seen.get(res["class"], 0) + 1
            if pub:
                pub.send_cls(res)
                pub.send_hop({**tracker.protocol_match(),
                              **tracker.predict_next()})
            log.write({"kind": "cls", "t": fr.t_done, "class": res["class"],
                       "conf": res["conf"], "latency_ms": res["latency_ms"]})
        sess.rx_stop()
        time.sleep(0.2)
        sess.close()
        src.stop()
        mon.stop()
        verdict = {"frames": len(cls_lat), "cls_latency_ms": _percentiles(cls_lat),
                   "backend": clf.backend, "classes": classes_seen,
                   "hop": tracker.protocol_match(),
                   "overruns": mon.verdict(),
                   "ok": mon.verdict()["ok"]}
        log.write({"kind": "verdict", **verdict})
        print(json.dumps(verdict, ensure_ascii=False, indent=1, default=str))
        return 0 if verdict["ok"] else 2
    finally:
        mon.stop()
        src.stop()
        sess.close()


# ---------------------------------------------------------------- шаг 9

def run_integrate(args, log: JsonLog, pub: "UdpPublisher | None") -> int:
    """Burst-циклы: CLI-стрим → GPU → решение → rx stop → USB (legion_fpga)
    → профиль → release → следующий burst. LO — по карте классов (9.3)."""
    from . import fpga_control as fc

    profiles = args.profiles.split(",") if args.profiles else ["elrs_24"]
    unknown = [p for p in profiles if p not in fc.PROFILES]
    if unknown:
        print(f"integrate: неизвестные профили {unknown}; "
              f"доступные: {sorted(fc.PROFILES)}", file=sys.stderr)
        return 2
    if not _preflight(args, log):
        return 2
    xp = xputil.backend("cpu" if args.cpu else "gpu")
    clf = _make_classifier(args)
    chain = GpuChain(args.n_chans, args.taps, xp)
    decision_ms: list[float] = []
    handoff_ms: list[float] = []
    applied: list[str] = []
    for cycle in range(args.cycles):
        proto = profiles[cycle % len(profiles)]
        lo = float(CLASS_LO_HZ.get(proto, args.freq))
        # --- фаза стрима (USB у bladeRF-cli) ---
        ensure_fifo(args.fifo)
        src = FifoSource(args.fifo, args.frame_samples, args.fs)
        sess = BladerfCliSession(device=args.device)
        mon = OverrunMonitor(sess)
        tracker = HopTracker(args.n_chans, args.frame_samples / args.fs)
        last_frame_t = None
        cls_res = None
        try:
            sess.set_frequency_rx(lo)
            time.sleep(fc.PLL_SETTLE_S)  # 9.3: PLL settling ≥ 100 мкс
            sess.set_samplerate_rx(args.fs)
            sess.set_bandwidth_rx(args.bw)
            sess.rx_config(file=args.fifo, fmt="bin", n=0)
            src.start()
            sess.rx_start()
            mon.start()
            t0 = time.perf_counter()
            while time.perf_counter() - t0 < args.burst_s:
                try:
                    fr = src.frames.get(timeout=0.3)
                except queue.Empty:
                    continue
                last_frame_t = fr.t_done
                pwr = chain.process(fr, pub)
                tracker.update(xputil.to_host(pwr), fr.t_done)
                if clf is not None and len(chain.lat_ms) % 5 == 0:
                    cls_res = clf.infer(spec_from_iq(fr.complex64()))
                    if pub:
                        pub.send_cls(cls_res)
            sess.rx_stop()
            time.sleep(0.15)
            sess.close()
            src.stop()
            mon.stop()
        finally:
            sess.close()
            src.stop()
            mon.stop()
        # --- решение: профиль по классификатору или фиксированный протокол ---
        name = proto
        if cls_res and cls_res["class"] in fc.PROFILES and not args.fixed_profile:
            name = cls_res["class"]
        p = fc.PROFILES.get(name)
        # --- фаза управления (USB у legion_fpga.py через FpgaBridge) ---
        t_h0 = time.perf_counter()
        ok = False
        air_fs = fc.AIR_FS_HZ  # 34e6 — эфир RBF, не USB args.fs
        try:
            with fc.FpgaBridge() as br:
                ok = br.fpga.set_air_fs_hz(int(air_fs))
                ok = fc.apply_profile(br.fpga, p, air_fs) and ok
                ok = br.fpga.heartbeat() and ok
                # +2 sample @ 34e6 = 58.8 нс; MCP PIO 58.8 нс. USB >> обоих.
        except Exception as e:
            log.write({"kind": "fpga_error", "cycle": cycle, "error": str(e)})
            print(f"integrate: FPGA недоступна (цикл {cycle}): {e}",
                  file=sys.stderr)
        handoff_ms.append((time.perf_counter() - t_h0) * 1000.0)
        if last_frame_t is not None:
            decision_ms.append((time.perf_counter() - last_frame_t) * 1000.0)
        if ok:
            applied.append(name)
        rec = {"kind": "cycle", "cycle": cycle, "profile": name, "lo_hz": lo,
               "applied": bool(ok), "decision_ms": round(decision_ms[-1], 3),
               "handoff_ms": round(handoff_ms[-1], 3),
               "hop": tracker.protocol_match(),
               "overruns": mon.verdict()}
        log.write(rec)
        print(json.dumps(rec, ensure_ascii=False), flush=True)
    verdict = {
        "cycles": args.cycles, "applied": applied,
        "decision_ms": _percentiles(decision_ms),
        "usb_handoff_ms": _percentiles(handoff_ms),
        "criterion_9_4_ms": 10.0,
        "decision_ok": bool(decision_ms and
                            _percentiles(decision_ms)["p50"] is not None and
                            _percentiles(decision_ms)["p50"] < 10.0),
    }
    verdict["ok"] = bool(applied) and verdict["decision_ok"]
    log.write({"kind": "verdict", **verdict})
    print(json.dumps(verdict, ensure_ascii=False, indent=1))
    return 0 if verdict["ok"] else 2


# ---------------------------------------------------------------- bench

def run_bench(args, log: JsonLog, pub: "UdpPublisher | None") -> int:
    """Офлайн без железа: синтез → PFB → классификатор → hop map → замеры.
    Проверка критериев 6.4 (hop > 0.7/10) и 9.4 (decision < 10 мс) до лабы."""
    from . import fpga_control as fc

    xp = xputil.backend("cpu" if args.cpu else "auto")
    gen = GENERATORS[args.protocol]
    out = gen(fs=args.fs, dur=args.duration_s,
              lo_hz=CLASS_LO_HZ.get(args.protocol, args.freq),
              seed=args.seed, snr_db=20.0)
    iq, meta = out["iq"], out["meta"]
    ch = Channelizer(args.n_chans, args.taps, xp=xp)
    tracker = HopTracker(args.n_chans, args.frame_samples / args.fs)
    clf = _make_classifier(args) if (args.engine or args.torch) else None
    if clf is not None:
        clf.warmup()
    # FakeTransport: путь записи регистров legion_fpga.py без железа
    # pack/xfer в память — стоимость решения+записи в логе.
    # fpga/host уже на sys.path (fpga_control вставил при импорте).
    from legion_gateway import FakeTransport

    fake_fpga = fc.lf.LegionFpga(FakeTransport(board="bladerf2"))
    n_fr = len(iq) // args.frame_samples
    cls_lat: list[float] = []
    dec_ms: list[float] = []
    t_stream0 = time.perf_counter()
    spec_win = 5  # кадров по 1 мс на окно классификации
    for i in range(n_fr):
        seg = iq[i * args.frame_samples: (i + 1) * args.frame_samples]
        t_fr_done = t_stream0 + (i + 1) * args.frame_samples / args.fs
        y = ch.channelize(xp.asarray(seg))
        tracker.update(xputil.to_host(ch.ch_power(y)), t_fr_done)
        if tracker.dom[-1] is not None and tracker.dom[-2:-1] != tracker.dom[-1:]:
            if (i + 1) % 128 == 0:
                tracker.protocol_match()  # обновляет _dwell_est для слияния
            tracker.predict_next()
        if clf is not None and (i + 1) % spec_win == 0:
            w0 = max(0, (i + 1 - spec_win)) * args.frame_samples
            spec = spec_from_iq(iq[w0: (i + 1) * args.frame_samples])
            res = clf.infer(spec)
            cls_lat.append(res["latency_ms"])
            if pub:
                pub.send_cls(res)
            name = res["class"] if res["class"] in fc.PROFILES else args.protocol
            t0 = time.perf_counter()
            fc.apply_profile(fake_fpga, fc.PROFILES[name], args.fs)
            dec_ms.append((time.perf_counter() - t0) * 1000.0 +
                          res["latency_ms"])
    acc, n_pred = tracker.prediction_accuracy()
    # Нет скачков (узкополосные MAVLink/TTLRS/Miller/аналог) или
    # криптографический AFH (BT) — критерий 6.4 неприменим (n/a).
    det = bool(meta.get("deterministic", True)) and bool(meta.get("hop_rate_hz"))
    verdict = {
        "protocol": args.protocol,
        "frames": n_fr,
        "hop_rate": tracker.protocol_match(),
        "hop_truth_hz": meta.get("hop_rate_hz", 0.0),
        "hop_pred_acc": acc, "hop_pred_n": n_pred,
        # BT/AFH: паттерн криптографический, критерий 6.4 неприменим (n/a)
        "criterion_6_4": (acc > 0.7 and n_pred >= 10) if det else "n/a",
        "cls_backend": getattr(clf, "backend", None),
        "cls_latency_ms": _percentiles(cls_lat),
        "decision_ms": _percentiles(dec_ms),
        "criterion_9_4": (not dec_ms) or
                         (_percentiles(dec_ms)["p50"] is not None and
                          _percentiles(dec_ms)["p50"] < 10.0),
    }
    c64 = verdict["criterion_6_4"]
    verdict["ok"] = bool((c64 is True or c64 == "n/a") and verdict["criterion_9_4"])
    log.write({"kind": "verdict", **verdict})
    print(json.dumps(verdict, ensure_ascii=False, indent=1, default=str))
    return 0 if verdict["ok"] else 2


# ---------------------------------------------------------------- когнитив

def _mix_lo_retune(iq: np.ndarray, fs: float, old_lo: float,
                   new_lo: float) -> np.ndarray:
    """Смена LO как у радио: RF = IF + LO не двигается, IF сдвигается на
    (old_lo − new_lo). Не регенерация hops (фаза сетки сохранится)."""
    df = float(old_lo) - float(new_lo)
    if abs(df) < 1.0 or iq.size == 0:
        return iq
    n = np.arange(iq.shape[0], dtype=np.float64)
    rot = np.exp(1j * (2.0 * np.pi * df / float(fs)) * n)
    return (iq * rot).astype(np.complex64)


def _hz_arg(v) -> float:
    """2400 / 2400M / 2.4e9 → Гц. Число меньше 1e6 без суффикса — МГц."""
    if isinstance(v, str):
        t = v.strip().lower().replace(" ", "")
        mult = 1.0
        suffixed = False
        for suf, m in (("msps", 1e6), ("mhz", 1e6), ("khz", 1e3),
                       ("hz", 1.0), ("m", 1e6), ("k", 1e3)):
            if t.endswith(suf):
                mult = m
                suffixed = True
                t = t[: -len(suf)]
                break
        val = float(t) * mult
    else:
        val = float(v)
        suffixed = False
    if not suffixed and 0.0 < val < 1.0e6:
        val *= 1.0e6
    return val


def _corridor_span(args) -> "tuple | None":
    cor = getattr(args, "corridor", None)
    if cor:
        a, b = _hz_arg(cor[0]), _hz_arg(cor[1])
        return (min(a, b), max(a, b))
    if getattr(args, "scan_start", None) and getattr(args, "scan_end", None):
        return (float(args.scan_start), float(args.scan_end))
    return None


class _RxProxy:
    """LO для LoSweeper: пишет в текущую сессию bladeRF-cli."""

    def __init__(self, live: "_LiveRx"):
        self._live = live

    def set_frequency_rx(self, hz: float) -> None:
        self._live.tune(float(hz))


class _LiveRx:
    """bladeRF-cli → FIFO. stop() отдаёт USB, start() поднимает стрим снова."""

    def __init__(self, args, fs_hz: float, lo_hz: float):
        self.device = getattr(args, "device", None)
        self.fifo = args.fifo
        self.fs = float(fs_hz)
        self.bw = float(getattr(args, "bw", None) or 20.0e6)
        self.frame_samples = int(args.frame_samples)
        self.lo = float(lo_hz)
        self.sess = None
        self.src = None
        self.mon = None
        self.streaming = False

    def tune(self, hz: float) -> None:
        self.lo = float(hz)
        if self.sess is not None:
            self.sess.set_frequency_rx(self.lo)

    def start(self) -> None:
        if self.streaming:
            return
        ensure_fifo(self.fifo)
        self.sess = BladerfCliSession(device=self.device)
        self.sess.set_frequency_rx(self.lo)
        self.sess.set_samplerate_rx(self.fs)
        self.sess.set_bandwidth_rx(self.bw)
        self.sess.rx_config(file=self.fifo, fmt="bin", n=0)
        self.src = FifoSource(self.fifo, self.frame_samples, self.fs)
        self.src.start()
        self.sess.rx_start()
        self.mon = OverrunMonitor(self.sess)
        self.mon.start()
        self.streaming = True

    def stop(self) -> None:
        if self.mon is not None:
            self.mon.stop()
            self.mon = None
        if self.sess is not None:
            try:
                # RX стоп на время записи FPGA: у FX3 один владелец USB.
                self.sess.rx_stop()
            except Exception:
                pass
            self.sess.close()
            self.sess = None
        if self.src is not None:
            self.src.stop()
            self.src = None
        self.streaming = False

    def read_frame(self, timeout: float = 0.5):
        if self.src is None:
            return None
        try:
            return self.src.frames.get(timeout=timeout)
        except queue.Empty:
            return None

    @property
    def eof(self) -> bool:
        return self.src is not None and self.src.eof


class _HandoffFpga:
    """LegionFpga через FpgaBridge. Перед записью стрим отпускает USB."""

    def __init__(self, radio: _LiveRx):
        self._radio = radio
        self._br = None
        self._held = False

    def _ensure(self):
        if self._br is not None:
            return self._br.fpga
        self._radio.stop()
        self._held = True
        from . import fpga_control as fc
        br = fc.FpgaBridge()
        br.__enter__()
        self._br = br
        return br.fpga

    def end_tick(self) -> None:
        if self._br is None and not self._held:
            return
        if self._br is not None:
            try:
                self._br.__exit__(None, None, None)
            finally:
                self._br = None
        self._held = False
        self._radio.start()

    def close(self) -> None:
        if self._br is not None:
            try:
                self._br.__exit__(None, None, None)
            finally:
                self._br = None
        self._held = False

    def __getattr__(self, name):
        return getattr(self._ensure(), name)


class _UsbLive:
    """Консоль только для первичной настройки. Поток — libbladeRF.

    UsbOwner пишет SC16 в FIFO, C-читатель забирает кадры как раньше.
    """

    def __init__(self, args, fs_hz: float, lo_hz: float):
        from .libbladerf_owner import UsbOwner
        self.device = getattr(args, "device", None)
        self.fifo = args.fifo
        self.fs = float(fs_hz)
        self.bw = float(getattr(args, "bw", None) or 20.0e6)
        self.lna = int(getattr(args, "lna", None) or 20)
        self.frame_samples = int(args.frame_samples)
        self.lo = float(lo_hz)
        self.usb = UsbOwner()
        self.src = None
        self._fd = None
        self._th = None
        self._stop = threading.Event()
        self._io = threading.Lock()
        self._paused = False
        self.streaming = False
        self.fault = ""
        self.usb_errors = 0
        self._tune_req = 0
        self._tune_done = 0

    def park_locked(self, lo_hz: int) -> int:
        """Обе несущие на центр стоянки, между кадрами, до закрытия handle."""
        with self._io:
            if self._paused or not self.usb.open:
                return -1
            rc = self.usb._set_frequency(0, int(lo_hz))
            if rc != 0:
                return rc
            rc = self.usb._set_frequency(1, int(lo_hz))
            if rc == 0:
                self.lo = float(lo_hz)
            return rc

    def capture_locked(self, slot: int, lo_hz: int) -> int:
        """Снимок профиля между кадрами. set_frequency поверх sync_rx ждёт буфер до 1 с."""
        with self._io:
            if self._paused or not self.usb.open:
                return -1
            return self.usb.capture_pair(int(slot), int(lo_hz))

    def tune(self, hz: float) -> None:
        """LO между кадрами. set_frequency поверх sync_rx ждёт буфер до 1 с."""
        target = int(hz)
        self.lo = float(target)
        self._tune_req = target
        if not self.usb.open or self._paused:
            self._tune_done = target
            return
        deadline = time.perf_counter() + 0.008
        while self._tune_done != target and time.perf_counter() < deadline:
            time.sleep(0.0002)

    def _prime_cli(self) -> None:
        sess = BladerfCliSession(device=self.device)
        try:
            sess.set_frequency_rx(self.lo)
            sess.set_samplerate_rx(self.fs)
            sess.set_bandwidth_rx(self.bw)
            sess.cmd("set agc off")
            sess.cmd(f"set gain rx {self.lna}")
        finally:
            sess.close()

    def start(self) -> None:
        if self.streaming:
            return
        self._prime_cli()
        rc = self.usb.acquire(self.device or "")
        if rc != 0:
            raise RuntimeError(f"UsbOwner.acquire: {rc}")
        rc = self.usb.configure(int(self.lo), int(self.fs), int(self.bw), self.lna)
        if rc != 0:
            self.usb.release()
            raise RuntimeError(f"UsbOwner.configure: {rc}")
        rc = self.usb.arm_meta_stream()
        if rc != 0:
            self.usb.release()
            raise RuntimeError(f"UsbOwner.arm_meta_stream: {rc}")
        rc = self.usb.enable_rx(True)
        if rc != 0:
            self.usb.release()
            raise RuntimeError(f"UsbOwner.enable_rx: {rc}")
        ensure_fifo(self.fifo)
        self._fd = os.open(self.fifo, os.O_RDWR)
        self.src = FifoSource(self.fifo, self.frame_samples, self.fs)
        self._stop.clear()
        self._paused = False
        self.src.start()
        self._th = threading.Thread(target=self._pump, daemon=True,
                                    name="usb-owner-rx")
        self._th.start()
        self.streaming = True

    def _pump(self) -> None:
        fd = self._fd
        applied = 0
        try:
            while not self._stop.is_set():
                with self._io:
                    if self._paused or not self.usb.open:
                        raw = b""
                        rc = 0
                    else:
                        req = int(self._tune_req)
                        if req and req != applied:
                            self.usb.set_frequency(req)
                            applied = req
                            self._tune_done = req
                            self.lo = float(req)
                        rc, raw, _ts = self.usb.read_frame_bytes(
                            self.frame_samples)
                if rc in (-5, -6, -7):
                    self.usb_errors += 1
                    if self.usb_errors >= 3:
                        self.fault = "usb"
                        break
                    with self._io:
                        self.usb.release()
                    time.sleep(0.2)
                    with self._io:
                        if self.usb.acquire(self.device or "") == 0:
                            self.usb.configure(
                                int(self.lo), int(self.fs), int(self.bw),
                                self.lna)
                            self.usb.arm_meta_stream()
                            self.usb.enable_rx(True)
                    continue
                if rc == 0:
                    self.usb_errors = 0
                if not raw:
                    time.sleep(0.002)
                    continue
                try:
                    os.write(fd, raw)
                except OSError:
                    break
        finally:
            try:
                os.close(fd)
            except OSError:
                pass
            self._fd = None

    def pause_for_pio(self) -> None:
        """Отпустить USB под запись регистров. Консоль не открываем."""
        with self._io:
            self._paused = True
            if self.usb.open:
                self.usb.enable_rx(False)
                self.usb.release()

    def resume_after_pio(self, reconfigure: bool = True) -> None:
        with self._io:
            if not self.usb.open:
                rc = self.usb.acquire(self.device or "")
                if rc != 0:
                    return
                # Повторный set_sample_rate/set_frequency после старта таймера
                # съедает первую стоянку: NIOS в эту же паузу отзывает профиль.
                if reconfigure:
                    self.usb.configure(int(self.lo), int(self.fs), int(self.bw),
                                       self.lna)
                self.usb.arm_meta_stream()
                self.usb.enable_rx(True)
            self._paused = False

    def stop(self) -> None:
        self._stop.set()
        if self._fd is not None:
            try:
                os.close(self._fd)
            except OSError:
                pass
            self._fd = None
        if self._th is not None:
            self._th.join(timeout=3.0)
            self._th = None
        with self._io:
            if self.usb.open:
                self.usb.enable_rx(False)
                self.usb.release()
        if self.src is not None:
            self.src.stop()
            self.src = None
        self.streaming = False

    def read_frame(self, timeout: float = 0.5):
        if self.src is None:
            return None
        try:
            return self.src.frames.get(timeout=timeout)
        except queue.Empty:
            return None


class _UsbHandoff:
    """Регистры FPGA через периферийный USB. Между кадрами владелец снова UsbOwner."""

    def __init__(self, radio: _UsbLive):
        self._radio = radio
        self._br = None

    def _ensure(self):
        if self._br is not None:
            return self._br.fpga
        self._radio.pause_for_pio()
        from . import fpga_control as fc
        br = fc.FpgaBridge()
        br.__enter__()
        self._br = br
        return br.fpga

    def yield_usb(self, reconfigure: bool = True) -> None:
        self.end_tick(reconfigure=reconfigure)

    def end_tick(self, reconfigure: bool = True) -> None:
        if self._br is None:
            return
        try:
            self._br.__exit__(None, None, None)
        finally:
            self._br = None
        self._radio.resume_after_pio(reconfigure=reconfigure)

    def close(self) -> None:
        if self._br is not None:
            try:
                self._br.__exit__(None, None, None)
            finally:
                self._br = None

    def __getattr__(self, name):
        return getattr(self._ensure(), name)


def _run_cognitive_live(args, log: JsonLog, pub: "UdpPublisher | None",
                        fsm=None, stop_event=None) -> int:
    """Живой IQ: UsbOwner → FIFO → C-читатель → спектр кадра → FSM."""
    from .cognitive import CONFIRMING, CognitiveFSM, INITIAL_SCAN, LEARNING
    from .lo_sweep import plan_windows, stitch_power, window_hz
    from .pattern_store import PatternStore
    from . import fpga_control as fc

    span = _corridor_span(args)
    if span is None:
        print("cognitive --live: нужен --corridor F_START F_END",
              file=sys.stderr)
        return 2
    f1, f2 = span
    fs = float(fc.AIR_FS_HZ)
    ibw = window_hz(fc.AIR_FS_HZ)
    # Фильтр платы = окно обхода. 20 МГц здесь оставляло дыры между стоянками.
    args.bw = ibw
    windows = plan_windows(f1, f2, ibw)
    lo = float(windows[0]["f_center"])
    log.write({"kind": "live", "f_start": f1, "f_end": f2,
               "fs_rx_hz": fs, "fpga_fs_hz": fc.AIR_FS_HZ,
               "usb_owner": "libbladeRF",
               "lo_hz": lo, "windows": len(windows),
               "lo_sweep": (f2 - f1) > ibw})
    if not _preflight(args, log):
        return 2
    radio = _UsbLive(args, fs, lo)
    radio.start()
    fpga = _UsbHandoff(radio)
    if fsm is None:
        store = PatternStore()
        fsm = CognitiveFSM(store, args.n_chans, fs, lo, fpga=fpga, pub=pub,
                           radio=_RxProxy(radio), scan_corridor=(f1, f2),
                           frame_dt_s=args.frame_samples / fs,
                           frame_samples=args.frame_samples, ibw_hz=ibw)
    else:
        store = fsm.store
        fsm.lo_hz = lo
        fsm.fs_hz = fs
        fsm.ibw_hz = ibw
        fsm.fpga = fpga
        fsm.pub = pub
        fsm.sweeper.ibw_hz = ibw
        fsm.sweeper.fs_hz = fs
        fsm.sweeper.radio = _RxProxy(radio)
    fsm.usb = radio.usb
    fsm.usb_io = radio
    fsm.fpga_fs_hz = fc.AIR_FS_HZ
    fsm.lna_gain_db = float(getattr(args, "lna", 20))
    frames = 0
    _LIVE["fsm"] = fsm
    _LIVE["radio"] = radio
    paint_q: queue.Queue = queue.Queue(maxsize=1)
    log_q: queue.Queue = queue.Queue(maxsize=64)
    side_stop = threading.Event()
    win_acc: dict = {}

    def _paint_log() -> None:
        while not side_stop.is_set() or not paint_q.empty() or not log_q.empty():
            item = None
            try:
                item = paint_q.get(timeout=0.05)
            except queue.Empty:
                item = None
            if item is not None and pub is not None:
                kind = item[0]
                if kind == "pass":
                    _tag, segments, wins = item
                    stitched = stitch_power(segments, wins, fs)
                    if stitched is not None:
                        row, f_a, f_b = stitched
                        pub.send_wf_row(row, f_start_hz=f_a, f_end_hz=f_b)
                        pub.send_spec(row)
                else:
                    _tag, spec, lo_hz = item
                    spec = np.asarray(spec, dtype=np.float64)
                    half = 0.5 * float(fs)
                    pub.send_wf_row(
                        spec,
                        f_start_hz=float(lo_hz) - half,
                        f_end_hz=float(lo_hz) + half)
                    pub.send_spec(spec)
            try:
                rec_line = log_q.get_nowait()
            except queue.Empty:
                rec_line = None
            if rec_line is not None:
                log.write(rec_line)
            if side_stop.is_set() and paint_q.empty() and log_q.empty():
                break

    side = threading.Thread(target=_paint_log, daemon=True, name="live-paint")
    side.start()
    try:
        radio.start()
        t0 = time.perf_counter()
        while stop_event is None or not stop_event.is_set():
            if stop_event is None and time.perf_counter() - t0 >= args.duration_s:
                break
            if radio.fault == "usb":
                fsm._stop_jam(time.time(), "usb")
                fsm._rescan_origin(time.time(), "usb")
                radio.fault = ""
                break
            fr = radio.read_frame()
            if fr is None:
                if radio.src is not None and radio.src.eof:
                    break
                continue
            iq = np.asarray(fr.complex64())
            nfft = 1024
            rec = {"state": fsm.state, "jams_sent": fsm.jams_sent, "pdr": fsm.eff.pdr}
            if int(iq.size) >= nfft:
                spec = np.asarray(stft_db(iq, nfft, nfft, np), dtype=np.float64)
                lin = np.power(10.0, np.maximum(spec, -120.0) / 10.0)
                n_bins, n_col = lin.shape
                lo_cap = float(fsm.lo_hz)
                freqs = lo_cap + (np.arange(n_bins) - n_bins / 2.0) * (fs / n_bins)
                t0 = float(fr.t_first)
                t1 = float(fr.t_done)
                if t1 <= t0:
                    t1 = t0 + float(iq.size) / fs
                idx_before = int(fsm.sweeper.idx)
                try:
                    for col in range(n_col):
                        t_col = t0 + (col + 1) * (t1 - t0) / n_col
                        if col + 1 == n_col:
                            rec = fsm.tick(lin[:, col], freqs, t_col)
                        else:
                            fsm.hear(lin[:, col], freqs, t_col)
                finally:
                    fpga.end_tick()
                mean = lin.mean(axis=1)
                slot = win_acc.get(idx_before)
                if slot is None:
                    win_acc[idx_before] = [mean, 1, lo_cap]
                else:
                    slot[0] = slot[0] + mean
                    slot[1] += 1
                    slot[2] = lo_cap
                frames += 1
                nwin = len(fsm.sweeper.windows)
                scanning = (nwin > 1 and fsm.state in
                            (INITIAL_SCAN, LEARNING, CONFIRMING))
                idx = int(fsm.sweeper.idx)
                if pub is not None:
                    segments = {
                        int(i): (float(lo_i), np.array(s / c, copy=True))
                        for i, (s, c, lo_i) in win_acc.items() if c
                    }
                    wins = [{
                        "index": int(w["index"]),
                        "f_start": float(w["f_start"]),
                        "f_end": float(w["f_end"]),
                        "f_center": float(w["f_center"]),
                    } for w in fsm.sweeper.windows]
                    item = None
                    if scanning and idx < idx_before and segments:
                        item = ("pass", segments, wins)
                        win_acc.clear()
                    elif scanning and (idx != idx_before or frames % 4 == 0):
                        item = ("pass", segments, wins)
                    elif not scanning:
                        db = 10.0 * np.log10(np.maximum(mean, 1e-12))
                        item = ("live", db, lo_cap)
                        win_acc.clear()
                    if item is not None:
                        if paint_q.full():
                            try:
                                paint_q.get_nowait()
                            except queue.Empty:
                                pass
                        try:
                            paint_q.put_nowait(item)
                        except queue.Full:
                            pass
            else:
                fpga.end_tick()
            try:
                from .test_capture import maybe_save_test
                maybe_save_test(fsm, pub)
            except Exception:
                pass
            if frames % 20 == 0:
                try:
                    log_q.put_nowait({
                        "kind": "tick", "i": frames, "state": rec["state"],
                        "lo_hz": fsm.lo_hz, "fs_hz": fsm.fpga_fs_hz,
                        "jams_sent": rec["jams_sent"], "pdr": rec["pdr"]})
                except queue.Full:
                    pass
        verdict = {
            "live": True, "frames": frames,
            "f_start": f1, "f_end": f2, "lo_hz": fsm.lo_hz,
            "fs_rx_hz": fs, "fpga_fs_hz": fsm.fpga_fs_hz,
            "lo_sweep_windows": len(windows),
            "states_path": [t["to"] for t in fsm.transitions],
            "final_state": fsm.state, "jams_sent": fsm.jams_sent,
            "overruns": int(radio.usb.overruns),
            "usb_owner": "libbladeRF",
        }
        log.write({"kind": "verdict", **verdict})
        print(json.dumps(verdict, ensure_ascii=False, indent=1, default=str))
        return 0
    finally:
        side_stop.set()
        side.join(timeout=0.3)
        try:
            fsm._stop_jam(time.time(), "shutdown")
        except Exception:
            pass
        try:
            fsm.store.save()
        except Exception:
            pass
        fpga.close()
        radio.stop()
        _LIVE.clear()


def live_from_app(app, stop_event) -> int:
    """Тот же UsbOwner, что и --live, в процессе окна."""
    from types import SimpleNamespace
    from .ops import rbf_warning
    note = rbf_warning(Path(__file__).resolve().parents[2])
    if note:
        app._log(note)
    args = SimpleNamespace(
        corridor=(app.cfg["f_start_hz"], app.cfg["f_end_hz"]),
        duration_s=10 ** 9,
        frame_samples=FRAME_SAMPLES,
        n_chans=64,
        taps=8,
        fifo=FIFO_PATH,
        device=None,
        bw=20.0e6,
        lna=int(app.cfg.get("lna_gain_db") or 20),
        mode="cognitive",
    )
    log = JsonLog("gui")
    try:
        return _run_cognitive_live(
            args, log, app.bus.viz, fsm=app.fsm, stop_event=stop_event)
    finally:
        log.close()


def run_cognitive(args, log: JsonLog, pub: "UdpPublisher | None") -> int:
    """Когнитивный контур. --live: FIFO и FPGA. Без флага: синтетика."""
    if getattr(args, "live", False):
        return _run_cognitive_live(args, log, pub)
    from .cognitive import CognitiveFSM
    from .cognitive import LISTENING, MONITORING, TARGET_SILENT
    from .lo_sweep import plan_windows, window_hz
    from .pattern_store import PatternStore
    from .pfb import Channelizer, chans_for_corridor
    from .synth.protocols import _fhss_modulated, FS_DEFAULT
    from .synth import CLASS_LO_HZ
    from . import fpga_control as fc

    fs = FS_DEFAULT
    lo = CLASS_LO_HZ.get(args.protocol, args.freq)
    scan = _corridor_span(args)
    ibw = window_hz(fc.AIR_FS_HZ)
    if scan and (scan[1] - scan[0]) > ibw:
        windows = plan_windows(scan[0], scan[1], ibw)
        log.write({"kind": "lo_sweep", "f_start": scan[0], "f_end": scan[1],
                   "windows": len(windows),
                   "lo_hz": windows[0]["f_center"]})
    p = dict(hop_rate=args.hop_rate, band=(lo - 8e6, lo + 8e6),
             n_hops=args.n_hops, mod="flrc", baud=1.3e6, dev=325e3,
             airtime=400e-6)
    seg1 = _fhss_modulated(args.protocol, p, fs, args.silent_at_s, lo,
                           args.seed, 25.0)["iq"]
    rng = np.random.default_rng(args.seed)
    sil = ((rng.standard_normal(int(fs * (args.reappear_at_s - args.silent_at_s))) +
            1j * rng.standard_normal(int(fs * (args.reappear_at_s - args.silent_at_s))))
           * 1e-3).astype(np.complex64)
    seg3 = _fhss_modulated(args.protocol, p, fs,
                           args.duration_s - args.reappear_at_s, lo,
                           args.seed, 25.0)["iq"]
    iq = np.concatenate([seg1, sil, seg3])

    store = PatternStore()
    from legion_gateway import FakeTransport

    fpga = fc.lf.LegionFpga(FakeTransport(board="bladerf2"))
    ch = Channelizer(args.n_chans, args.taps, xp=np)
    fsm = CognitiveFSM(store, args.n_chans, fs, lo, fpga=fpga, pub=pub,
                       frame_dt_s=args.frame_samples / fs,
                       scan_corridor=scan, frame_samples=args.frame_samples,
                       ibw_hz=ibw)
    fsm.fpga_fs_hz = fc.AIR_FS_HZ
    FRAME = args.frame_samples
    rebuilt = {"done": False}
    synth_lo = float(lo)
    n_fr = len(iq) // FRAME
    for i in range(n_fr):
        if abs(fsm.lo_hz - synth_lo) > 1.0:
            start = i * FRAME
            iq[start:] = _mix_lo_retune(iq[start:], fs, synth_lo, fsm.lo_hz)
            log.write({"kind": "bench_lo_retune", "old_lo_hz": synth_lo,
                       "new_lo_hz": fsm.lo_hz,
                       "mix_df_hz": synth_lo - fsm.lo_hz,
                       "tick": i, "sample": start})
            synth_lo = float(fsm.lo_hz)
            lo = synth_lo
        seg = iq[i * FRAME: (i + 1) * FRAME]
        freqs = np.asarray([ch.channel_freq(k, fs) + fsm.lo_hz
                            for k in range(ch.m)])
        y = ch.channelize(seg)
        rec = fsm.tick(ch.ch_power(y), freqs, (i + 1) * FRAME / fs)
        # адаптивная канализация (ТЗ п.12): n_chans = ширина sub / 200 кГц
        if (not rebuilt["done"]) and fsm.sub is not None:
            width = fsm.sub["f_end"] - fsm.sub["f_start"]
            m = chans_for_corridor(width)
            if m != args.n_chans:
                ch = Channelizer(m, args.taps, xp=np)
                freqs = np.asarray([ch.channel_freq(k, fs) + fsm.lo_hz
                                    for k in range(m)])
                fsm.n_chans = m
                store.n_chans = m
                if fsm.rec is not None:
                    fsm.rec.n_chans = m
                from .hopmap import FallbackPredictor
                fsm.fallback = FallbackPredictor(m, fsm.dt)
                log.write({"kind": "adaptive_grid", "n_chans": m,
                           "width_hz": width, "tick": i})
            rebuilt["done"] = True
        if pub and i % 20 == 0:
            pub.send_ch_pwr(xputil.to_host(ch.ch_power(y)))
        log.write({"kind": "tick", "i": i, "state": rec["state"],
                   "jams_sent": rec["jams_sent"], "pdr": rec["pdr"]})
    verdict = {
        "protocol": args.protocol,
        "frames": n_fr,
        "transitions": fsm.transitions,
        "states_path": [t["to"] for t in fsm.transitions],
        "jams_sent": fsm.jams_sent,
        "patterns": {pid: {"confirmed": r["confirmed"],
                           "sequence_type": r["sequence_type"],
                           "cycle_length": r["cycle_length"],
                           "jammed_count": r["jammed_count"]}
                     for pid, r in store.patterns.items()},
        "final_state": fsm.state,
        "pdr_target": fsm.eff.pdr,
    }
    hit_states = {LISTENING} | set(verdict["states_path"]) | {fsm.state}
    verdict["ok"] = bool({LISTENING, MONITORING, TARGET_SILENT} <= hit_states
                         and fsm.jams_sent >= 1)
    log.write({"kind": "verdict", **verdict})
    print(json.dumps(verdict, ensure_ascii=False, indent=1, default=str))
    return 0 if verdict["ok"] else 2


# ---------------------------------------------------------------- main

def main() -> int:
    from .ops import acquire_lock, install_shutdown, rbf_warning
    acquire_lock()
    install_shutdown(_on_signal)
    note = rbf_warning(Path(__file__).resolve().parents[2])
    if note:
        print(note, file=sys.stderr)
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="mode", required=True)

    def base(p):
        p.add_argument("--fifo", default=FIFO_PATH)
        p.add_argument("--device", default=None)
        p.add_argument("--freq", type=float, default=2400e6)
        p.add_argument("--fs", type=float, default=FS_LAB)
        p.add_argument("--bw", type=float, default=20.0e6)
        p.add_argument("--duration-s", type=float, default=60.0)
        p.add_argument("--frame-samples", type=int, default=FRAME_SAMPLES)
        p.add_argument("--publish", action="store_true",
                       help="публиковать спектр в UDP (окно читает свою шину)")
        p.add_argument("--udp-port", type=int, default=5590)

    def gp(p):
        p.add_argument("--n-chans", type=int, default=64)
        p.add_argument("--taps", type=int, default=8)
        p.add_argument("--cpu", action="store_true",
                       help="отладка без GPU (лаборатория — CuPy)")

    def cl(p):
        p.add_argument("--engine", default=None, help="TensorRT .engine (FP16)")
        p.add_argument("--torch", default=None, help="best.pt (PyTorch)")
        p.add_argument("--labels", default=None, help="labels.json")

    p1 = sub.add_parser("rx-cli", help="шаг 3: приём I/Q, критерий overruns=0/60 с")
    base(p1)
    p2 = sub.add_parser("gpu", help="шаг 4: PFB на GPU, критерий кадр < 5 мс")
    base(p2); gp(p2)
    p3 = sub.add_parser("classify", help="шаг 5: + классификатор")
    base(p3); gp(p3); cl(p3)
    p4 = sub.add_parser("integrate", help="шаг 9: burst-циклы + legion_fpga.py")
    base(p4); gp(p4); cl(p4)
    p4.add_argument("--cycles", type=int, default=3)
    p4.add_argument("--burst-s", type=float, default=2.0)
    p4.add_argument("--profiles", default="elrs_24",
                    help="список классов через запятую (LO по карте 9.3)")
    p4.add_argument("--fixed-profile", action="store_true",
                    help="не брать профиль из классификатора")
    p5 = sub.add_parser("bench", help="офлайн-проверка критериев без железа")
    p5.add_argument("--protocol", default="elrs_24")
    p5.add_argument("--fs", type=float, default=FS_LAB)
    p5.add_argument("--freq", type=float, default=2400e6)
    p5.add_argument("--duration-s", type=float, default=0.5)
    p5.add_argument("--seed", type=int, default=7)
    p5.add_argument("--frame-samples", type=int, default=FRAME_SAMPLES)
    p5.add_argument("--n-chans", type=int, default=64)
    p5.add_argument("--taps", type=int, default=8)
    p5.add_argument("--cpu", action="store_true")
    p5.add_argument("--publish", action="store_true")
    p5.add_argument("--udp-port", type=int, default=5590)
    cl(p5)
    p6 = sub.add_parser("cognitive",
                        help="FHSS-память: синтетика или --live FIFO")
    p6.add_argument("--protocol", default="elrs_24")
    p6.add_argument("--freq", type=float, default=2400e6)
    p6.add_argument("--hop-rate", type=float, default=1000.0)
    p6.add_argument("--n-hops", type=int, default=12)
    p6.add_argument("--duration-s", type=float, default=1.0)
    p6.add_argument("--silent-at-s", type=float, default=0.45)
    p6.add_argument("--reappear-at-s", type=float, default=0.70)
    p6.add_argument("--seed", type=int, default=11)
    p6.add_argument("--frame-samples", type=int, default=FRAME_SAMPLES)
    p6.add_argument("--n-chans", type=int, default=64)
    p6.add_argument("--taps", type=int, default=8)
    p6.add_argument("--publish", action="store_true")
    p6.add_argument("--udp-port", type=int, default=5590)
    p6.add_argument("--scan-start", type=float, default=None)
    p6.add_argument("--scan-end", type=float, default=None)
    p6.add_argument("--corridor", nargs=2, metavar=("F_START", "F_END"),
                    help="коридор: 2400 2483 = МГц, либо Гц если ≥ 1e6")
    p6.add_argument("--live", action="store_true",
                    help="живой IQ с bladeRF-cli, не синтетика")
    p6.add_argument("--samplerate", default="20M",
                    help="RX samplerate живого режима")
    p6.add_argument("--fifo", default=FIFO_PATH,
                    help="FIFO bladeRF-cli (по умолчанию /tmp/iq)")
    p6.add_argument("--device", default=None)
    p6.add_argument("--bw", type=float, default=20.0e6)

    args = ap.parse_args()
    log = JsonLog(args.mode)
    pub = UdpPublisher(port=args.udp_port) if getattr(args, "publish", False) else None
    try:
        fn = {"rx-cli": run_rx_cli, "gpu": run_gpu, "classify": run_classify,
              "integrate": run_integrate, "bench": run_bench,
              "cognitive": run_cognitive}[args.mode]
        return fn(args, log, pub)
    finally:
        log.close()
        if pub:
            pub.close()


if __name__ == "__main__":
    raise SystemExit(main())
