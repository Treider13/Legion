#!/usr/bin/env python3
"""Протокол sdr_worker без железа: FAKE + ping + Soapy-факты."""
from __future__ import annotations

import json
import os
import subprocess
import sys
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
        check("16 волн: complex64, finite, пик ≤ amp", all_ok)

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

    hd = w.Radio()
    hd.fake = True
    hd.full_duplex = False
    hd.tx_mhz = 2442.0
    paused = hd.scan(2442, 20, 16)
    check("half-duplex RX пауза при TX", paused.get("ok") is True and paused.get("bins") == [])

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

    rpc(proc, {"op": "close"})
    proc.stdin.close()
    proc.wait(timeout=5)
    print("WORKER: ALL PASS" if fails == 0 else f"WORKER: {fails} FAILURES")
    return 0 if fails == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
