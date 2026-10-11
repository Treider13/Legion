"""FifoSource — потоковый источник кадров из /tmp/iq (шаги 3.5–3.8).

Отдельный поток: C-читатель read_exact дочитывает ровно кадр, метки
времени — CLOCK_MONOTONIC внутри C (шаг 4.7). Кадры уходят в queue;
переполнение очереди = потребитель не успевает → кадр СЧИТАЕМ
(дроп виден в статистике, а не молча в памяти).
"""
from __future__ import annotations

import os
import queue
import stat
import threading

import numpy as np

from .frames import BYTES_PER_SAMPLE, Frame
from .reader import load_creader


def ensure_fifo(path: str) -> None:
    """mkfifo /tmp/iq (шаг 3.1). Существующий FIFO — ок, файл — ошибка."""
    if os.path.exists(path):
        if not stat.S_ISFIFO(os.stat(path).st_mode):
            raise RuntimeError(f"{path} существует и не FIFO — уберите файл")
        return
    os.mkfifo(path)


class FifoSource:
    """Поток-читатель. open(FIFO) блокируется до появления писателя
    (bladeRF-cli rx start) — это штатная фаза handshake, не зависание."""

    def __init__(self, path: str, n_samples: int, fs_hz: float,
                 max_queue: int = 8):
        if n_samples <= 0:
            raise ValueError("n_samples > 0")
        self.path = path
        self.n_samples = int(n_samples)
        self.fs_hz = float(fs_hz)
        self.frames: "queue.Queue[Frame]" = queue.Queue(maxsize=max_queue)
        self.dropped = 0  # кадры, не поместившиеся в очередь (переполнение)
        self.bytes_read = 0
        self.eof = False
        self.error: "BaseException | None" = None
        self._cr = load_creader()
        self._stop = threading.Event()
        self._th = threading.Thread(target=self._run, daemon=True,
                                    name="fifo-source")

    def start(self) -> None:
        self._th.start()

    def stop(self) -> None:
        self._stop.set()
        self._th.join(timeout=5.0)

    def _run(self) -> None:
        n_bytes = self.n_samples * BYTES_PER_SAMPLE
        sample_count = 0
        try:
            fd = os.open(self.path, os.O_RDONLY)
        except OSError as e:
            self.error = e
            return
        try:
            while not self._stop.is_set():
                buf = np.empty(self.n_samples * 2, dtype=np.int16)
                n, t_first, t_done = self._cr.read_exact(fd, buf)
                if n == 0:
                    self.eof = True  # писатель закрыл FIFO (rx stop / exit)
                    break
                if n < n_bytes:
                    # Хвост кадра при закрытии потока — не выдаём полукадр.
                    self.bytes_read += n
                    self.eof = True
                    break
                fr = Frame(
                    int16=buf,
                    n_samples=self.n_samples,
                    sample_count=sample_count,
                    t_first=t_first / 1e9,
                    t_done=t_done / 1e9,
                    fs_hz=self.fs_hz,
                )
                sample_count += self.n_samples
                self.bytes_read += n
                try:
                    self.frames.put_nowait(fr)
                except queue.Full:
                    self.dropped += 1
        except BaseException as e:  # ошибку читателя видим, не глотим
            self.error = e
        finally:
            os.close(fd)

    def stats(self, elapsed_s: float) -> dict:
        mb = self.bytes_read / 1e6
        return {
            "bytes_read": self.bytes_read,
            "mbytes": round(mb, 2),
            "throughput_mb_s": round(mb / elapsed_s, 2) if elapsed_s > 0 else 0.0,
            "dropped_frames": self.dropped,
            "eof": self.eof,
        }
