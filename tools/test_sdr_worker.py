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
        tone = w.make_cw()
        check("CW не DC", abs(complex(tone[0]) - complex(tone[1])) > 1e-6)
        check("CW длина кратна 8", len(tone) % 8 == 0)
        check("CW пик ~amp", abs(abs(complex(tone[0])) - 0.25) < 0.02)
        freqs = __import__("numpy").linspace(2440, 2444, 1024)
        db = __import__("numpy").linspace(-90, -40, 1024)
        pooled = w._pool_bins(freqs, db, 64)
        check("pool 1024→64", len(pooled) == 64)
        check("pool берёт max", pooled[-1]["powerDbm"] > pooled[0]["powerDbm"])

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
