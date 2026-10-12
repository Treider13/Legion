"""Управление FPGA (шаг 7): только через legion_fpga.py (NIOS PIO).

API репозитория используется КАК ЕСТЬ (не переписывается): транспорт —
UsbTransport из legion_gateway.py (pyusb, PERIPHERAL_EP 0x02/0x82),
регистры — LegionFpga. Никакого raw poke.

USB на FX3 — один владелец (факт репозитория: legion_gateway errno 16
«USB занят», sdr_worker SoapySDR #225): пока bladeRF-cli стримит RX,
регистры недоступны. Кооператив: FpgaBridge сам захватывает/отпускает
USB в контрольных окнах (см. pipeline integrate).

АМПЛИТУДА (DTIC/Keysight, ТЗ):
  * рабочий диапазон 0.8…1.0 нормированной магнитуды, 1.0 — физический предел;
  * amp0 + amp1 <= 1.0 — ЖЁСТКО (клиппинг → IMD3 → мощность в мусор);
  * IMD3 <= -30 dBc — порог маскировки;
  * Q15: 0.80=26214, 0.85=27853, 0.90=29491, 0.95=31130, 1.00=32767.
"""
from __future__ import annotations

import logging
import os
import sys
import time
from dataclasses import dataclass, field

import numpy as np

_REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
_FPGA_HOST = os.path.join(_REPO, "fpga", "host")
if _FPGA_HOST not in sys.path:
    sys.path.insert(0, _FPGA_HOST)

import legion_fpga as lf  # noqa: E402  (репозиторный API, как есть)

Q15_UNITY = 32767
AMP_MIN, AMP_MAX = 0.80, 1.00  # рабочий диапазон СУММЫ отводов (ТЗ)
AMP_SUM_MAX = 1.00
IMD3_LIMIT_DBC = -30.0

PLL_SETTLE_S = 0.006  # AD9361 LO settle 6 мс (lock 20–50 мкс, запас 100×)
# RBF 72 МГц: PIO не чаще 1 раза в 4 клока = 55.556 нс; USB bulk >> этого.
MCP_PIO_MIN_S = lf.mcp_pio_min_s()
PIPELINE_EXTRA_SAMPLES = lf.PIPELINE_EXTRA_SAMPLES
AIR_FS_HZ = lf.AIR_FS_FOR_PLL_SCLK_HZ  # 34e6 — эфир AD9361, не USB RX

_log = logging.getLogger(__name__)
_last_pio_t: float | None = None


def reset_pio_write_clock() -> None:
    """Сброс интервала PIO (тесты)."""
    global _last_pio_t
    _last_pio_t = None


def note_pio_write(now: float | None = None) -> str | None:
    """WARN если PIO write чаще MCP_PIO_MIN_S. Не блокирует запись."""
    global _last_pio_t
    t = time.perf_counter() if now is None else float(now)
    msg = None
    if _last_pio_t is not None:
        dt = t - _last_pio_t
        if dt < MCP_PIO_MIN_S:
            msg = (
                f"PIO write interval {dt * 1e9:.1f} ns < "
                f"MCP_PIO_MIN_S {MCP_PIO_MIN_S * 1e9:.3f} ns "
                f"(не чаще 1 раза в 4 клока @ 72 МГц)"
            )
            _log.warning(msg)
    _last_pio_t = t
    return msg


def q15(amp: float) -> int:
    """Нормированная амплитуда → Q15 по таблице ТЗ:
    0.80→26214, 0.85→27853, 0.90→29491, 0.95→31130, 1.00→32767.
    База 32768 [F5]: 0.85 × 32768 = 27852.8 → 27853 (база 32767 дала бы
    27851.95 → 27852 — расход с таблицей). 1.0 clamp'ится в 0x7FFF
    (LB_AMP_Q15_UNITY = 32767)."""
    a = min(max(float(amp), 0.0), 1.0)
    return min(Q15_UNITY, int(round(a * (Q15_UNITY + 1))))


def ftw_from_hz(hz: float, fs_hz: float) -> int:
    """FTW = round(hz/fs·2^32) & 0xFFFFFFFF; |hz| < 0.5 → 0 (как legion_fpga)."""
    if fs_hz <= 0 or abs(hz) < 0.5:
        return 0
    return int(round(hz / fs_hz * (1 << 32))) & 0xFFFFFFFF


