"""Шаг 4: PFB — тон садится в свой канал, ограничения channelize_poly,
CH_PWR_gpu. numpy-backend (GPU проверяется в лаборатории, математика та же)."""
import numpy as np
import pytest

from legion_rx.pfb import (MAX_TAPS_PER_CHAN, Channelizer,
                           channelize_poly_ok, design_prototype)

FS = 20.0e6
M = 64
TAPS = 8


def _tone(k, fs, n):
    f = k * fs / M
    t = np.arange(n) / fs
    return np.exp(2j * np.pi * f * t).astype(np.complex64)


def test_channelize_poly_constraints():
    ok, _ = channelize_poly_ok(M, 32)
    assert ok
    ok, why = channelize_poly_ok(M, MAX_TAPS_PER_CHAN + 1)
    assert not ok and "custom" in why.lower() or "свой" in why
    ok, _ = channelize_poly_ok(0, 8)
    assert not ok


def test_prototype_length():
    h = design_prototype(M, TAPS)
    assert h.size == M * TAPS


def test_tone_lands_in_own_channel():
    ch = Channelizer(M, TAPS, xp=np)
    assert "custom" in ch.backend_name  # numpy → свой PFB
    n = M * 512
    for k in (3, 17, 40):
        y = ch.channelize(_tone(k, FS, n))
        pwr = ch.ch_power(y)
        kmax = int(np.argmax(pwr))
        assert kmax == k, f"тон канала {k} сел в {kmax}"
        # отношение к медиане остальных каналов — десятки dB
        rest = np.delete(pwr, k)
        assert 10 * np.log10(pwr[k] / np.median(rest)) > 25.0


def test_channel_freq_mapping():
    ch = Channelizer(M, TAPS, xp=np)
    assert ch.channel_freq(0, FS) == 0.0
    assert ch.channel_freq(1, FS) == pytest.approx(FS / M)
    assert ch.channel_freq(M - 1, FS) == pytest.approx(-FS / M)


def test_frame_too_short_raises():
    ch = Channelizer(M, TAPS, xp=np)
    with pytest.raises(ValueError):
        ch.channelize(np.zeros(M, dtype=np.complex64))


def test_ch_pwr_noise_uniform():
    rng = np.random.default_rng(1)
    ch = Channelizer(M, TAPS, xp=np)
    x = (rng.standard_normal(M * 1024) +
         1j * rng.standard_normal(M * 1024)).astype(np.complex64)
    pwr = ch.ch_power(ch.channelize(x))
    cv = float(np.std(pwr) / np.mean(pwr))
    assert cv < 0.5  # белый шум — мощность по каналам ровная
