"""Шаг 7: таблица класс→регистры, Q15, жёсткая сумма amp, калибровка,
IMD3-замер. Железо не нужно: FakeTransport из legion_gateway.py."""
import time

import numpy as np
import pytest

import legion_fpga as lf
from legion_gateway import FakeTransport
from legion_rx import fpga_control as fc


# ---- Q15 / сумма (ТЗ: 0.8=26214, 0.85=27853, 0.9=29491, 0.95=31130, 1.0=32767)

def test_q15_matches_tz_table():
    assert fc.q15(0.80) == 26214
    assert fc.q15(0.85) == 27853
    assert fc.q15(0.90) == 29491
    assert fc.q15(0.95) == 31130
    assert fc.q15(1.00) == 32767


def test_amp_sum_guard_hard():
    bad = fc.ClassProfile("bad", amp0=0.6, amp1=0.5)
    with pytest.raises(ValueError, match="1.0"):
        bad.check()
    ok = fc.ClassProfile("ok", amp0=0.5, amp1=0.5)
    ok.check()  # сумма ровно 1.0 — легально (two-ray из таблицы ТЗ)
    with pytest.raises(ValueError):
        fc.ClassProfile("low", amp0=0.7).check()  # сумма ниже 0.8


def test_all_profiles_legal_and_cover_classes():
    from legion_rx.synth import CLASSES

    for p in fc.PROFILES.values():
        p.check()
        assert p.amp0 + p.amp1 <= 1.0 + 1e-9  # сумма ≤ 1.0 жёстко
        assert 0.80 <= p.amp0 + p.amp1 <= 1.00  # рабочий диапазон по сумме
    for c in CLASSES:
        assert c in fc.PROFILES, f"класс {c} без профиля FPGA"
    # amp=1.0 запрещён на широкополосный шум (PAPR → клиппинг)
    assert fc.PROFILES["noise"].amp0 <= 0.80
    assert fc.PROFILES["wifi_bt"].amp0 <= 0.80


def test_ftw():
    assert fc.ftw_from_hz(0, 20e6) == 0
    assert fc.ftw_from_hz(15e3, 20e6) == int(round(15e3 / 20e6 * 2 ** 32)) & 0xFFFFFFFF
    assert fc.ftw_from_hz(0.1, 20e6) == 0  # |hz| < 0.5 → обход


# ---- apply_profile через legion_fpga API на FakeTransport

def test_apply_profile_writes_expected_regs():
    t = FakeTransport(board="bladerf2")
    fpga = lf.LegionFpga(t)
    p = fc.PROFILES["elrs_24_2ray"]  # two-ray: оба отвода
    assert fc.apply_profile(fpga, p, 20e6)
    assert t.regs[lf.REG_DET_THR] == p.det_thr
    assert t.regs[lf.REG_LB_FTW] == fc.ftw_from_hz(p.lb_shift0_hz, 20e6)
    assert t.regs[lf.REG_LB_FTW1] == fc.ftw_from_hz(p.lb_shift1_hz, 20e6)
    assert t.regs[lf.REG_LB_DELAY1] == lf.twory_delay1(20e6)
    amp = t.regs[lf.REG_LB_AMP]
    assert (amp & 0xFFFF) == fc.q15(0.50)  # 16384
    # второй отвод подрезан до unity-суммы (0.5+0.5: 16384+16383 = 32767)
    assert ((amp >> 16) & 0xFFFF) == 32767 - fc.q15(0.50)
    assert (amp & 0xFFFF) + ((amp >> 16) & 0xFFFF) <= 32767
    assert t.regs[lf.REG_PROTO_PERIOD] == int(round(p.proto_period_s * 20e6))
    assert t.regs[lf.REG_PROTO_PULSE] == int(round(p.proto_pulse_s * 20e6))
    assert t.regs[lf.REG_CTRL] & lf.CTRL_ARM  # armed lb_gated
    assert ((t.regs[lf.REG_CTRL] >> 1) & 0x7) == lf.MODE_LB_GATED


def test_apply_profile_rejects_sum_violation_before_writes():
    t = FakeTransport(board="bladerf2")
    fpga = lf.LegionFpga(t)
    bad = fc.ClassProfile("bad", amp0=0.9, amp1=0.2)
    with pytest.raises(ValueError):
        fc.apply_profile(fpga, bad, 20e6)
    assert lf.REG_LB_AMP not in t.regs  # ни одной записи не ушло


def test_disarm():
    t = FakeTransport(board="bladerf2")
    fpga = lf.LegionFpga(t)
    fc.apply_profile(fpga, fc.PROFILES["ttlrs"], 20e6)
    assert fc.disarm(fpga)
    assert t.regs[lf.REG_CTRL] == 0


# ---- калибровка amp (шаг 7.3)

def test_calibrate_amp_steps_and_rollback():
    """IMD3 ломается на 0.90 → рабочий максимум 0.85 (откат на шаг)."""
    def fake_measure(a0, a1):
        return -35.0 if a0 <= 0.85 else -25.0

    r = fc.calibrate_amp(fake_measure, amp0=0.80)
    assert r["amp0"] == pytest.approx(0.85)
    assert r["sum"] <= 1.0
    amps = [h["amp0"] for h in r["history"]]
    assert amps == [0.8, 0.85, 0.9]


def test_calibrate_amp_respects_two_ray_ceiling():
    """amp1=0.2 → потолок amp0 = 0.8 (сумма ≤ 1.0)."""
    r = fc.calibrate_amp(lambda a0, a1: -60.0, amp0=0.80, amp1=0.20)
    assert r["amp0"] == pytest.approx(0.80)
    assert all(h["amp0"] + 0.2 <= 1.0 + 1e-9 for h in r["history"])


# ---- IMD3 из спектра (шаг 7.3, замер)

def _two_tones(fs, f1, f2, n, a=0.5):
    t = np.arange(n) / fs
    return a * np.exp(2j * np.pi * f1 * t) + a * np.exp(2j * np.pi * f2 * t)


def test_imd3_clean_tones_deep_floor():
    fs, n = 20e6, 1 << 18
    x = _two_tones(fs, 1e6, 1.7e6, n)
    assert fc.measure_imd3_db(x, fs, 1e6, 1.7e6) < -60.0


def test_imd3_cubic_matches_theory():
    """Комплексная огибающая: y = x·(1 − k·|x|²). Для двух тонов A:
    продукт IMD3 = k·A³, несущая = A·(1 − 3kA²) → отношение kA²/(1−3kA²).
    Целимся в −40 dBc (амплитудное 0.01)."""
    fs, n = 20e6, 1 << 18
    a = 0.5
    r = 0.01  # 10^(−40/20)
    k = r / (a ** 2 * (1 + 3 * r))
    x = _two_tones(fs, 1e6, 1.7e6, n, a)
    y = x * (1.0 - k * np.abs(x) ** 2)
    imd3 = fc.measure_imd3_db(y, fs, 1e6, 1.7e6)
    assert imd3 == pytest.approx(-40.0, abs=2.0)


# ---- LO settling (шаг 9.3: ≥ 100 мкс)

def test_lo_manager_settles_and_skips_same():
    calls = []
    lo = fc.LoManager(lambda hz: calls.append(hz), settle_s=0.001)
    dt = lo.set(868e6)
    assert calls == [868e6]
    assert dt >= 0.001  # фактическая пауза ≥ 100 мкс из ТЗ
    assert lo.set(868e6) == 0.0  # тот же LO — без лишнего settling
    assert len(calls) == 1