@dataclass
class ClassProfile:
    """Класс → регистры (шаг 7.2). amp0+amp1 <= 1.0 проверяется ЖЁСТКО."""
    name: str
    amp0: float
    amp1: float = 0.0
    lb_shift0_hz: float = 0.0
    lb_shift1_hz: float = 0.0
    two_ray: bool = False
    det_thr: int = 0
    proto_period_s: float = 0.0
    proto_pulse_s: float = 0.0
    why: str = ""

    def check(self) -> None:
        """Рабочий диапазон 0.8…1.0 — по СУММЕ отводов (two-ray 0.5+0.5 из
        таблицы ТЗ легален); сумма ≤ 1.0 — жёстко (клиппинг → IMD3)."""
        s = self.amp0 + self.amp1
        if s > AMP_SUM_MAX + 1e-9:
            raise ValueError(f"{self.name}: amp0+amp1={s:.2f} > 1.0 — клиппинг")
        if s < AMP_MIN - 1e-9:
            raise ValueError(f"{self.name}: amp0+amp1={s:.2f} < 0.8 — "
                             f"вне рабочего диапазона")
        for a in (self.amp0, self.amp1):
            if not (0.0 <= a <= AMP_MAX + 1e-9):
                raise ValueError(f"{self.name}: amp {a} вне 0…1.0")


# Таблица 7.2. Обоснование — из спектра класса (поле why).
PROFILES: dict[str, ClassProfile] = {
    # ELRS 2.4, один отвод: FLRC 1.3 Мбит/с — когерентность ~мкс;
    # сдвиг 15 кГц (LB_FTW) декоррелирует канал приёма, плотность энергии
    # в полосе пакета высокая → amp 0.90 без клиппинга (PAPR GFSK низкий).
    "elrs_24": ClassProfile(
        "elrs_24", amp0=0.90, lb_shift0_hz=15e3, det_thr=64,
        proto_period_s=1e-3, proto_pulse_s=100e-6,
        why="FLRC 1.3Mbps: 15 кГц decorr, низкий PAPR → 0.90"),
    # ELRS 2.4 two-ray: два отвода с суммой 1.0 (0.5+0.5) — гребёнка
    # интерференции по частоте, как two-ray канал; сумма жёстко ≤ 1.
    "elrs_24_2ray": ClassProfile(
        "elrs_24_2ray", amp0=0.50, amp1=0.50, two_ray=True,
        lb_shift0_hz=15e3, lb_shift1_hz=45e3, det_thr=64,
        proto_period_s=1e-3, proto_pulse_s=100e-6,
        why="two-ray: гребёнка 0.5+0.5, сумма=1.0"),
    # ELRS 900: LoRa SF6 — широкая полоса 500 кГц, chirp-PAPR умеренный.
    "elrs_900": ClassProfile(
        "elrs_900", amp0=0.85, lb_shift0_hz=10e3, det_thr=64,
        proto_period_s=5e-3, proto_pulse_s=3e-3,
        why="LoRa SF6 500 кГц: 0.85 по PAPR chirp"),
    # Crossfire 868 150 Гц FSK (CRSF 420 kbaud): узкая плотная пачка.
    "crossfire_fsk": ClassProfile(
        "crossfire_fsk", amp0=0.90, lb_shift0_hz=12e3, det_thr=64,
        proto_period_s=1 / 150.0, proto_pulse_s=400e-6,
        why="FSK 420k узкая пачка: 0.90"),
    # Crossfire 868 50 Гц LoRa: длинный пакет, chirp-PAPR.
    "crossfire_lora": ClassProfile(
        "crossfire_lora", amp0=0.85, lb_shift0_hz=10e3, det_thr=64,
        proto_period_s=1 / 50.0, proto_pulse_s=6e-3,
        why="LoRa 50 Гц: 0.85"),
    "orangerx_dsmx": ClassProfile(
        "orangerx_dsmx", amp0=0.85, lb_shift0_hz=10e3, det_thr=64,
        proto_period_s=11e-3, proto_pulse_s=1.2e-3,
        why="DSSS 1.25Mcps пачки 22/11 мс: 0.85"),
    "orangerx_fhss": ClassProfile(
        "orangerx_fhss", amp0=0.85, lb_shift0_hz=10e3, det_thr=64,
        proto_period_s=2e-3, proto_pulse_s=1.8e-3,
        why="FHSS псевдослучайные скачки: 0.85"),
    # TTLRS 9600 baud: очень узкополосный; широкий ответ не нужен.
    "ttlrs": ClassProfile(
        "ttlrs", amp0=0.80, lb_shift0_hz=5e3, det_thr=64,
        proto_period_s=0.02, proto_pulse_s=10e-3,
        why="9600 8N1 узкополосный: 0.80"),
    # Wi-Fi/шум: OFDM PAPR высокий → ниже амплитуда (клиппинг недопустим).
    "wifi_bt": ClassProfile(
        "wifi_bt", amp0=0.80, lb_shift0_hz=0.0, det_thr=64,
        proto_period_s=0.0, proto_pulse_s=0.0,
        why="OFDM высокий PAPR → 0.80 (не 1.0!)"),
    # Аналог FPV: FM константной огибающей + пилотный отвод; 0.8+0.2=1.0.
    "analog_fpv": ClassProfile(
        "analog_fpv", amp0=0.80, amp1=0.20, two_ray=True,
        lb_shift0_hz=0.0, lb_shift1_hz=250e3, det_thr=64,
        why="FM постоянная огибающая: 0.80+0.20=1.00"),
    # MAVLink: спектр SiK GFSK (UART — транспорт, не RF-класс).
    "mavlink": ClassProfile(
        "mavlink", amp0=0.85, lb_shift0_hz=8e3, det_thr=64,
        proto_period_s=0.05, proto_pulse_s=5e-3,
        why="SiK GFSK узкополосный: 0.85"),
    # Miller RFID: ASK backscatter, слабый тег — давим несущую считывателя.
    "miller": ClassProfile(
        "miller", amp0=0.80, lb_shift0_hz=5e3, det_thr=64,
        proto_period_s=0.01, proto_pulse_s=2e-3,
        why="Miller ASK узкий: 0.80"),
    "noise": ClassProfile(
        "noise", amp0=0.80, lb_shift0_hz=0.0, det_thr=64,
        why="широкополосный шум: 0.80 (PAPR → не 1.0)"),
    # Потолок мощности, constant modulus, один отвод.
    "max_power": ClassProfile(
        "max_power", amp0=1.00, lb_shift0_hz=0.0, det_thr=64,
        why="насыщение: 1.00 один отвод"),
}


