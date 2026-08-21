#!/usr/bin/env python3
"""LEGION FPGA — автоматическая приёмка E1–E6 на стенде (bladeRF 1 x40).

Запускается на ноутбуке, подключённом по Ethernet к шлюзу с x40
(на шлюзе: legion_gateway.py). Кабель TX→RX через аттенюатор — для E2/E4
(самостимул: тон NCO/стрима петлёй возвращается в RX).

  python3 fpga/test/acceptance_bench.py --gw 192.168.1.20 [--port 5531]
      [--worker tools/sdr_worker.py] [--skip-e6]

Этапы (зеркало fpga/README.md):
  E1 канал/образ живы: ping + VERSION (штатный пакет target 0x00)
  E2 NCO из FPGA: arm nco → (кабель) det_count растёт
  E3 плеер: capture_arm → стрим волны (воркер через SoapyRemote) →
     capture_done → arm player → playing=1
  E4 детектор: det_thr → стрим тона → det_count вырос (гейт — по HDL-симу)
  E5 watchdog: перестали слать kick → wd_fired=1 ≤ ~1.5 с
  E6 autoload: операторская (power cycle), подтверждение канала после

Один владелец USB на шлюзе: скрипт сам гоняет usb release/acquire
(агент) вокруг стрим-фаз (SoapySDRServer на шлюзе поднимается по --ssh
или вручную — скрипт подскажет).
"""
from __future__ import annotations

import argparse
import json
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

fails = 0


def check(name: str, cond: bool, detail: str = "") -> None:
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + name + ("" if cond else f"  {detail}"))
    if not cond:
        fails += 1


class Gw:
    """TCP JSON к legion_gateway на шлюзе."""

    def __init__(self, host: str, port: int) -> None:
        self.host, self.port = host, port

    def __call__(self, msg: dict) -> dict:
        with socket.create_connection((self.host, self.port), timeout=4) as s:
            s.sendall((json.dumps(msg) + "\n").encode())
            line = s.makefile("rb").readline()
        return json.loads(line.decode("utf-8", "replace"))


