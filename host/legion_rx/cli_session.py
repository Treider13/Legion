"""BladerfCliSession — одна интерактивная сессия bladeRF-cli (шаги 3.2–3.9).

Почему не `bladeRF-cli -e` на каждую команду: каждый CLI-процесс открывает
устройство по USB, а FX3 — один интерфейс, один владелец (SoapySDR #225,
legion_gateway errno 16). Второй процесс на `rx status` получил бы
«device busy». Поэтому: `bladeRF-cli -i` живёт всю сессию, команды пишем
в stdin, `rx status` (шаг 3.9) опрашивается в ТОЙ ЖЕ сессии, пока RX идёт.

Протокол синхронизации: после команды пишем `echo LEGION_SYNC` и ждём
эту строку. Приглашение "bladeRF>" на pipe эта сборка не печатает.
"""
from __future__ import annotations

import re
import shutil
import subprocess
import threading
import time

PROMPT = "bladeRF>"
# Эта сборка bladeRF-cli на pipe не печатает приглашение: libtecla сразу
# читает stdin. Конец команды — отдельная строка echo.
SYNC = "LEGION_SYNC"


def _sync_body(buf: bytes) -> "str | None":
    """Текст до строки-маркера или приглашения. None, пока строка не целая."""
    text = buf.decode("utf-8", "replace")
    if not text.endswith(("\n", "\r")):
        return None
    lines = text.splitlines()
    for i, ln in enumerate(lines):
        stripped = ln.strip()
        if stripped == SYNC or stripped.endswith(PROMPT):
            return "\n".join(lines[:i])
    return None


class CliError(RuntimeError):
    pass


class _SessionDead(CliError):
    pass


