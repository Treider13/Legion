#!/usr/bin/env python3
"""Протокол sdr_worker без железа: FAKE + ping."""
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

    ping = rpc(proc, {"op": "ping"})
    check("ping ok", ping.get("ok") is True)
    check("fake flag", ping.get("fake") is True)

    opened = rpc(proc, {"op": "open", "args": "driver=fake", "analogBwMhz": 56, "canTx": True})
    check("fake open", opened.get("ok") is True)

    scan = rpc(proc, {"op": "scan", "centerMhz": 2442, "bwMhz": 20, "bins": 32})
    check("scan bins", scan.get("ok") is True and len(scan.get("bins") or []) == 32)
    check("scan freqs", abs(scan["bins"][16]["freqMhz"] - 2442) < 2)

    tx = rpc(proc, {"op": "tx", "freqMhz": 2442.5})
    check("tx ok", tx.get("ok") is True and tx.get("freqMhz") == 2442.5)
    check("tx latency число", isinstance(tx.get("latencyUs"), int))

    off = rpc(proc, {"op": "tx_off"})
    check("tx_off", off.get("ok") is True)

    bad = rpc(proc, {"op": "nope"})
    check("unknown op", bad.get("ok") is False)

    rpc(proc, {"op": "close"})
    proc.stdin.close()
    proc.wait(timeout=5)
    print("WORKER: ALL PASS" if fails == 0 else f"WORKER: {fails} FAILURES")
    return 0 if fails == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
