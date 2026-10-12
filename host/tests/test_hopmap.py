"""Шаг 6: hop map — темп скачков из CH_PWR_gpu и предсказание > 0.7/10."""
import numpy as np
import pytest

from legion_rx.hopmap import HopTracker
from legion_rx.pfb import Channelizer
from legion_rx.synth.protocols import _fhss_modulated

FS = 20.0e6
M = 64
FRAME = 20_000  # 1 мс


def _elrs_narrow(seed=11):
    """ELRS-подобный: таблица 24 канала ВНУТРИ окна (все скачки видимы),
    1000 Гц — период детектируется, предсказание должно сойтись 10/10."""
    p = dict(hop_rate=1000.0, band=(2432e6, 2448e6), n_hops=24,
             mod="flrc", baud=1.3e6, dev=325e3, airtime=400e-6)
    return _fhss_modulated("elrs_24", p, FS, 0.3, 2440e6, seed, 25.0)


def test_hopmap_tracks_and_predicts():
    out = _elrs_narrow()
    iq = out["iq"]
    ch = Channelizer(M, 8, xp=np)
    tr = HopTracker(M, FRAME / FS)
    n_fr = len(iq) // FRAME
    for i in range(n_fr):
        seg = iq[i * FRAME: (i + 1) * FRAME]
        y = ch.channelize(seg)
        tr.update(ch.ch_power(y), (i + 1) * FRAME / FS)
        if tr.dom[-1] is not None and len(tr.dom) > 1 and tr.dom[-2] != tr.dom[-1]:
            tr.predict_next()
    acc, n = tr.prediction_accuracy()
    assert n >= 10, f"подтверждённых скачков {n} < 10"
    assert acc > 0.7, f"критерий 6.4: acc={acc:.2f} ≤ 0.7"
    rate = tr.hop_rate_hz()
    assert rate == pytest.approx(1000.0, rel=0.2)
    assert tr.protocol_match()["match"] == "elrs_24"


def test_hopmap_noise_no_false_lock():
    rng = np.random.default_rng(4)
    tr = HopTracker(M, FRAME / FS)
    ch = Channelizer(M, 8, xp=np)
    for i in range(200):
        x = (rng.standard_normal(FRAME) +
             1j * rng.standard_normal(FRAME)).astype(np.complex64)
        tr.update(ch.ch_power(ch.channelize(x)), (i + 1) * FRAME / FS)
    # на чистом шуме период не должен устойчиво находиться
    acc, n = tr.prediction_accuracy()
    assert n < 10 or acc < 0.7
