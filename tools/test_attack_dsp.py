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
    check("шум не тон", nlook["kind"] in ("noise", "unknown", "ofdm"), str(nlook))
    spec = d.multitaper_dbm(tone)
    freqs = np.linspace(-1, 1, spec.size)
    check("multitaper длина", spec.size == 2048)
    w3 = d.width_xd_b(spec, freqs, freqs[int(np.argmax(spec))], 3)
    check("ширина тона узкая", 0 <= w3 < 0.4)
    e, clip = d.cancel_own(tone + 0.05 * ofdm, tone)
    check("вычет не клип", clip is False)
    check("вычет снижает энергию", d.leftover_ratio(tone + 0.05 * ofdm, e) < 0.5)
    check("память 2^24", d.ATTACK_MEM_CAP == 1 << 24)
    print("ATTACK DSP:", "ALL PASS" if fail == 0 else f"{fail} FAILURES")
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
