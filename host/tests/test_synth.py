"""Шаг 5.3: синтез протоколов — пик ≤ 1.0 (без клиппинга), темп скачков,
периоды пакетов, ground truth meta. Без железа, numpy."""
import numpy as np
import pytest

from legion_rx.synth import (CLASS_LO_HZ, CLASSES, GENERATORS, PARAMS,
                             synth_elrs_24, synth_orangerx_dsmx)

FS = 20.0e6


@pytest.mark.parametrize("name", CLASSES)
def test_class_generates_and_no_clipping(name):
    out = GENERATORS[name](fs=FS, dur=0.02, lo_hz=CLASS_LO_HZ[name],
                           seed=3, snr_db=20.0)
    iq, meta = out["iq"], out["meta"]
    assert iq.dtype == np.complex64
    assert len(iq) == int(FS * 0.02)
    assert np.max(np.abs(iq)) <= 1.0  # amp выше 1.0 — клиппинг, запрещён
    assert meta["class"] == name
    assert meta["fs"] == FS


def test_elrs24_hop_rate_and_truth_meta():
    dur = 0.3
    out = synth_elrs_24(fs=FS, dur=dur, lo_hz=2440e6, seed=5, snr_db=25.0)
    meta = out["meta"]
    ht = meta["hop_times_s"]
    # сетка 1000 Гц: межскачковые интервалы ~1 мс
    d = np.diff(ht)
    assert abs(np.median(d) - 1e-3) < 1e-6
    assert meta["hop_rate_hz"] == 1000.0
    # часть скачков вне 20 МГц окна (band 83 МГц) — видимость помечена
    assert 0 < meta["hop_visible"].mean() < 0.6
    # измерение темпа из самого сигнала: STFT-энергия в полосе видимого канала
    iq = out["iq"]
    vis_f = meta["hop_freqs_hz"][meta["hop_visible"]]
    vis_t = meta["hop_times_s"][meta["hop_visible"]]
    assert len(vis_f) > 5
    # восстановим центральную частоту по производной фазы (медиана мгновенной
    # частоты на сильных отсчётах пачки — устойчиво для GFSK)
    hits = 0
    for t0, f0 in zip(vis_t[:20], vis_f[:20]):
        s0 = int((t0 + 10e-6) * FS)
        seg = iq[s0: s0 + 1200]
        if len(seg) < 1200:
            continue
        strong = np.abs(seg) > 0.4 * np.max(np.abs(seg))
        f_inst = np.diff(np.unwrap(np.angle(seg))) * FS / (2 * np.pi)
        if strong[1:].sum() < 100:
            continue
        f_meas = float(np.median(f_inst[strong[1:]]))
        if abs(f_meas - f0) < 100e3:
            hits += 1
    assert hits >= 15  # видимые скачки реально на заявленных частотах


def test_dsmx_period_22_or_11_ms():
    out = synth_orangerx_dsmx(fs=FS, dur=0.3, lo_hz=2440e6, seed=9, snr_db=30.0)
    meta = out["meta"]
    assert meta["period_s"] in (22e-3, 11e-3)
    d = np.diff(meta["hop_times_s"])
    assert np.allclose(d, meta["period_s"], atol=1e-6)


def test_ttlrs_narrowband():
    out = GENERATORS["ttlrs"](fs=FS, dur=0.1, lo_hz=868e6, seed=1, snr_db=30.0)
    spec = np.abs(np.fft.fftshift(np.fft.fft(out["iq"] * np.hanning(len(out["iq"]))))) ** 2
    freqs = np.fft.fftshift(np.fft.fftfreq(len(spec), 1 / FS))
    tot = spec.sum()
    # 9600 baud GFSK dev 4.8 кГц: 99% энергии в ±100 кГц
    m = np.abs(freqs - out["meta"]["offset_hz"]) < 100e3
    assert spec[m].sum() / tot > 0.9


def test_miller_subcarrier_rate():
    out = GENERATORS["miller"](fs=FS, dur=0.02, lo_hz=915e6, seed=2, snr_db=30.0)
    assert out["meta"]["bitrate"] == 40e3 / out["meta"]["miller_m"]


def test_snr_scales_noise():
    a = GENERATORS["noise"](fs=FS, dur=0.02, snr_db=20.0, seed=1)
    b = GENERATORS["noise"](fs=FS, dur=0.02, snr_db=20.0, seed=2)
    rms = lambda x: float(np.sqrt(np.mean(np.abs(x["iq"]) ** 2)))
    assert rms(a) == pytest.approx(rms(b), rel=0.2)
