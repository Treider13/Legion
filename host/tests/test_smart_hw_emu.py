"""Жёсткая модель платы для умной атаки.

Одна несущая, окно 34 МГц, кадр SC16 как у bladeRF. Тон слышен только
внутри окна. Выключение приёма на перестройке рвёт поток: следующие
чтения пустые, пока поток не вооружат снова. Живой обход так не делает.

Сетки 10, 50 и 80. Пока кнопка не нажата, TX молчит. Передать бьёт
по записанному ряду и не гаснет по таймеру 15 с.
"""
import os
import tempfile

import numpy as np

import legion_fpga as lf
from legion_gateway import FakeTransport
from legion_rx.cognitive import (CONFIRMING, INITIAL_SCAN, JAMMING, LEARNING,
                                 MULTI_LO, MONITORING, TIMER, CognitiveFSM)
from legion_rx.fifo_source import FifoSource, ensure_fifo
from legion_rx.hop_recorder import isolate_bursts
from legion_rx.lo_sweep import plan_windows
from legion_rx.pattern_store import PatternStore
from legion_rx.pipeline import (_UsbLive, frame_air_span, retune_live_lo)
from legion_rx.spectrogram import stft_db

FS = 34.0e6
FRAME = 20_000
NFFT = 1024
CORRIDOR = (2300e6, 2500e6)
DWELL_S = 250e-6
INTERIOR = 0.40 * FS