class FpgaBridge:
    """Кооперативный захват USB → LegionFpga → обязательный release.

    Использование:
        with FpgaBridge() as br:
            br.fpga.arm(...)  # legion_fpga API
    Транспорт — репозиторный UsbTransport (pyusb): claim интерфейса,
    altsetting RF, FPGA-status query, загрузка RBF при пустой FPGA —
    всё как в legion_gateway.py, без переписывания.
    """

    def __init__(self, transport=None):
        self._own = transport is None
        self._t = transport
        self.fpga: "lf.LegionFpga | None" = None

    def __enter__(self) -> "FpgaBridge":
        if self._t is None:
            from legion_gateway import UsbTransport

            self._t = UsbTransport()  # pyusb claim; FPGA пустая → RBF по ENV
        self.fpga = lf.LegionFpga(self._t)
        return self

    def __exit__(self, *exc) -> None:
        if self._own and self._t is not None and hasattr(self._t, "release"):
            self._t.release()  # USB обратно для стрима (один владелец!)
        self.fpga = None


def apply_profile(fpga: "lf.LegionFpga", p: ClassProfile, fs_hz: float,
                  mode: "int | None" = None) -> bool:
    """Класс → регистры через legion_fpga API (шаг 7.1/7.2)."""
    p.check()
    mode = lf.MODE_LB_GATED if mode is None else mode
    q0, q1 = q15(p.amp0), q15(p.amp1)
    if q0 + q1 > Q15_UNITY:
        # Округление до базы 32768 на разделённых отводах (0.5+0.5) даёт
        # +1 LSB сверх unity — жёстко подрезаем второй отвод (Δ < 0.01%).
        q1 = Q15_UNITY - q0
    d1 = lf.twory_delay1(fs_hz) if p.two_ray else 0
    note_pio_write()
    ok = fpga.set_detector(p.det_thr, 8)
    note_pio_write()
    ok = fpga.set_live_drfm(
        delay0=0, delay1=d1,
        ftw0=ftw_from_hz(p.lb_shift0_hz, fs_hz),
        ftw1=ftw_from_hz(p.lb_shift1_hz, fs_hz),
        amp0=q0, amp1=q1,
        period=0, ftw_step=0) and ok
    note_pio_write()
    ok = fpga.set_proto_timing(
        int(round(p.proto_period_s * fs_hz)),
        int(round(p.proto_pulse_s * fs_hz)), 0) and ok
    note_pio_write()
    ok = fpga.arm(mode, True) and ok
    # MCP 55.556 нс: USB PIO уже реже; note_pio_write — WARN, не блок.
    return ok


def disarm(fpga: "lf.LegionFpga") -> bool:
    note_pio_write()
    return fpga.disarm()


# ---- калибровка amp (шаг 7.3) ----