class BladerfCliSession:
    def __init__(self, device: "str | None" = None, cmd_timeout_s: float = 15.0):
        args = ["bladeRF-cli", "-i"]
        if shutil.which("stdbuf"):
            # Без этого stdout cli копится блоком и ответ не доходит до read.
            args = ["stdbuf", "-o0", "-e0", *args]
        if device:
            args += ["-d", device]
        self._timeout = float(cmd_timeout_s)
        self._proc = subprocess.Popen(
            args, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT, bufsize=0)
        self._buf = bytearray()
        self._cv = threading.Condition()
        self._closed = False
        # cmd() сериализуем: монитор overruns и эскалация (rx stop/start)
        # ходят из разных потоков по одной сессии.
        self._cmd_lock = threading.Lock()
        # Фоновые строки (асинхронные RX-события: overruns/ discontinuity)
        # копим отдельно — OverrunMonitor их забирает (шаг 3.9).
        self._async_lock = threading.Lock()
        self._async_lines: list[str] = []
        self._th = threading.Thread(target=self._pump, daemon=True,
                                    name="bladerf-cli-pump")
        self._th.start()
        banner = self._roundtrip(None)
        if banner and "bladeRF" not in banner and "error" in banner.lower():
            raise CliError(f"bladeRF-cli стартовал с ошибкой: {banner.strip()}")

    # ---- транспорт ----

    def _pump(self) -> None:
        assert self._proc.stdout is not None
        while True:
            chunk = self._proc.stdout.read(65536)
            if not chunk:
                with self._cv:
                    self._closed = True
                    self._cv.notify_all()
                return
            with self._cv:
                self._buf.extend(chunk)
                self._cv.notify_all()
            self._collect_async(chunk)

    def _collect_async(self, chunk: bytes) -> None:
        """Асинхронные события RX из stdout сессии (overrun/discontinuity)."""
        text = chunk.decode("utf-8", "replace")
        hits = [ln for ln in text.splitlines()
                if re.search(r"overrun|underrun|discontinuit|TIME_PAST", ln, re.I)]
        if hits:
            with self._async_lock:
                self._async_lines.extend(hits)

    def take_async_events(self) -> list[str]:
        with self._async_lock:
            out, self._async_lines = self._async_lines, []
        return out

    def _wait_sync(self, timeout: "float | None" = None) -> str:
        deadline = time.monotonic() + (timeout or self._timeout)
        with self._cv:
            while True:
                got = _sync_body(bytes(self._buf))
                if got is not None:
                    self._buf.clear()
                    return got
                if self._closed:
                    text = bytes(self._buf).decode("utf-8", "replace")
                    self._buf.clear()
                    raise _SessionDead(
                        f"bladeRF-cli завершился без ответа: {text.strip()}")
                left = deadline - time.monotonic()
                if left <= 0:
                    text = bytes(self._buf).decode("utf-8", "replace").strip()
                    raise CliError(
                        f"bladeRF-cli: таймаут ожидания ответа: {text[:400]}")
                self._cv.wait(timeout=left)

    def _write(self, line: str) -> None:
        assert self._proc.stdin is not None
        try:
            self._proc.stdin.write(line.encode() + b"\n")
            self._proc.stdin.flush()
        except BrokenPipeError as e:
            raise _SessionDead("bladeRF-cli: stdin закрыт") from e

    def _roundtrip(self, line: "str | None", timeout: "float | None" = None) -> str:
        with self._cv:
            self._buf.clear()
        if line:
            self._write(line)
        self._write(f"echo {SYNC}")
        return self._wait_sync(timeout)

    def cmd(self, line: str, timeout: "float | None" = None) -> str:
        """Команда → ответ до следующего приглашения (без самого приглашения).
        Потокобезопасно: одна команда за раз на всю сессию."""
        with self._cmd_lock:
            return self._cmd_locked(line, timeout)

    def _cmd_locked(self, line: str, timeout: "float | None" = None) -> str:
        if self._closed or self._proc.poll() is not None:
            raise _SessionDead("bladeRF-cli процесс мёртв")
        resp = self._roundtrip(line, timeout)
        # Эхо команды и приглашение убираем: остаётся тело ответа.
        body = resp.replace(PROMPT, "\n")
        skip = {line.strip(), f"echo {SYNC}", SYNC, PROMPT}
        lines = [ln for ln in body.splitlines() if ln.strip() and ln.strip() not in skip]
        out = "\n".join(lines).strip()
        low = out.lower()
        if "error" in low or "usage:" in low or "invalid" in low:
            raise CliError(f"{line!r}: {out}")
        return out

    # ---- команды шага 3 ----

    def set_frequency_rx(self, hz: float) -> None:
        """set frequency rx …; Hz → компактная запись CLI (2400000000 → 2400M)."""
        self.cmd(f"set frequency rx {_fmt_hz(hz)}")

    def set_samplerate_rx(self, hz: float) -> None:
        self.cmd(f"set samplerate rx {_fmt_hz(hz)}")

    def set_bandwidth_rx(self, hz: float) -> None:
        self.cmd(f"set bandwidth rx {_fmt_hz(hz)}")

    def rx_config(self, file: str, fmt: str = "bin", n: int = 0,
                  buffers: int = 32, xfers: int = 16, timeout_ms: int = 10000) -> None:
        """rx config file=… format=bin n=0 (шаг 3.5). Формат bin = SC16_Q11
        на проводе (проверка 3.7: rx config format=bin без file печатает конфиг).
        buffers=32, num_transfers=16 — рекомендация Nuand для высоких
        samplerates [F1]; transfers=8 на 20 MSPS давал overrun."""
        self.cmd(_rx_config_line(file, fmt, n, buffers, xfers, timeout_ms))

    def rx_start(self) -> None:
        self.cmd("rx start")

    def rx_stop(self) -> None:
        self.cmd("rx stop")

    def rx_status(self) -> dict:
        """rx status → dict. Поля формата CLI различаются между версиями —
        разбор терпимый: числа по ключевым словам, сырой текст сохраняем."""
        text = self.cmd("rx status")
        return parse_rx_status(text)

    def close(self) -> None:
        if self._closed:
            return
        try:
            self.rx_stop()
        except CliError:
            pass
        try:
            if self._proc.stdin:
                self._proc.stdin.write(b"exit\n")
                self._proc.stdin.flush()
        except (BrokenPipeError, OSError):
            pass
        try:
            self._proc.wait(timeout=5.0)
        except subprocess.TimeoutExpired:
            self._proc.kill()
        self._closed = True

    def __enter__(self) -> "BladerfCliSession":
        return self

    def __exit__(self, *exc) -> None:
        self.close()


