"""C-читатель FIFO (шаг 3.8): реальные байты через pipe, метки CLOCK_MONOTONIC."""
import os
import time

import numpy as np


def test_read_exact_bytes_and_timestamps(creader):
    r_fd, w_fd = os.pipe()
    try:
        payload = np.arange(2048, dtype=np.int16)
        os.write(w_fd, payload.tobytes())
        buf = np.empty(2048, dtype=np.int16)
        n, t_first, t_done = creader.read_exact(r_fd, buf)
        assert n == payload.nbytes
        assert np.array_equal(buf, payload)
        pc = time.perf_counter()
        assert 0 < t_first / 1e9 <= pc + 1e-3
        assert t_done >= t_first
        # perf_counter и mono_ns — один клок (шаг 4.7): расхождение < 50 мс
        assert abs(creader.mono_ns() / 1e9 - time.perf_counter()) < 0.05
    finally:
        os.close(r_fd)
        os.close(w_fd)


def test_partial_reads_assembled(creader):
    """Частичные read() FIFO собираются до полного кадра."""
    r_fd, w_fd = os.pipe()
    try:
        payload = np.arange(4096, dtype=np.int16).tobytes()
        # писатель отдаёт кусками по 1000 байт
        import threading

        def writer():
            for off in range(0, len(payload), 1000):
                os.write(w_fd, payload[off: off + 1000])
                time.sleep(0.001)

        th = threading.Thread(target=writer)
        th.start()
        buf = np.empty(4096, dtype=np.int16)
        n, _, _ = creader.read_exact(r_fd, buf)
        th.join()
        assert n == len(payload)
        assert buf.tobytes() == payload
    finally:
        os.close(r_fd)
        os.close(w_fd)


def test_eof_returns_short(creader):
    r_fd, w_fd = os.pipe()
    os.write(w_fd, b"\x01\x00" * 100)
    os.close(w_fd)
    buf = np.empty(4096, dtype=np.int16)
    n, _, _ = creader.read_exact(r_fd, buf)
    assert n == 200  # дочитал до EOF и честно вернул сколько есть
    assert creader.read_exact(r_fd, buf)[0] == 0
    os.close(r_fd)