def calibrate_amp(measure_imd3_dbc, amp0: float = 0.80, amp1: float = 0.0,
                  step: float = 0.05, limit_dbc: float = IMD3_LIMIT_DBC) -> dict:
    """Подъём amp0 шагами 0.05 от 0.80, пока IMD3 ≤ limit. При превышении —
    откат на шаг: это рабочий максимум. measure_imd3_dbc(amp0, amp1) → dBc
    (реальный замер спектра: два тона → продукты 2f1−f2/2f2−f1).
    Потолок amp0: 1.0 − amp1 (сумма ≤ 1.0 жёстко)."""
    ceil = AMP_SUM_MAX - amp1
    if ceil > AMP_MAX:
        ceil = AMP_MAX
    hist = []
    work = round(amp0, 9)
    k = 0
    while True:
        # целочисленная сетка шагов — без накопления float-погрешности
        a = round(amp0 + k * step, 9)
        if a > ceil + 1e-9:
            break
        imd3 = float(measure_imd3_dbc(a, amp1))
        hist.append({"amp0": round(a, 3), "amp1": amp1, "imd3_dbc": round(imd3, 2)})
        if imd3 > limit_dbc:
            break  # порог маскировки нарушен — откат на прошлый work
        work = a
        k += 1
    return {"amp0": round(work, 3), "amp1": amp1,
            "sum": round(work + amp1, 3), "history": hist,
            "limit_dbc": limit_dbc}


def measure_imd3_db(iq: np.ndarray, fs_hz: float, f1_hz: float, f2_hz: float,
                    tol_hz: "float | None" = None) -> float:
    """IMD3 двухтонального сигнала, dBc: max(продукты 2f1−f2, 2f2−f1)
    относительно max(f1, f2). Hann + пик в окне ±tol. Комплексный вход —
    частоты со знаком (baseband)."""
    x = np.asarray(iq)
    n = x.size
    if n < 64:
        raise ValueError("IMD3: мало сэмплов")
    tol = tol_hz if tol_hz else 3.0 * fs_hz / n
    w = np.hanning(n)
    X = np.fft.fftshift(np.fft.fft(x * w))
    freqs = np.fft.fftshift(np.fft.fftfreq(n, 1.0 / fs_hz))

    def peak_db(f0: float) -> float:
        m = np.abs(freqs - f0) <= tol
        if not np.any(m):
            return -np.inf
        return float(10.0 * np.log10(np.max(np.abs(X[m]) ** 2) + 1e-20))

    fund = max(peak_db(f1_hz), peak_db(f2_hz))
    im1 = peak_db(2 * f1_hz - f2_hz)
    im2 = peak_db(2 * f2_hz - f1_hz)
    return max(im1, im2) - fund


# ---- LO (шаг 9.3) ----

class LoManager:
    """Перестройка LO: set frequency + выдержка PLL ≥ 100 мкс (фактически
    6 мс, как LO_SETTLE_S в legion_fpga.py). Один LO на все протоколы НЕ
    обещаем: карта класс → LO из synth.CLASS_LO_HZ / ТЗ 9.3."""

    def __init__(self, set_lo_fn, settle_s: float = PLL_SETTLE_S):
        self._set = set_lo_fn
        self._settle = max(float(settle_s), 100e-6)
        self.current_hz: "float | None" = None

    def set(self, hz: float) -> float:
        """Возвращает фактическую паузу settling, с."""
        if self.current_hz == float(hz):
            return 0.0
        self._set(float(hz))
        t0 = time.perf_counter()
        time.sleep(self._settle)
        self.current_hz = float(hz)
        return time.perf_counter() - t0


# ---- упреждающая помеха по confirmed-паттерну (фаза 3 ТЗ) ----

@dataclass
class JamEntry:
    """Один удар плана: [t_jam_start, f_jam, dwell, amp] — ТЗ п.7."""
    t_jam_start: float
    f_jam_hz: float
    dwell_s: float
    amp0: float
    amp1: float = 0.0