class Board:
    """AD9361 в одном окне. sync_rx умирает, если приём выключили."""

    def __init__(self, freqs_hz, dwell_s=DWELL_S, seed=1):
        self.freqs = [float(f) for f in freqs_hz]
        self.dwell_s = float(dwell_s)
        self.lo = 0
        self.open = True
        self.sync = True
        self.armed = True
        self.sample = 0
        self.enable_calls = []
        self.los = []
        self.overruns = 0
        self._rng = np.random.default_rng(seed)

    def enable_rx(self, on):
        self.enable_calls.append(bool(on))
        if not on:
            self.sync = False
            self.armed = False
        elif self.armed:
            self.sync = True

    def arm_meta_stream(self):
        self.armed = True
        return 0

    def set_frequency(self, hz):
        self.lo = int(hz)
        self.los.append(self.lo)
        return 0

    def release(self):
        self.open = False
        return 0

    def acquire(self, device=""):
        self.open = True
        return 0

    def read_frame_bytes(self, n_samples, timeout_ms=1000):
        n = int(n_samples)
        if not self.sync:
            return 0, b"", self.sample
        ts = int(self.sample)
        iq = self._iq(n)
        self.sample = ts + n
        scaled = np.empty(n * 2, dtype="<i2")
        scaled[0::2] = np.clip(np.round(iq.real * 2048), -2048, 2047)
        scaled[1::2] = np.clip(np.round(iq.imag * 2048), -2048, 2047)
        return 0, scaled.tobytes(), ts

    def _iq(self, n):
        noise = 0.012 * (
            self._rng.standard_normal(n) + 1j * self._rng.standard_normal(n))
        iq = noise.astype(np.complex64)
        dwell_n = max(1, int(round(self.dwell_s * FS)))
        pos = 0
        while pos < n:
            s0 = self.sample + pos
            hop = self.freqs[int(s0 // dwell_n) % len(self.freqs)]
            take = min(n - pos, dwell_n - int(s0 % dwell_n))
            bb = hop - float(self.lo)
            if abs(bb) <= INTERIOR:
                tt = s0 + np.arange(take)
                iq[pos:pos + take] += np.exp(2j * np.pi * bb * tt / FS) * 0.55
            pos += take
        return iq


def _grid(n, f0):
    freqs = [float(f0) + i * 1.0e6 for i in range(n)]
    order = np.random.default_rng(7).permutation(n)
    return [freqs[int(i)] for i in order], freqs


def _decode(raw):
    v = np.frombuffer(raw, dtype="<i2").astype(np.float32)
    return (v[0::2] + 1j * v[1::2]) / np.float32(2048.0)


def _bin_power(iq, lo, target):
    n = NFFT
    spec = np.fft.fftshift(np.fft.fft(np.asarray(iq[:n]) * np.hanning(n)))
    freqs = float(lo) + (np.arange(n) - n / 2.0) * (FS / n)
    k = int(np.argmin(np.abs(freqs - float(target))))
    return float(np.abs(spec[k]) ** 2)


def _push(fsm, iq, t0, t1):
    spec = np.asarray(stft_db(iq, NFFT, NFFT, np), dtype=np.float64)
    lin = np.power(10.0, np.maximum(spec, -120.0) / 10.0)
    n_bins, n_col = lin.shape
    freqs = fsm.lo_hz + (np.arange(n_bins) - n_bins / 2.0) * (FS / n_bins)
    fsm.sweeper._hold_dwell = True
    try:
        if fsm.sweeper._count_samples:
            fsm.sweeper.add_samples(int(iq.size))
        for col in range(n_col):
            t_col = t0 + (col + 1) * (t1 - t0) / n_col
            heard = isolate_bursts(lin[:, col])
            if col + 1 == n_col:
                fsm.tick(heard, freqs, t_col)
            else:
                fsm.hear(heard, freqs, t_col)
    finally:
        fsm.sweeper._hold_dwell = False
    return freqs


def _walk(n, f0, air_limit_s=6.0):
    shuffled, plain = _grid(n, f0)
    board = Board(shuffled, seed=n)
    wins = plan_windows(CORRIDOR[0], CORRIDOR[1], FS)
    board.lo = int(wins[0]["f_center"])

    class _Lo:
        def set_frequency_rx(self, hz):
            retune_live_lo(board, hz)

    fpga = lf.LegionFpga(FakeTransport(board="bladerf2"))
    fsm = CognitiveFSM(
        PatternStore(), 64, FS, board.lo, fpga=fpga, radio=_Lo(),
        scan_corridor=CORRIDOR, ibw_hz=FS, frame_samples=FRAME,
        frame_dt_s=FRAME / FS)
    fsm.sweeper.arm_sample_dwell()
    limit = int(air_limit_s * FS)
    last_freqs = np.asarray([board.lo])
    t1 = 0.0
    while board.sample < limit and not (
            fsm._heard_ready and len(fsm._heard_ready) >= n):
        _rc, raw, ts = board.read_frame_bytes(FRAME)
        assert raw, n
        iq = _decode(raw)
        t0, t1 = frame_air_span(ts, FRAME, FS)
        last_freqs = _push(fsm, iq, t0, t1)
        if fsm.jams_sent:
            break
        if (fsm.sweeper._count_samples
                and fsm.state in (INITIAL_SCAN, LEARNING, CONFIRMING)
                and fsm.sweeper.dwell_done(0.0, 0.0)):
            fsm._advance_scan(last_freqs, t1)
    return fsm, board, plain, t1


def _press_transmit(fsm, hops_mhz, t_s):
    """Та же запись, что кладёт кнопка: без sequence_type."""
    record = {
        "pattern_id": "accepted-corridor",
        "sub": {
            "f_start": CORRIDOR[0], "f_end": CORRIDOR[1],
            "sub_corridor_id": "accepted",
        },
        "freqs_mhz": list(hops_mhz),
        "cycle": list(range(len(hops_mhz))),
        "dwell_us": int(round(float(np.median(fsm._hop_gaps)) * 1e6)),
    }
    assert "sequence_type" not in record
    fsm.arm_replay(record)
    axis = np.linspace(CORRIDOR[0], CORRIDOR[1], 16)
    fsm.tick(np.ones(16), axis, t_s + 0.01)
    fsm._last_hop_t = t_s + 0.01
    fsm.tick(np.ones(16), axis, t_s + 40.0)


def test_killing_rx_on_retune_stops_the_stream_and_the_product_does_not():
    """Старый обход гасил приём на каждом окне: после первого окна тишина.
    Живая перестройка несёт частоту и кадры идут дальше."""
    board = Board([2483e6], dwell_s=1.0)
    board.lo = 2_313_600_000
    _rc, raw, _ts = board.read_frame_bytes(FRAME)
    assert len(raw) == FRAME * 4
    board.enable_rx(False)
    board.set_frequency(2_437_000_000)
    board.enable_rx(True)
    _rc, raw, _ts = board.read_frame_bytes(FRAME)
    assert raw == b""
    board.arm_meta_stream()
    board.enable_rx(True)
    assert retune_live_lo(board, 2_486_400_000) == 0
    _rc, raw, _ts = board.read_frame_bytes(FRAME)
    assert len(raw) == FRAME * 4
    assert board.lo == 2_486_400_000
    assert board.enable_calls.count(False) == 1


def test_fifo_walks_every_window_and_the_far_hop_is_not_on_the_first():
    """Насос, FIFO и C-читатель. Восемь несущих, приём не гасится.
    2483 МГц нет на первом окне и есть на последнем."""
    board = Board([2483e6], dwell_s=1.0, seed=3)
    wins = plan_windows(CORRIDOR[0], CORRIDOR[1], FS)
    path = os.path.join(tempfile.mkdtemp(prefix="legion-hw-"), "iq")
    ensure_fifo(path)
    args = type("A", (), {
        "device": None, "fifo": path, "bw": FS, "lna": 20,
        "frame_samples": FRAME,
    })()
    radio = _UsbLive(args, FS, wins[0]["f_center"])
    radio.usb = board
    board.open = True
    board.lo = int(wins[0]["f_center"])
    radio._fd = os.open(path, os.O_RDWR)
    radio.src = FifoSource(path, FRAME, FS)
    radio._stop.clear()
    radio._paused = False
    radio.src.start()
    radio._th = __import__("threading").Thread(
        target=radio._pump, daemon=True, name="emu-pump")
    radio._th.start()
    radio.streaming = True
    try:
        radio.tune(wins[0]["f_center"])
        weak = []
        for _ in range(3):
            fr = radio.read_frame(timeout=1.0)
            assert fr is not None
            weak.append(_bin_power(fr.complex64(), wins[0]["f_center"], 2483e6))
        radio.tune(wins[7]["f_center"])
        strong = []
        for _ in range(4):
            fr = radio.read_frame(timeout=1.0)
            assert fr is not None
            strong.append(_bin_power(fr.complex64(), board.lo, 2483e6))
        assert max(strong) > 50.0 * max(weak)
        seen = []
        for w in wins:
            radio.tune(w["f_center"])
            fr = radio.read_frame(timeout=1.0)
            assert fr is not None and int(fr.complex64().size) == FRAME
            seen.append(board.lo)
        assert seen == [int(w["f_center"]) for w in wins]
        assert False not in board.enable_calls
    finally:
        radio.stop()


def test_air_clock_keeps_a_250us_hop_gap():
    """250 мкс между прыжками не схлопываются в ноль и не растягиваются
    до стоянки окна."""
    fsm, _board, plain, _t1 = _walk(10, 2424e6, air_limit_s=4.0)
    assert fsm._hop_gaps, "задержка не измерена"
    med = float(np.median(fsm._hop_gaps))
    assert 150e-6 < med < 400e-6, med
    assert fsm.jams_sent == 0
    assert plain[0] == 2424e6


def test_grids_stay_quiet_until_transmit_then_run_until_stop():
    """10, 50 и 80 частот в коридоре 2300–2500. Оба края сетки в ряду.
    До кнопки TX закрыт. После кнопки удар не кончается на 15-й секунде."""
    cases = ((10, 2424e6), (50, 2402e6), (80, 2402e6))
    for n, f0 in cases:
        fsm, board, plain, t1 = _walk(n, f0)
        got = [float(x) for x in (fsm._heard_ready or [])]
        miss = [w for w in plain
                if not any(abs(g * 1e6 - w) < 0.25e6 for g in got)]
        stray = [g for g in got
                 if not any(abs(g * 1e6 - w) < 0.40e6 for w in plain)]
        assert not miss, (n, len(got), len(board.los), miss[:8],
                          len(fsm._hop_gaps), fsm.jams_sent)
        assert not stray, (n, stray[:8])
        assert n <= len(got) <= n + max(4, n // 5), (n, len(got))
        assert fsm.jams_sent == 0, n
        assert False not in board.enable_calls, n
        assert len(fsm.sweeper.windows) < 8, (n, len(fsm.sweeper.windows))
        assert min(got) < plain[0] / 1e6 + 0.25
        assert max(got) > plain[-1] / 1e6 - 0.25
        _press_transmit(fsm, got, t1)
        assert fsm.jams_sent >= 1, n
        assert fsm._jam_until is None, n
        assert fsm._until_stop, n
        assert fsm.state in (JAMMING, MULTI_LO, MONITORING, TIMER), fsm.state
        assert not any(
            tr.get("why") == "target_silent" or tr.get("note") == "jam_timer"
            for tr in fsm.transitions)
        stored = [float(x) for x in fsm.store.get(fsm.pid)["freqs_mhz"]]
        assert stored == got, n
