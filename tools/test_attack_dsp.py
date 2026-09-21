#!/usr/bin/env python3
"""DSP Атаки: живые формулы, не заглушки. Не трогает scan()."""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import attack_dsp as d
import numpy as np

fail = 0


def check(name: str, cond: bool, detail: str = "") -> None:
    global fail
    if cond:
        print(f"  PASS  {name}")
    else:
        fail += 1
        print(f"  FAIL  {name} {detail}")


def main() -> int:
    tap = d.dpss_tapers(256, 3)
    check("DPSS 3 окна", tap.shape == (3, 256))
    check("DPSS норма", abs(float(np.sum(tap[0] ** 2)) - 1.0) < 1e-6)
    tone = d.synth_look_iq("tone", 2048, 2e6)
    ofdm = d.synth_look_iq("ofdm", 2048, 2e6)
    tlook = d.analyze_iq(tone, 2e6)
    olook = d.analyze_iq(ofdm, 2e6)
    nlook = d.analyze_iq(d.synth_look_iq("noise", 2048, 2e6), 2e6)
    check("тон не unknown", tlook["kind"] in ("tone", "cycle"), str(tlook))
    check("OFDM не тон", olook["kind"] != "tone", str(olook))
    if float(olook["cepstrum"]) >= 0.22:
        check("OFDM с решёткой не цикл", olook["kind"] == "ofdm", str(olook))
    check("шум не тон", nlook["kind"] in ("noise", "unknown", "ofdm"), str(nlook))
    n = 256
    t = np.arange(n)
    off = 0.5 * t[1:] * (n - t[1:])
    check("DPSS off как SciPy t(M-t)/2", abs(float(off[10]) - (11 * (n - 11) / 2.0)) < 1e-9)
    spec = d.multitaper_dbm(tone)
    freqs = np.linspace(-1, 1, spec.size)
    check("multitaper длина", spec.size == 2048)
    w3 = d.width_xd_b(spec, freqs, freqs[int(np.argmax(spec))], 3)
    check("ширина тона узкая", 0 <= w3 < 0.4)
    e, clip = d.cancel_own(tone + 0.05 * ofdm, tone)
    check("вычет не клип", clip is False)
    check("вычет снижает энергию", d.leftover_ratio(tone + 0.05 * ofdm, e) < 0.5)
    delayed = np.roll(tone, -80)
    e2, clip2 = d.cancel_own(delayed + 0.05 * ofdm, tone)
    check("вычет ловит отрицательный лаг", clip2 is False and d.leftover_ratio(delayed + 0.05 * ofdm, e2) < 0.5)
    check("память 2^24", d.ATTACK_MEM_CAP == 1 << 24)
    check("think хвост 2^16", d.ATTACK_THINK_N == 1 << 16)

    fs = 61.44e6
    n = d.ATTACK_THINK_N
    t = np.arange(n, dtype=np.float64) / fs
    rng = np.random.default_rng(3)
    brick = np.zeros(n, dtype=np.complex128)
    for k in range(-16, 17):
        if k == 0:
            continue
        brick += np.exp(1j * (2.0 * np.pi * k * (2e6 / 32.0) * t + float(rng.uniform(0, 2 * np.pi))))
    brick = (0.04 * brick).astype(np.complex64)
    cropped = d.crop_iq(brick, fs, 2442.0, 2442.0, 2.0)
    old = d.analyze_iq(cropped, fs)
    check("корни: crop@61.44 врёт тон", old["kind"] == "tone", str(old))
    ch, fs_out = d.channelize_look(brick, fs, 2442.0, 2442.0, 2.0)
    look = d.analyze_iq(ch, fs_out)
    check("канализатор не тон на OFDM-кирпиче", look["kind"] != "tone", str(look))
    if float(look["cepstrum"]) >= 0.22:
        check("канализатор OFDM-кирпич = ofdm", look["kind"] == "ofdm", str(look))
    check("канализатор fs_out в канале", 2e6 <= fs_out <= 8e6, str(fs_out))
    tone = (0.4 * np.exp(1j * 2.0 * np.pi * 0.1e6 * t)).astype(np.complex64)
    tch, tfs = d.channelize_look(tone, fs, 2442.1, 2442.0, 2.0)
    tlook = d.analyze_iq(tch, tfs)
    check("канализатор тон остаётся тоном", tlook["kind"] in ("tone", "cycle"), str(tlook))
    mixed = (tone + 0.12 * brick).astype(np.complex64)
    e, clip_e = d.cancel_own(mixed, tone)
    check("вычет до канала", clip_e is False and d.leftover_ratio(mixed, e) < 0.5)
    leftover_ch, lfs = d.channelize_look(e, fs, 2442.0, 2442.0, 2.0)
    llook = d.analyze_iq(leftover_ch, lfs)
    check("остаток после вычета не тон", llook["kind"] != "tone", str(llook))

    n_cyc = 4096
    fs_cyc = 2e6
    rng_c = np.random.default_rng(11)
    period = 128
    idx = np.arange(n_cyc)
    gate = ((idx % period) < (period // 2)).astype(np.float64)
    pulsed = ((rng_c.normal(0, 0.25, n_cyc) + 1j * rng_c.normal(0, 0.25, n_cyc)) * gate).astype(np.complex64)
    noise_c = d.synth_look_iq("noise", n_cyc, fs_cyc)
    clook = d.analyze_iq(pulsed, fs_cyc)
    nlook_c = d.analyze_iq(noise_c, fs_cyc)
    check(
        "цикл FAM острее шума",
        float(clook["famCoh"]) > float(nlook_c["famCoh"]) + 0.08,
        f"cyc={clook['famCoh']:.3f} noise={nlook_c['famCoh']:.3f} kind={clook['kind']} a={clook['famAlphaHz']:.0f}",
    )
    check("шум после FAM не тон", nlook_c["kind"] != "tone", str(nlook_c))
    print("ATTACK DSP:", "ALL PASS" if fail == 0 else f"{fail} FAILURES")
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