def apply_predictive_jam(fpga: "lf.LegionFpga", sub_corridor: dict,
                         pattern: dict, position: int, lo_hz: float,
                         fs_hz: float, horizon: int = 1,
                         amp0: float = 0.90, amp1: float = 0.0) -> dict:
    """Предсказать next_channel и бить УПРЕЖДАЮЩЕ [G4]. Жёсткие правила:
      - pattern.confirmed обязателен (помеха без confirmed ЗАПРЕЩЕНА);
      - каждый f_jam ∈ [sub.f_start, sub.f_end] — иначе ValueError
        (работать в parent коридоре ЗАПРЕЩЕНО);
      - amp0+amp1 ≤ 1.0 [F16], одиночный отвод amp0 ∈ [0.8, 1.0] (ТЗ);
      - регистры — только через legion_fpga API.
    Возвращает {plan, writes, per_write_ms}."""
    from .corridor import in_subcorridor

    if not pattern.get("confirmed"):
        raise ValueError("apply_predictive_jam: паттерн не confirmed — "
                         "помеха запрещена (ТЗ)")
    if amp0 + amp1 > AMP_SUM_MAX + 1e-9:
        raise ValueError(f"amp0+amp1={amp0 + amp1:.2f} > 1.0 [F16]")
    if amp1 == 0.0 and not (AMP_MIN - 1e-9 <= amp0 <= AMP_MAX + 1e-9):
        raise ValueError(f"amp0={amp0} вне 0.8…1.0")
    cyc = pattern.get("cycle") or pattern["hop_sequence"]
    freqs_mhz = (pattern.get("freqs_mhz") or [])[: len(cyc)]
    if not cyc:
        raise ValueError("apply_predictive_jam: пустой цикл паттерна")
    sub = sub_corridor
    plan: list[JamEntry] = []
    t0 = time.perf_counter()
    lat: list[float] = []
    n = max(1, int(horizon))
    for i in range(n):
        idx = (int(position) + 1 + i) % len(cyc)
        f_hz = (freqs_mhz[idx] * 1e6 if idx < len(freqs_mhz)
                else None)
        if f_hz is None:
            raise ValueError("apply_predictive_jam: нет freqs_mhz у паттерна")
        if not in_subcorridor(f_hz, sub):
            raise ValueError(
                f"f_jam {f_hz / 1e6:.3f} МГц вне sub-corridor "
                f"[{sub['f_start'] / 1e6:.3f}…{sub['f_end'] / 1e6:.3f}] — "
                f"parent ЗАПРЕЩЁН")
        plan.append(JamEntry(t_jam_start=t0, f_jam_hz=f_hz,
                             dwell_s=pattern.get("dwell_s", 1e-3),
                             amp0=amp0, amp1=amp1))
    # Первый удар плана — в регистры; горизонт >1 уезжает через preload.
    e = plan[0]
    shift_hz = e.f_jam_hz - float(lo_hz)
    dwell = max(1e-6, float(e.dwell_s))
    w0 = time.perf_counter()
    note_pio_write()
    ok = fpga.set_live_drfm(
        delay0=0, delay1=0,
        ftw0=ftw_from_hz(shift_hz, fs_hz), ftw1=0,
        amp0=q15(e.amp0), amp1=q15(e.amp1),
        period=0, ftw_step=0)
    note_pio_write()
    ok = fpga.set_proto_timing(int(round(dwell * fs_hz)),
                               int(round(dwell * fs_hz)), 0) and ok
    note_pio_write()
    ok = fpga.arm(lf.MODE_LB_ALWAYS, True) and ok  # упреждающе, не по детекту
    lat.append((time.perf_counter() - w0) * 1000.0)
    if not ok:
        raise RuntimeError("apply_predictive_jam: запись регистров не удалась")
    return {"plan": plan, "writes": 3, "per_write_ms": lat,
            "f_jam_hz": e.f_jam_hz, "shift_hz": shift_hz,
            "pipeline_extra_s": lf.pipeline_extra_s(fs_hz),
            "mcp_pio_min_s": MCP_PIO_MIN_S}


def stop_jam(fpga: "lf.LegionFpga") -> bool:
    """Пауза помехи (drift / target silent): disarm + обнулить смеситель
    и амплитуды (0 = обход, не рабочая точка amp)."""
    note_pio_write()
    ok = fpga.disarm()
    note_pio_write()
    ok = fpga.set_live_drfm(delay0=0, delay1=0, ftw0=0, ftw1=0,
                            amp0=0, amp1=0, period=0, ftw_step=0) and ok
    note_pio_write()
    ok = fpga.set_proto_timing(0, 0, 0) and ok
    return ok


__all__ = ["lf", "q15", "ftw_from_hz", "ClassProfile", "PROFILES",
           "FpgaBridge", "apply_profile", "disarm", "calibrate_amp",
           "measure_imd3_db", "LoManager", "AMP_SUM_MAX", "IMD3_LIMIT_DBC",
           "PLL_SETTLE_S", "MCP_PIO_MIN_S", "PIPELINE_EXTRA_SAMPLES",
           "AIR_FS_HZ", "JamEntry", "apply_predictive_jam", "stop_jam",
           "note_pio_write", "reset_pio_write_clock"]
