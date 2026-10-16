"""Коридор умной атаки всегда 56 МГц. Удар 0,5 МГц. Взгляд видит пропажу."""
import numpy as np

from legion_rx.smart56 import (
    CORRIDOR_HZ, DIGITIZER_HZ, JAM_HZ, SHIFT_HZ,
    corridor_center, energy_still, find_hop_hz, snap_corridor,
)


def test_corridor_is_always_56_mhz():
    f1, f2 = snap_corridor(2000e6)
    assert f2 - f1 == CORRIDOR_HZ
    assert (f1, f2) == (2000e6, 2056e6)
    f1, f2 = snap_corridor(2100e6)
    assert (f1, f2) == (2100e6, 2156e6)
    assert corridor_center(f1, f2) == 2128e6


def test_jam_width_and_shift_are_the_new_contract():
    from legion_fpga import AIR_FS_FOR_PLL_SCLK_HZ
    from legion_rx.smart56 import DIGITIZER_HZ

    assert JAM_HZ == 0.5e6
    assert SHIFT_HZ == 15_000
    assert DIGITIZER_HZ == AIR_FS_FOR_PLL_SCLK_HZ


def test_scan_proposes_one_corridor_and_does_not_stitch():
    import inspect

    from legion_rx import smart56
    from legion_rx.smart56 import propose_corridor

    a, b = propose_corridor([2400e6, 2410e6, 2420e6, 2500e6])
    assert (a, b) == (2400e6, 2456e6)
    assert propose_corridor([]) is None
    src = inspect.getsource(smart56)
    assert "stitch" not in src
    assert "preload_drfm_shelf" not in src
    assert "set_live_drfm" in src
    assert "also_tx=True" in src
    assert "перенос несущей" in src


def test_one_tone_is_the_hop_and_silence_is_not():
    n = 1024
    lo = 2128e6
    quiet = np.ones(n)
    assert find_hop_hz(quiet, lo, DIGITIZER_HZ) is None
    col = np.ones(n)
    col[n // 2 + 40] = 80.0
    hop = find_hop_hz(col, lo, DIGITIZER_HZ)
    assert hop is not None
    assert abs(hop - (lo + 40 * DIGITIZER_HZ / n)) < 1.0
    assert energy_still(col, hop, lo, DIGITIZER_HZ)
    assert not energy_still(quiet, hop, lo, DIGITIZER_HZ)
