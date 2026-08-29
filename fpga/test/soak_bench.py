#!/usr/bin/env python3
"""LEGION FPGA — soak-тест ретрансляции (lb_gated) на стенде, 8–24 часа.

Нагрузка 50 Ом на TX, антенна/кабель на RX. На шлюзе: legion_gateway.py.
Скрипт держит ARM lb_gated, шлёт heartbeat (500 мс, как приложение LEGION),
раз в --poll-s секунд снимает status и пишет JSONL-журнал. События:
wd_fired (сторож снял ARM — перезапуск с подсчётом), ошибки опроса,
предупреждения шлюза (warn: длительная работа / охлаждение).

  python3 fpga/test/soak_bench.py --gw 192.168.1.20 [--hours 8]
      [--freq 2450] [--det-thr 1000] [--board micro] [--poll-s 30]

Артефакты (fpga/test/results/):
  soak-<время>.jsonl  — каждый опрос и событие, строка JSON на запись
  soak-<время>.md     — итоговый отчёт: длительность, перезапуски, ошибки,
                        предупреждения, вердикт.

Ctrl+C — штатное завершение с отчётом (DISARM перед выходом).
"""
from __future__ import annotations

import argparse
import json
import signal
import socket
import sys
import threading
import time
from pathlib import Path

stop = threading.Event()


class Gw:
    def __init__(self, host: str, port: int) -> None:
        self.host, self.port = host, port

    def __call__(self, msg: dict) -> dict:
        with socket.create_connection((self.host, self.port), timeout=4) as s:
            s.sendall((json.dumps(msg) + "\n").encode())
            line = s.makefile("rb").readline()
        return json.loads(line.decode("utf-8", "replace"))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--gw", required=True, help="IP шлюза с платой")
    ap.add_argument("--port", type=int, default=5531)
    ap.add_argument("--hours", type=float, default=8.0, help="длительность, часов (дробно)")
    ap.add_argument("--freq", type=float, default=2450.0, help="LO парковки, МГц")
    ap.add_argument("--det-thr", type=int, default=1000, help="порог детектора lb_gated")
    ap.add_argument("--board", choices=("x40", "micro"), default="",
                    help="плата; пусто = авто-детект по ping.board")
    ap.add_argument("--poll-s", type=float, default=30.0, help="период опроса status")
    args = ap.parse_args()
    gw = Gw(args.gw, args.port)

    ts = time.strftime("%Y%m%d-%H%M%S")
    out_dir = Path(__file__).resolve().parent / "results"
    out_dir.mkdir(parents=True, exist_ok=True)
    jsonl_path = out_dir / f"soak-{ts}.jsonl"
    md_path = out_dir / f"soak-{ts}.md"

    def log(rec: dict) -> None:
        rec["t"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
        with jsonl_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")

    def kick_loop() -> None:
        while not stop.wait(0.5):
            try:
                gw({"op": "kick"})
            except Exception:
                pass  # сеть мертва — watchdog в FPGA отработает сам

    signal.signal(signal.SIGINT, lambda *_: stop.set())
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    threading.Thread(target=kick_loop, daemon=True).start()

    r = gw({"op": "ping"})
    if r.get("ok") is not True:
        print(f"FAIL: шлюз не отвечает: {r}")
        return 1
    board = args.board or ("micro" if r.get("board") == "bladerf2" else "x40")
    arm_cmd: dict = {"op": "arm", "mode": "lb_gated", "det_thr": args.det_thr}
    if board == "micro":
        arm_cmd["freq_mhz"] = args.freq  # LO для AD9361 обязателен
    print(f"soak: плата {board}, {args.hours} ч, опрос каждые {args.poll_s} с → {jsonl_path}")
    log({"event": "start", "board": board, "hours": args.hours,
         "freq_mhz": args.freq, "det_thr": args.det_thr})

    t0 = time.monotonic()
    deadline = t0 + args.hours * 3600
    restarts = 0
    errors = 0
    warns = 0
    polls = 0
    last_det = 0

    r = gw({"op": "arm", **{k: v for k, v in arm_cmd.items() if k != "op"}})
    if r.get("ok") is not True:
        print(f"FAIL: ARM не взвёлся: {r.get('reason')}")
        log({"event": "arm_fail", "reason": r.get("reason")})
        return 1
    log({"event": "arm", "mode": "lb_gated"})
    print("  ARM lb_gated взведён — soak пошёл")

    while not stop.is_set() and time.monotonic() < deadline:
        stop.wait(args.poll_s)
        polls += 1
        try:
            st = gw({"op": "status"})
        except Exception as e:
            errors += 1
            log({"event": "poll_error", "error": str(e)})
            print(f"  [{polls}] ошибка опроса: {e}")
            continue
        rec = {
            "event": "poll",
            "n": polls,
            "elapsed_s": int(time.monotonic() - t0),
            "det_count": st.get("det_count"),
            "det_active": st.get("det_active"),
            "wd_fired": st.get("wd_fired"),
            "armed_s": st.get("armed_s"),
            "lb_level": st.get("lb_level"),
        }
        if st.get("warn"):
            warns += 1
            rec["warn"] = st["warn"]
            print(f"  [{polls}] WARN шлюза: {st['warn']}")
        log(rec)
        if st.get("ok") is not True:
            errors += 1
            log({"event": "status_fail", "reason": st.get("reason")})
        if st.get("wd_fired"):
            restarts += 1
            log({"event": "wd_fired", "restart": restarts})
            print(f"  [{polls}] watchdog снял ARM — перезапуск #{restarts}")
            gw({"op": "disarm"})
            r = gw({"op": "arm", **{k: v for k, v in arm_cmd.items() if k != "op"}})
            log({"event": "rearm", "ok": r.get("ok"), "reason": r.get("reason")})
        dc = st.get("det_count") or 0
        if dc != last_det:
            last_det = dc

    gw({"op": "disarm"})
    elapsed = int(time.monotonic() - t0)
    log({"event": "stop", "elapsed_s": elapsed, "polls": polls,
         "restarts": restarts, "errors": errors, "warns": warns})

    verdict_ok = errors == 0 and restarts == 0
    report = f"""# LEGION soak-отчёт — {ts}

| Параметр | Значение |
|---|---|
| Плата | {board} |
| Режим | lb_gated (ретрансляция RX→TX по энергии), нагрузка 50 Ом |
| LO | {args.freq} МГц · det_thr {args.det_thr} |
| Длительность | {elapsed // 3600} ч {(elapsed % 3600) // 60} мин ({elapsed} с) |
| Опросов status | {polls} |
| Перезапусков (watchdog) | {restarts} |
| Ошибок опроса/статуса | {errors} |
| Предупреждений шлюза (охлаждение) | {warns} |
| Окон детектора (последний det_count) | {last_det} |

## Вердикт

**{"PASS — ни одного перезапуска и ошибки за весь прогон" if verdict_ok else "FAIL — были перезапуски или ошибки (см. JSONL)"}**

Журнал: `{jsonl_path.name}`
"""
    md_path.write_text(report, encoding="utf-8")
    print(f"\nSOAK: {'PASS' if verdict_ok else 'FAIL'} — отчёт {md_path}")
    return 0 if verdict_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