def _rx_config_line(file: str, fmt: str, n: int, buffers: int,
                    xfers: int, timeout_ms: int) -> str:
    """Строка rx config (bladeRF-cli cmd_rxtx.c: параметр — num_transfers)."""
    return (f"rx config file={file} format={fmt} n={n} "
            f"buffers={buffers} num_transfers={xfers} timeout={timeout_ms}")


def parse_usb_speed(info_text: str) -> "bool | None":
    """USB SuperSpeed из `bladeRF-cli -e info` («USB speed: SuperSpeed»).
    None — поле не найдено (формат версии иной) — не блокируем."""
    m = re.search(r"usb\s+speed\s*:\s*(\S+)", info_text, re.I)
    if m:
        return m.group(1).lower().startswith("super")
    if re.search(r"superspeed|usb\s*3", info_text, re.I):
        return True
    return None


def preflight(device: "str | None" = None, timeout_s: float = 20.0) -> dict:
    """Pre-flight [F8]: USB SuperSpeed (`info`) + verify format=bin
    (`rx config format=bin` — конфиг без старта стрима, шаг 3.7).
    Вызывать ДО открытия сессии (устройство свободно)."""
    out: dict = {"device": device, "usb_superspeed": None,
                 "info_ok": False, "format_bin_ok": False, "errors": []}
    dev = ["-d", device] if device else []
    try:
        cp = subprocess.run(["bladeRF-cli", "-e", "info"] + dev,
                            capture_output=True, text=True, timeout=timeout_s)
        out["info_ok"] = cp.returncode == 0
        out["usb_superspeed"] = parse_usb_speed((cp.stdout or "") + (cp.stderr or ""))
        if cp.returncode != 0:
            out["errors"].append(f"info rc={cp.returncode}: {(cp.stderr or cp.stdout).strip()[:200]}")
    except (FileNotFoundError, subprocess.TimeoutExpired) as e:
        out["errors"].append(f"info: {e}")
    try:
        cp = subprocess.run(["bladeRF-cli", "-e", "rx config format=bin"] + dev,
                            capture_output=True, text=True, timeout=timeout_s)
        out["format_bin_ok"] = cp.returncode == 0
        if cp.returncode != 0:
            out["errors"].append(
                f"rx config format=bin rc={cp.returncode}: {(cp.stderr or cp.stdout).strip()[:200]}")
    except (FileNotFoundError, subprocess.TimeoutExpired) as e:
        out["errors"].append(f"rx config format=bin: {e}")
    return out


def _fmt_hz(hz: float) -> str:
    hz = float(hz)
    if hz >= 1e6 and hz % 1e6 == 0:
        return f"{hz / 1e6:g}M"
    if hz >= 1e3 and hz % 1e3 == 0:
        return f"{hz / 1e3:g}K"
    return str(int(hz))


_OVERRUN_RES = [
    re.compile(r"overruns?\s*[:=]?\s*(\d+)", re.I),
    re.compile(r"(\d+)\s+overruns?", re.I),
]
_UNDERRUN_RES = [
    re.compile(r"underruns?\s*[:=]?\s*(\d+)", re.I),
    re.compile(r"(\d+)\s+underruns?", re.I),
]
_STATE_RE = re.compile(r"state\s*[:=]?\s*([A-Za-z ]+)", re.I)


def parse_rx_status(text: str) -> dict:
    """Терпимый разбор `rx status`: версии CLI печатают разные раскладки
    («Overruns: 0», «0 overruns», таблица состояния). Не нашли поле —
    None и сырой текст, а не выдуманный ноль."""
    out: dict = {"raw": text.strip(), "overruns": None,
                 "underruns": None, "state": None}
    for rx, key in ((_OVERRUN_RES, "overruns"), (_UNDERRUN_RES, "underruns")):
        for pat in rx:
            m = pat.search(text)
            if m:
                out[key] = int(m.group(1))
                break
    m = _STATE_RE.search(text)
    if m:
        out["state"] = m.group(1).strip().lower()
    return out