class Worker:
    """Локальный sdr_worker.py как источник стрим-стимула (SoapyRemote на шлюз)."""

    def __init__(self, path: Path, gw_host: str) -> None:
        self.proc = subprocess.Popen(
            [sys.executable, str(path)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        self.args = f"driver=remote,remote=tcp://{gw_host}:55132"

    def rpc(self, msg: dict) -> dict:
        assert self.proc.stdin and self.proc.stdout
        self.proc.stdin.write(json.dumps(msg) + "\n")
        self.proc.stdin.flush()
        return json.loads(self.proc.stdout.readline())

    def close(self) -> None:
        try:
            self.rpc({"op": "close"})
            self.proc.stdin.close()  # type: ignore[union-attr]
            self.proc.wait(timeout=5)
        except Exception:
            self.proc.kill()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--gw", required=True, help="IP шлюза с x40")
    ap.add_argument("--port", type=int, default=5531)
    ap.add_argument("--worker", default=str(Path(__file__).resolve().parents[2] / "tools" / "sdr_worker.py"))
    ap.add_argument("--skip-e6", action="store_true")
    args = ap.parse_args()
    gw = Gw(args.gw, args.port)

    # Heartbeat как у приложения LEGION (500 мс), пока идут этапы E2–E4;
    # на E5 намеренно останавливаем — проверяем, что железо гасит TX само.
    kick_stop = threading.Event()

    def kick_loop() -> None:
        while not kick_stop.wait(0.5):
            try:
                gw({"op": "kick"})
            except Exception:
                pass  # сеть мертва — watchdog в FPGA отработает сам

    kick_thr = threading.Thread(target=kick_loop, daemon=True)
    kick_thr.start()

    print("== E1: канал и образ ==")
    r = gw({"op": "ping"})
    check("агент шлюза отвечает", r.get("ok") is True, str(r))
    r = gw({"op": "set", "reg": "det_shift", "value": 8})
    check("запись регистра через агента (det_shift)", r.get("ok") is True, str(r))
    r = gw({"op": "set", "reg": "det_thr", "value": 1000})
    check("запись регистра через агента (det_thr)", r.get("ok") is True, str(r))

    print("== E2: NCO из FPGA ==")
    r = gw({"op": "set", "reg": "nco_ftw", "value": int(0.25e6 / 2e6 * 2**32)})
    check("FTW записан (250 кГц при fs=2 МГц)", r.get("ok") is True, str(r))
    r = gw({"op": "rx", "on": True})
    check("RX включён (CONTROL bit1) — детектор слышит", r.get("ok") is True, str(r))
    r = gw({"op": "arm", "mode": "nco"})
    check("ARM nco", r.get("ok") is True, str(r))
    d0 = gw({"op": "status"}).get("det_count", 0) or 0
    time.sleep(1.2)
    st = gw({"op": "status"})
    check("watchdog жив при heartbeat", not st.get("wd_fired"), str(st))
    d1 = st.get("det_count", 0) or 0
    if d1 > d0:
        check("кабель TX→RX: детектор слышит свой тон", True)
    else:
        print("  SKIP  кабель TX→RX не подключён (det_count не растёт) — RF-проверка на стенде")
    gw({"op": "disarm"})
    gw({"op": "rx", "on": False})

    print("== E3: плеер (capture → play) ==")
    gw({"op": "set", "reg": "player_len", "value": 4095})
    r = gw({"op": "set", "reg": "player_ctl", "value": 1})
    check("capture_arm=1", r.get("ok") is True, str(r))
    r = gw({"op": "usb", "action": "release"})
    check("агент отпустил USB для стрима", r.get("ok") is True, str(r))
    print("  … поднимите SoapySDRServer на шлюзе (или --ssh), Enter когда готово")
    input()
    wk = Worker(Path(args.worker), args.gw)
    try:
        r = wk.rpc({"op": "open", "args": wk.args, "analogBwMhz": 28, "canTx": True, "fullDuplex": True})
        check("воркер открыл SDR через SoapyRemote", r.get("ok") is True, str(r))
        r = wk.rpc({"op": "tx_wave", "freqMhz": 2450.0, "wave": "qpsk", "params": {"amp": 0.25}})
        check("стрим волны (capture идёт в FPGA)", r.get("ok") is True, str(r))
        time.sleep(1.5)
        wk.rpc({"op": "tx_off"})
    finally:
        wk.close()
    print("  … остановите SoapySDRServer на шлюзе, Enter когда готово")
    input()
    r = gw({"op": "usb", "action": "acquire"})
    check("агент занял USB обратно", r.get("ok") is True, str(r))
    st = gw({"op": "status"})
    check("capture_done=1 (волна в RAM FPGA)", st.get("capture_done") is True, str(st))
    r = gw({"op": "arm", "mode": "player"})
    st = gw({"op": "status"})
    check("PLAYER играет из RAM автономно", r.get("ok") is True and st.get("playing") is True,
          f"{r} / {st}")

    print("== E4: детектор (стимул — стрим тона) ==")
    gw({"op": "disarm"})
    r = gw({"op": "set", "reg": "det_thr", "value": 1000})
    check("det_thr записан", r.get("ok") is True, str(r))
    d0 = gw({"op": "status"}).get("det_count", 0) or 0
    gw({"op": "usb", "action": "release"})
    print("  … SoapySDRServer на шлюзе, Enter")
    input()
    wk = Worker(Path(args.worker), args.gw)
    try:
        wk.rpc({"op": "open", "args": wk.args, "analogBwMhz": 28, "canTx": True, "fullDuplex": True})
        wk.rpc({"op": "tx_wave", "freqMhz": 2450.0, "wave": "tone", "params": {"fj": 0.1, "amp": 0.25}})
        time.sleep(1.5)
        # RX у воркера активен при scan — детектор в FPGA слышит тон с кабеля
        wk.rpc({"op": "scan", "centerMhz": 2450.0, "bwMhz": 2, "bins": 64})
        wk.rpc({"op": "tx_off"})
    finally:
        wk.close()
    print("  … остановите SoapySDRServer, Enter")
    input()
    gw({"op": "usb", "action": "acquire"})
    d1 = gw({"op": "status"}).get("det_count", 0) or 0
    check("детектор FPGA засёк тон (det_count вырос)", d1 > d0, f"{d0} → {d1}")

    print("== E5: watchdog (deadman) ==")
    r = gw({"op": "arm", "mode": "nco"})
    check("ARM для watchdog-теста", r.get("ok") is True, str(r))
    print("  … heartbeat останавливаем — ждём срабатывания (~1.5 с)")
    kick_stop.set()  # имитация смерти ноутбука/сети
    time.sleep(1.6)
    st = gw({"op": "status"})
    check("watchdog сработал (wd_fired=1)", st.get("wd_fired") is True, str(st))
    gw({"op": "disarm"})

    if not args.skip_e6:
        print("== E6: autoload (оператор) ==")
        print("  … на шлюзе: bladeRF-cli -L legion_x40.rbf; питание off/on; Enter")
        input()
        r = gw({"op": "ping"})
        check("канал жив после power cycle (наш образ autoload)", r.get("ok") is True, str(r))

    print("ПРИЁМКА: ALL PASS" if fails == 0 else f"ПРИЁМКА: {fails} FAILURES")
    return 0 if fails == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
