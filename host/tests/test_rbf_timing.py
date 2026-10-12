"""RBF 72 МГц: константы хоста, +2 сэмпла, MCP, md5, timing.rpt."""
import hashlib
import os
import re

import legion_fpga as lf
from legion_rx import fpga_control as fc
from legion_rx.pfb import chans_for_corridor
from legion_rx.pipeline import FS_RBF

_REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
_RBF = os.path.join(
    _REPO, "fpga/vendor/bladerf/hdl/quartus",
    "legionxA4-2026-10-11_23.08.28/legionxA4.rbf")
_RBF_MD5 = "bd0316396c32bb6e615061f3bdf413fe"
_PLL72 = os.path.join(
    _REPO, "fpga/vendor/bladerf/hdl/quartus",
    "timing_close_2026-10-11/pll72")
_PLL_SCLK = "pll_sclk~PLL_OUTPUT_COUNTER|divclk"


def _timing_rpt(seed: int) -> str:
    return os.path.join(_PLL72, f"seed{seed}", "timing.rpt")


def _setup_hold_rows(path: str) -> list[tuple[str, str, str, float, float]]:
    """(corner, kind Setup|Hold, clock, slack, tns) из timing.rpt."""
    rows: list[tuple[str, str, str, float, float]] = []
    corner = ""
    kind = ""
    in_tbl = False
    skip_rule = False
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            m = re.search(
                r"(Slow|Fast) 1100mV (85C|0C) Model (Setup|Hold) Summary",
                line)
            if m:
                corner = f"{m.group(1)} {m.group(2)}"
                kind = m.group(3)
                in_tbl = False
                skip_rule = False
                continue
            if kind and "End Point TNS" in line:
                in_tbl = True
                skip_rule = True
                continue
            if in_tbl and line.startswith("+---"):
                if skip_rule:
                    skip_rule = False
                    continue
                in_tbl = False
                kind = ""
                continue
            if not in_tbl:
                continue
            parts = [p.strip() for p in line.split(";")]
            if len(parts) < 4:
                continue
            try:
                slack = float(parts[2])
                tns = float(parts[3])
            except ValueError:
                continue
            rows.append((corner, kind, parts[1], slack, tns))
    return rows


def test_pll_sclk_and_air_fs():
    assert lf.PLL_SCLK_HZ == 72_000_000
    assert lf.AIR_FS_FOR_PLL_SCLK_HZ == 36_000_000
    assert FS_RBF == 36.0e6
    assert fc.AIR_FS_HZ == 36_000_000


def test_pipeline_plus_two_samples():
    assert lf.PIPELINE_MIXER_SAMPLES == 1
    assert lf.PIPELINE_LB_AIM_SAMPLES == 1
    assert lf.PIPELINE_EXTRA_SAMPLES == 2
    assert fc.PIPELINE_EXTRA_SAMPLES == 2
    extra = lf.pipeline_extra_s(36e6)
    assert abs(extra - 2 / 36e6) < 1e-18
    assert abs(extra - 55.555e-9) < 1e-12  # 55.556 нс, не мкс


def test_twory_delay1_36msps_excludes_pipeline():
    assert lf.twory_delay1(36e6) == 41
    assert lf.twory_delay1(56e6) == 64
    assert lf.twory_delay1(36e6) != 41 + lf.PIPELINE_EXTRA_SAMPLES


def test_mcp_pio_min_55ns():
    assert lf.MCP_SETUP == 4 and lf.MCP_HOLD == 3
    t = lf.mcp_pio_min_s()
    assert abs(t - 4 / 72e6) < 1e-18
    assert abs(t - 55.555e-9) < 1e-12
    assert fc.MCP_PIO_MIN_S == t
    assert fc.PLL_SETTLE_S == 0.006


def test_rbf_md5():
    assert os.path.isfile(_RBF)
    h = hashlib.md5()
    with open(_RBF, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    assert h.hexdigest() == _RBF_MD5


def test_chans_for_corridor_200khz():
    assert chans_for_corridor(16e6) == 80
    assert chans_for_corridor(1.6e6) == 8
    assert chans_for_corridor(200e6) == 512


def test_timing_rpt_seeds_setup_hold_tns():
    """Читает timing.rpt seeds 1–3: setup/hold ≥ 0, TNS = 0."""
    for seed in (1, 2, 3):
        path = _timing_rpt(seed)
        assert os.path.isfile(path), path
        rows = _setup_hold_rows(path)
        assert rows, f"seed{seed}: пустой timing.rpt"
        pll = [r for r in rows if _PLL_SCLK in r[2]]
        assert pll, f"seed{seed}: нет pll_sclk Setup/Hold"
        for corner, kind, clk, slack, tns in pll:
            assert slack >= 0.0, f"seed{seed} {corner} {kind} slack={slack}"
            assert tns == 0.0, f"seed{seed} {corner} {kind} TNS={tns} {clk}"
        assert any(r[1] == "Setup" for r in pll)
        assert any(r[1] == "Hold" for r in pll)


def test_timing_rpt_seed3_slow_0c_margin():
    """Slow 0°C seed3 setup > 0 (rpt: +0.011)."""
    rows = _setup_hold_rows(_timing_rpt(3))
    slow0 = [r for r in rows
             if r[0] == "Slow 0C" and r[1] == "Setup" and _PLL_SCLK in r[2]]
    assert len(slow0) == 1
    slack = slow0[0][3]
    assert slack > 0.0
    assert abs(slack - 0.011) < 1e-9


def test_mcp_pio_warn_not_block():
    fc.reset_pio_write_clock()
    assert fc.note_pio_write(now=0.0) is None
    warn = fc.note_pio_write(now=1e-9)
    assert warn is not None and "MCP_PIO_MIN_S" in warn
    fc.reset_pio_write_clock()
    assert fc.note_pio_write(now=0.0) is None
    assert fc.note_pio_write(now=1e-6) is None
    fc.reset_pio_write_clock()
