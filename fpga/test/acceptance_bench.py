#!/usr/bin/env python3
"""LEGION FPGA — автоматическая приёмка E1–E6 на стенде (bladeRF 1 x40 и
bladeRF 2.0 micro xA4/xA9).

Запускается на ноутбуке, подключённом по Ethernet к шлюзу с платой
(на шлюзе: legion_gateway.py). Кабель TX→RX через аттенюатор — для E2/E4
(самостимул: тон NCO/стрима петлёй возвращается в RX).

Плата: --board x40|micro; по умолчанию авто-детект — агент отвечает
board в ping (bladerf1 = x40, bladerf2 = micro). Отличия micro (AD9361):
«rx on» не существует (CONTROL там нет — RX поднимает AIR_PREP записью
регистра), ARM требует freq_mhz, первый ARM после питания длиннее
(полный ad9361_init в NIOS — таймаут AIR_PREP у шлюза 10 с).

  python3 fpga/test/acceptance_bench.py --gw 192.168.1.20 [--port 5531]
      [--board micro] [--worker tools/sdr_worker.py] [--skip-e6]
      [--ssh user@шлюз] [--non-interactive] [--out results/acceptance.json]

Автоматизация стенда:
  --ssh user@host   SoapySDRServer на шлюзе поднимается/гасится по ssh
                    (без ключа — операторские паузы Enter, как раньше).
  --non-interactive без пауз Enter вообще: без --ssh стрим-фазы E3/E4
                    честно упадут, если SoapySDRServer не поднят заранее.
  --out PATH        JSON-отчёт приёмки (этапы, PASS/FAIL, латентность
                    watchdog, плата, время) — артефакт готовности xA4.

Этапы (зеркало fpga/README.md):
  E1 канал/образ живы: ping + VERSION (штатный пакет target 0x00)
  E2 NCO из FPGA: arm nco → (кабель) det_count растёт
     (micro: arm nco с freq_mhz поднимает AIR_PREP up+TX, RX дожимается
      записью air_prep=0x7 — CONTROL на micro не существует)
  E3 плеер: capture_arm → стрим волны (воркер через SoapyRemote) →
     capture_done → arm player → playing=1
  E4 детектор: det_thr → стрим тона → det_count вырос (гейт — по HDL-симу)
  E5 watchdog: перестали слать kick → wd_fired=1 (латентность меряется:
     x40 ~1.0 с, micro ~2.0 с при дефолтном WD_LIMIT=61 — tx_clock=fs)
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
# Протокол приёмки для JSON-отчёта: (этап, имя, ok, detail).
results: list[dict] = []
stage = ""


def check(name: str, cond: bool, detail: str = "") -> None:
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + name + ("" if cond else f"  {detail}"))
    results.append({"stage": stage, "name": name, "ok": bool(cond),
                    **({"detail": detail} if detail and not cond else {})})
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
    global stage
    ap = argparse.ArgumentParser()
    ap.add_argument("--gw", required=True, help="IP шлюза с платой")
    ap.add_argument("--port", type=int, default=5531)
    ap.add_argument("--board", choices=("x40", "micro"), default="",
                    help="плата на шлюзе; пусто = авто-детект по ping.board")
    ap.add_argument("--worker", default=str(Path(__file__).resolve().parents[2] / "tools" / "sdr_worker.py"))
    ap.add_argument("--skip-e6", action="store_true")
    ap.add_argument("--ssh", default="", metavar="USER@HOST",
                    help="шлюз по ssh: SoapySDRServer поднимается/гасится сам")
    ap.add_argument("--non-interactive", action="store_true",
                    help="без пауз Enter (без --ssh стрим-фазы требуют заранее поднятый SoapySDRServer)")
    ap.add_argument("--out", default="", metavar="PATH",
                    help="JSON-отчёт приёмки (артефакт готовности платы)")
    args = ap.parse_args()
    gw = Gw(args.gw, args.port)

    def soapy_server(up: bool) -> None:
        """SoapySDRServer на шлюзе: по ssh — сами, иначе пауза оператора."""
        action = "поднимите" if up else "остановите"
        if args.ssh:
            cmd = ("pgrep -x SoapySDRServer >/dev/null || "
                   "(nohup SoapySDRServer --bind >/tmp/soapysdr.log 2>&1 &)") if up \
                else "pkill -x SoapySDRServer || true"
            cp = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5",
                                 args.ssh, cmd], capture_output=True, text=True, timeout=30)
            if cp.returncode != 0:
                print(f"  ВНИМАНИЕ: ssh {action} SoapySDRServer: {cp.stderr.strip() or cp.stdout.strip()}")
            time.sleep(1.5 if up else 0.5)
            return
        if args.non_interactive:
            print(f"  … --non-interactive: SoapySDRServer на шлюзе должен быть "
                  f"{'поднят' if up else 'остановлен'} заранее")
            return
        print(f"  … {action} SoapySDRServer на шлюзе (или --ssh), Enter когда готово")
        input()

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

    stage = "E1"
    print("== E1: канал и образ ==")
    r = gw({"op": "ping"})
    check("агент шлюза отвечает", r.get("ok") is True, str(r))
    board = args.board or ("micro" if r.get("board") == "bladerf2" else "x40")
    print(f"  плата: {board}" + (" (авто-детект по ping)" if not args.board else ""))
    # micro: ARM без freq_mhz честно отказывает (LO для AD9361 обязателен).
    arm_freq = {"freq_mhz": 2450.0} if board == "micro" else {}
    r = gw({"op": "set", "reg": "det_shift", "value": 8})
    check("запись регистра через агента (det_shift)", r.get("ok") is True, str(r))
    r = gw({"op": "set", "reg": "det_thr", "value": 1000})
    check("запись регистра через агента (det_thr)", r.get("ok") is True, str(r))

    stage = "E2"
    print("== E2: NCO из FPGA ==")
    r = gw({"op": "set", "reg": "nco_ftw", "value": int(0.25e6 / 2e6 * 2**32)})
    check("FTW записан (250 кГц при fs=2 МГц)", r.get("ok") is True, str(r))
    if board == "micro":
        # CONTROL на micro не существует: ARM nco поднимает AIR_PREP up+TX,
        # RX для детектора дожимаем записью AIR_PREP up+RX+TX (NIOS, тёплый
        # подъём — freq/fs/BW статики уже заданы ARM'ом).
        r = gw({"op": "arm", "mode": "nco", **arm_freq})
        check("ARM nco (micro: freq_mhz обязателен)", r.get("ok") is True, str(r))
        r = gw({"op": "set", "reg": "air_prep", "value": 0x7})
        check("micro: AIR_PREP up+RX+TX — детектор слышит", r.get("ok") is True, str(r))
    else:
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
    if board != "micro":
        gw({"op": "rx", "on": False})

    stage = "E3"
    print("== E3: плеер (capture → play) ==")
    gw({"op": "set", "reg": "player_len", "value": 4095})
    r = gw({"op": "set", "reg": "player_ctl", "value": 1})
    check("capture_arm=1", r.get("ok") is True, str(r))
    r = gw({"op": "usb", "action": "release"})
    check("агент отпустил USB для стрима", r.get("ok") is True, str(r))
    soapy_server(up=True)
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
    soapy_server(up=False)
    r = gw({"op": "usb", "action": "acquire"})
    check("агент занял USB обратно", r.get("ok") is True, str(r))
    st = gw({"op": "status"})
    check("capture_done=1 (волна в RAM FPGA)", st.get("capture_done") is True, str(st))
    r = gw({"op": "arm", "mode": "player", **arm_freq})
    st = gw({"op": "status"})
    check("PLAYER играет из RAM автономно", r.get("ok") is True and st.get("playing") is True,
          f"{r} / {st}")

    stage = "E4"
    print("== E4: детектор (стимул — стрим тона) ==")
    gw({"op": "disarm"})
    r = gw({"op": "set", "reg": "det_thr", "value": 1000})
    check("det_thr записан", r.get("ok") is True, str(r))
    d0 = gw({"op": "status"}).get("det_count", 0) or 0
    gw({"op": "usb", "action": "release"})
    soapy_server(up=True)
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
    soapy_server(up=False)
    gw({"op": "usb", "action": "acquire"})
    d1 = gw({"op": "status"}).get("det_count", 0) or 0
    check("детектор FPGA засёк тон (det_count вырос)", d1 > d0, f"{d0} → {d1}")

    stage = "E5"
    print("== E5: watchdog (deadman) ==")
    r = gw({"op": "arm", "mode": "nco", **arm_freq})
    check("ARM для watchdog-теста", r.get("ok") is True, str(r))
    print("  … heartbeat останавливаем — ждём срабатывания")
    kick_stop.set()  # имитация смерти ноутбука/сети
    # Не спим фиксированные 1.6 с: дефолт WD_LIMIT=61 даёт на x40 ~1.0 с
    # (tx_clock = 2×fs), на micro ~2.0 с (tx_clock = fs — см.
    # watchdog_limit_for_fs). Опросом меряем фактическую латентность — заодно
    # это и есть стендовое число для сверки модели тактирования watchdog.
    t0 = time.monotonic()
    fired_after: float | None = None
    st: dict = {}
    while time.monotonic() - t0 < 4.0:
        st = gw({"op": "status"})
        if st.get("wd_fired"):
            fired_after = time.monotonic() - t0
            break
        time.sleep(0.1)
    check("watchdog сработал (wd_fired=1)", fired_after is not None, str(st))
    if fired_after is not None:
        print(f"  … wd_fired через {fired_after:.1f} с после потери heartbeat")
    gw({"op": "disarm"})

    if not args.skip_e6:
        stage = "E6"
        print("== E6: autoload (оператор) ==")
        # Имя артефакта — факт build_bladerf.sh ($rev"x"$size.rbf), плата —
        # из ping.board (авто-детект приёмки, PR #22).
        rbf = "legionxA4.rbf" if board == "micro" else "legionx40.rbf"
        if args.non_interactive:
            print(f"  … --non-interactive: на шлюзе должно быть сделано: "
                  f"bladeRF-cli -L {rbf}; питание off/on")
        else:
            print(f"  … на шлюзе: bladeRF-cli -L {rbf}; питание off/on; Enter")
            input()
        r = gw({"op": "ping"})
        check("канал жив после power cycle (наш образ autoload)", r.get("ok") is True, str(r))

    ok_all = fails == 0
    print("ПРИЁМКА: ALL PASS" if ok_all else f"ПРИЁМКА: {fails} FAILURES")
    if args.out:
        report = {
            "system": "LEGION fpga legion",
            "board": board,
            "gateway": f"{args.gw}:{args.port}",
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "ok": ok_all,
            "fails": fails,
            "wd_fired_after_s": fired_after,
            "checks": results,
        }
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
        print(f"  отчёт: {out}")
    return 0 if ok_all else 1


if __name__ == "__main__":
    raise SystemExit(main())
