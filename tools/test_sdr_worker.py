#!/usr/bin/env python3
"""Протокол sdr_worker без железа: FAKE + ping + Soapy-факты."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WORKER = ROOT / "sdr_worker.py"


def rpc(proc: subprocess.Popen[str], msg: dict) -> dict:
    proc.stdin.write(json.dumps(msg) + "\n")
    proc.stdin.flush()
    line = proc.stdout.readline()
    return json.loads(line)


def main() -> int:
    env = os.environ.copy()
    env["LEGION_SDR_FAKE"] = "1"
    env["LEGION_FPGA_PORT"] = "5599"  # порт FPGA-агента в этом тесте
    proc = subprocess.Popen(
        [sys.executable, str(WORKER)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
        env=env,
    )
    assert proc.stdin and proc.stdout
    fails = 0

    def check(name: str, cond: bool) -> None:
        nonlocal fails
        print(("  PASS  " if cond else "  FAIL  ") + name)
        if not cond:
            fails += 1

    sys.path.insert(0, str(ROOT))
    import sdr_worker as w

    check("SoapyRemote args", w.parse_args("driver=remote,remote=tcp://10.0.0.5:55132") == {
        "driver": "remote",
        "remote": "tcp://10.0.0.5:55132",
    })
    check("LO = RF − fs/8 (Deepwave)", abs(w.cw_lo_hz(2442e6) - (2442e6 - w.TX_FS / 8)) < 1)

    to = w.stream_timeout_us(w.TX_N, w.TX_FS)
    block_us = w.TX_N / w.TX_FS * 1e6
    check("timeout ≥ 1s (не дефолт Soapy 100ms)", to >= 1_000_000)
    check("timeout ≥ 4× блока", to >= 4 * block_us - 1)

    check("stream_ret объект", w.stream_ret(type("S", (), {"ret": 4096})()) == 4096)
    check("stream_ret int (старый биндинг)", w.stream_ret(-1) == -1)
    check("stream_kind timeout", w.stream_kind(-1) == "timeout")
    check("stream_kind overflow", w.stream_kind(-4) == "overflow")
    check("stream_kind underflow", w.stream_kind(-7) == "underflow")
    check("stream_kind error", w.stream_kind(-2) == "error")
    check("stream_kind ok", w.stream_kind(4096) == "ok")

    if w.NUMPY:
        import numpy as np

        tone = w.make_cw()
        check("CW не DC", abs(complex(tone[0]) - complex(tone[1])) > 1e-6)
        check("CW длина кратна 8", len(tone) % 8 == 0)
        check("CW пик ~amp", abs(abs(complex(tone[0])) - 0.25) < 0.02)
        freqs = np.linspace(2440, 2444, 1024)
        db = np.linspace(-90, -40, 1024)
        pooled = w._pool_bins(freqs, db, 64)
        check("pool 1024→64", len(pooled) == 64)
        check("pool берёт max", pooled[-1]["powerDbm"] > pooled[0]["powerDbm"])
        check("scan() не зовёт _read_fft", not hasattr(w, "_read_fft"))
        check("AGC в коде выкл", "setGainMode(SOAPY_SDR_RX, 0, False)" in open(WORKER).read())
        check("AGC True не пишем", "setGainMode(SOAPY_SDR_RX, 0, True)" not in open(WORKER).read())
        check("fs скана 40e6", w.SCAN_FS_HZ == 40e6 and w.WELCH_FRAMES == 8)
        check("x40 fs ≤ 28 МГц", w.scan_fs_hz(28) == 28e6)
        check("xa4 fs = 40 МГц", w.scan_fs_hz(56) == 40e6)
        nfft = 64
        t = np.arange(nfft)
        tone = np.exp(1j * 2 * np.pi * 8 * t / nfft)
        frames = [tone] * w.WELCH_FRAMES
        spec = w.welch_dbm(frames, 40e6, 2442.0)
        check("welch полный FFT, не pool", len(spec) == nfft)
        mid = nfft // 2
        check("DC-бин = среднее соседей", abs(spec[mid]["powerDbm"] - 0.5 * (spec[mid - 1]["powerDbm"] + spec[mid + 1]["powerDbm"])) < 1e-9)
        check("ось частот: центр после fftshift", abs(spec[mid]["freqMhz"] - 2442.0) < 40e6 / nfft / 1e6 + 1e-6)
        win = w.hann_window(8)
        expect = 0.5 * (1.0 - np.cos(2.0 * np.pi * np.arange(8) / 7))
        check("Hann 0.5·(1−cos)", np.allclose(win, expect))
        check("слив 32×4096", w.DISCARD_CHUNKS * w.RING_CHUNK == 32 * 4096)

        # --- ТИП СИГНАЛА: синтез всех волн ---
        all_ok = True
        for kind in w.WAVE_KINDS:
            buf = w.make_waveform(kind)
            if (
                len(buf) == 0
                or str(buf.dtype) != "complex64"
                or not np.isfinite(buf.real).all()
                or not np.isfinite(buf.imag).all()
                or float(np.max(np.abs(buf))) > 0.9 + 1e-6
            ):
                all_ok = False
                print(f"    … плохой буфер: {kind}")
        check("31 волна: complex64, finite, пик ≤ amp", all_ok)
        check("каталог: 31 тип", len(w.WAVE_KINDS) == 31)

        # Постоянная огибающая у CPM/чирп-волн (GMSK, Zadoff-Chu, P4)
        for kind in ("gmsk", "gfsk", "zadoffchu", "p4", "fsk4", "mfsk8"):
            env = np.abs(w.make_waveform(kind))
            ripple = float(np.max(env) - np.min(env[env > 0])) if np.any(env > 0) else 9.0
            if ripple > 0.05:
                all_ok = False
                print(f"    … огибающая не постоянна: {kind} ripple={ripple:.4f}")
        check("GMSK/GFSK/ZC/P4/xFSK: постоянная огибающая (±0.05)", all_ok)

        # 16-APSK: два кольца с отношением радиусов 2.73
        apsk = w._apsk16_symbols(4096, 7)
        rings = sorted(set(np.round(np.abs(apsk), 3)))
        check("16-APSK: два кольца", len(rings) == 2)
        if len(rings) == 2:
            check("16-APSK: γ ≈ 2.73", abs(rings[1] / rings[0] - 2.73) < 0.05)

        # Zadoff-Chu: идеальная периодическая АКФ (боковые ~0)
        zc = w.make_waveform("zadoffchu", n=631)
        ac = np.abs(np.fft.ifft(np.abs(np.fft.fft(zc)) ** 2))
        check("ZC: АКФ ≈ дельта (боковые < 1%)", float(np.max(ac[1:])) < 0.01 * float(ac[0]))

        tbuf = w.make_waveform("tone", pr={"fj": 0.1})
        fax = np.fft.fftfreq(len(tbuf), 1.0 / w.TX_FS)
        peak_hz = fax[int(np.argmax(np.abs(np.fft.fft(tbuf))))]
        check("тон Fj=0.1 → пик на +200 кГц", abs(peak_hz - 0.1 * w.TX_FS) < 2e3)

        ph4 = set(np.round(np.angle(w._psk_symbols(256, 4, 1)), 3))
        check("QPSK: 4 фазы (π/4 + k·π/2)", len(ph4) == 4)
        m = w._mseq31()
        check("m-seq Gp=31: длина и баланс ±1", len(m) == 31 and abs(int(m.sum())) == 1)

        # Циклический RRC: стык петли не хуже середины (нет скачка огибающей)
        q = w.make_waveform("qpsk")
        env = np.abs(q)
        edge = max(float(env[0]), float(env[-1]))
        mid = float(np.max(env[len(env) // 4 : 3 * len(env) // 4]))
        check("QPSK петля: край в пределах огибающей", edge <= mid + 1e-6)

        bad_params = w.make_waveform("qpsk", pr={"amp": 99, "alpha": -1})
        check("параметры клампятся (amp ≤ 0.9)", float(np.max(np.abs(bad_params))) <= 0.9 + 1e-6)

    ping = rpc(proc, {"op": "ping"})
    check("ping ok", ping.get("ok") is True)
    check("fake flag", ping.get("fake") is True)
    check("ping txLive false", ping.get("txLive") is False)

    opened = rpc(proc, {"op": "open", "args": "driver=fake", "analogBwMhz": 56, "canTx": True})
    check("fake open", opened.get("ok") is True)

    scan = rpc(proc, {"op": "scan", "centerMhz": 2442, "bwMhz": 20, "bins": 32})
    check("scan bins", scan.get("ok") is True and len(scan.get("bins") or []) == 32)
    check("scan freqs", abs(scan["bins"][16]["freqMhz"] - 2442) < 2)
    check("fake span = ADC 40 МГц, не окно 20", abs(scan["bins"][-1]["freqMhz"] - scan["bins"][0]["freqMhz"] - 40) < 1.5)

    class _TimeoutDev:
        def readStream(self, *a, **k):
            return type("S", (), {"ret": -1})()

    stuck = w.Radio()
    stuck.dev = _TimeoutDev()
    stuck.rx = object()
    stuck._discard_left = 4096
    try:
        stuck._wait_psd(4e6)
        drain_ok = False
    except RuntimeError as e:
        drain_ok = "слив" in str(e)
    check("неполный слив → отказ, не Welch на старом IQ", drain_ok)

    hd = w.Radio()
    hd.fake = True
    hd.full_duplex = False
    hd.tx_mhz = 2442.0
    paused = hd.scan(2442, 20, 16)
    check("half-duplex RX пауза при TX", paused.get("ok") is True and paused.get("bins") == [])

    # --- _ensure_rx: кэш rate/bw/center, deactivate только при смене rate ---
    class _MockDev:
        def __init__(self):
            self.calls = {"rate": 0, "bw": 0, "freq": 0, "setup": 0, "act": 0, "deact": 0}
        def setSampleRate(self, d, c, v): self.calls["rate"] += 1
        def setBandwidth(self, d, c, v): self.calls["bw"] += 1
        def setFrequency(self, d, c, v): self.calls["freq"] += 1
        def setupStream(self, d, f): self.calls["setup"] += 1; return object()
        def activateStream(self, s): self.calls["act"] += 1
        def deactivateStream(self, s): self.calls["deact"] += 1

    md = w.Radio()
    md.dev = _MockDev()
    md._ensure_rx(4e6, 2454e6)
    md._ensure_rx(4e6, 2454e6)  # тот же тик — без перестройки
    check("кэш rate: 2-й тик без setSampleRate", md.dev.calls["rate"] == 1)
    check("кэш center: 2-й тик без setFrequency", md.dev.calls["freq"] == 1)
    md._ensure_rx(4e6, 2455e6)  # смена center — только LO, поток жив
    check("смена center: setFrequency снова", md.dev.calls["freq"] == 2)
    check("смена center: rate не тронут", md.dev.calls["rate"] == 1)
    check("смена center: поток не останавливался", md.dev.calls["deact"] == 0)
    md._ensure_rx(1e6, 2455e6)  # смена fs — deactivate → перестройка → activate
    check("смена fs: deactivate перед перестройкой", md.dev.calls["deact"] == 1)
    check("смена fs: setSampleRate снова", md.dev.calls["rate"] == 2)
    check("смена fs: activate после", md.dev.calls["act"] == 2)

    tx = rpc(proc, {"op": "tx", "freqMhz": 2442.5})
    check("tx ok", tx.get("ok") is True and tx.get("freqMhz") == 2442.5)
    check("tx latency число", isinstance(tx.get("latencyUs"), int))

    wave = rpc(proc, {"op": "tx_wave", "freqMhz": 2442.0, "wave": "qpsk", "params": {"amp": 0.2}})
    check("tx_wave qpsk ok (fake)", wave.get("ok") is True and wave.get("freqMhz") == 2442.0)

    bad_wave = rpc(proc, {"op": "tx_wave", "freqMhz": 2442.0, "wave": "nonsense"})
    check("tx_wave неизвестный тип → отказ", bad_wave.get("ok") is False)

    wave_live = rpc(proc, {"op": "ping"})
    check("tx_wave → txLive", wave_live.get("txLive") is True)

    live = rpc(proc, {"op": "scan", "centerMhz": 2442, "bwMhz": 20, "bins": 8})
    check("scan несёт txLive после TX", live.get("txLive") is True)

    off = rpc(proc, {"op": "tx_off"})
    check("tx_off", off.get("ok") is True)

    after = rpc(proc, {"op": "ping"})
    check("после tx_off не live", after.get("txLive") is False)

    bad = rpc(proc, {"op": "nope"})
    check("unknown op", bad.get("ok") is False)

    # --- FPGA-релей: воркер → legion_gateway (FAKE) по TCP ---
    import threading
    gw_env = os.environ.copy()
    gw_env["LEGION_FPGA_FAKE"] = "1"
    gw_env["LEGION_FPGA_PORT"] = "5599"
    gw = subprocess.Popen(
        [sys.executable, str(ROOT.parent / "fpga" / "host" / "legion_gateway.py")],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=gw_env,
    )
    try:
        time.sleep(1.0)  # агент поднимается
        pong = rpc(proc, {"op": "fpga", "cmd": {"op": "ping"}, "gw": "127.0.0.1"})
        check("fpga relay ping через шлюз", pong.get("ok") is True and pong.get("fake") is True)

        arm = rpc(proc, {"op": "fpga", "cmd": {"op": "arm", "mode": "player"}, "gw": "127.0.0.1"})
        check("fpga relay arm player", arm.get("ok") is True)

        st = rpc(proc, {"op": "fpga", "cmd": {"op": "status"}, "gw": "127.0.0.1"})
        check("fpga relay status playing", st.get("ok") is True and st.get("playing") is True)

        off = rpc(proc, {"op": "fpga", "cmd": {"op": "disarm"}, "gw": "127.0.0.1"})
        check("fpga relay disarm", off.get("ok") is True)
    finally:
        gw.terminate()
        gw.wait(timeout=5)

    # Агент остановлен → честный отказ (не молчание и не фейк-успех)
    nogw = rpc(proc, {"op": "fpga", "cmd": {"op": "ping"}, "gw": "127.0.0.1"})
    check("fpga relay без агента → честный отказ", nogw.get("ok") is False)

    rpc(proc, {"op": "close"})
    proc.stdin.close()
    proc.wait(timeout=5)
    print("WORKER: ALL PASS" if fails == 0 else f"WORKER: {fails} FAILURES")
    return 0 if fails == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
