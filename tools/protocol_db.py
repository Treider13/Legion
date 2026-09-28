#!/usr/bin/env python3
"""Базы протоколов / каналов / FHSS-доменов. Только проверенные числа.

Источники (код и мануалы, не маркетинг):
  ExpressLRS FHSS.cpp + common.h / common.cpp
    ISM2G4 2400.4…2479.4 / 80 / шаг 1.000 МГц
    FCC915 903.5…926.9 / 40 / шаг 0.600 МГц
    EU868 863.275…869.575 / 13 / шаг 0.525 МГц
    AU915 915.5…926.9 / 20 / шаг 0.600 МГц
    SX1280 AirRate (common.cpp master): LoRa 50/100/150/250/333/500; FLRC 250/500/1000
    25/200 Гц 2.4 есть в enum, в SX1280 RATE_MAX нет
    900 SX127x: 25/50/100/200; LR1121/LR2021: +250 и FSK 1000.
    RATE_LORA_900_150/333/500 в enum есть, в AirRateConfig нет — мёртвые значения
    IN866 865.375…866.950 / 4; TH920 920.5…924.7 / 8×0.6; US433W 423.5…438 / 20
  olliw42/mLRS fhss.h
    2.4: 2401…2480 / 80 / 1 МГц, в эфире 24/18/12
    915 FCC: 902.4…927.6 / 43 / 0.6 МГц
    868: 863.275…868.000 / 10 / 0.525 (три верхних канала вычеркнуты в исходнике)
    866 IN: те же 865.375…866.950 / 4 / 0.525
    433: 433.36 / 433.48 / 433.92 — три точки, не равномерный шаг 0.280
    70cm ham: 430.4…449.6 / 33 / 0.6 МГц
    режимы 50/31/19 LoRa, FLRC 111, FSK 50
  g3gg0.de + TBS Crossfire manual
    915: 902.165…927.905, 50/50, шаг 260 кГц
    868: 860.165…885.905, шаг 260 кГц
    150 Гц FSK (42.48 кГц / 85.1 kBaud), 50 Гц LoRa, 4 Гц
  ImmersionRC Ghost manual v2.5 (не сайт-маркетинг):
    Long Range 15 Гц LoRa; Normal 55 Гц LoRa; Race 160/166 Гц LoRa;
    Pure Race 250 Гц LoRa; Race250/Solid250 250 Гц MSK; Race500 500 Гц MSK.
    62 Гц и 300 Гц в мануале нет.
  IRC/Fatshark + Oscar Liang: Raceband / A/B/E/F / LOWRACE
  ASTM F3411 / opendroneid-core-c; proto17 DroneID
  PMC11314967: STFT FHSS @ 61.44 MSPS, IBW 56 МГц — ровно xA4

Честно не уникально (не имя фирмы):
  50 Гц CSS 2.4 — ELRS, mLRS и Ghost Normal 55
  150 Гц CSS 2.4 — ELRS 150 и Ghost Race 160/166
  250 Гц CSS 2.4 — ELRS 250 и Ghost Pure Race
  500 Гц без CSS 2.4 — ELRS FLRC и Ghost Race500 MSK
  1 МГц сетка 2.4 — ELRS ISM2G4 и mLRS 2.4
  0.6 МГц сетка 900 — ELRS FCC915/AU915/TH920 и mLRS 915 / 70cm
  111 Гц без CSS 2.4 — mLRS FLRC или FrSky ACCST D16 (~9 мс)
  250 Гц без CSS 2.4 — ELRS FLRC/DVDA, TBS Tracer, Ghost Race250 MSK
  150 Гц без CSS на 900 без шага hop — Crossfire FSK; ELRS 900 AirRate 150 нет

xA4: 61.44 MSPS, IBW ≈56 МГц. 900 ISM целиком; 2.4 ISM 83.5 МГц — hop-set обрезан.
Нет 802.11 PHY. Нет decrypt O3+/O4. ПЕРЕДАТЬ протоколы не целится.
"""
from __future__ import annotations

from typing import Any

# --- FHSS-домены -----------------------------------------------------------

def _elrs_span(f0: float, f1: float, n: int) -> float:
    return (f1 - f0) / float(max(n - 1, 1))


FHSS_DOMAINS: tuple[dict[str, Any], ...] = (
    {
        "id": "elrs-ism2g4",
        "family": "elrs",
        "label": "ELRS ISM2G4",
        "band": "s24",
        "f0": 2400.4,
        "f1": 2479.4,
        "n": 80,
        "spacing": 1.0,
        "source": "ExpressLRS FHSS.cpp ISM2G4",
        "unique": False,
        "overlap": ("mlrs-2p4",),
    },
    {
        "id": "mlrs-2p4",
        "family": "mlrs",
        "label": "mLRS 2.4",
        "band": "s24",
        "f0": 2401.0,
        "f1": 2480.0,
        "n": 80,
        "used": (24, 18, 12),
        "spacing": 1.0,
        "source": "olliw42/mLRS fhss.h 2401…2480 / 1 МГц",
        "unique": False,
        "overlap": ("elrs-ism2g4",),
    },
    {
        "id": "elrs-fcc915",
        "family": "elrs",
        "label": "ELRS FCC915",
        "band": "p900",
        "f0": 903.5,
        "f1": 926.9,
        "n": 40,
        "spacing": _elrs_span(903.5, 926.9, 40),
        "source": "ExpressLRS FHSS.cpp FCC915",
        "unique": False,
        "overlap": ("mlrs-915",),
    },
    {
        "id": "mlrs-915",
        "family": "mlrs",
        "label": "mLRS 915 FCC",
        "band": "p900",
        "f0": 902.4,
        "f1": 927.6,
        "n": 43,
        "used": (25,),
        "spacing": 0.6,
        "source": "olliw42/mLRS fhss.h 902.4 + 0.6 МГц",
        "unique": False,
        "overlap": ("elrs-fcc915",),
    },
    {
        "id": "elrs-au915",
        "family": "elrs",
        "label": "ELRS AU915",
        "band": "p900",
        "f0": 915.5,
        "f1": 926.9,
        "n": 20,
        "spacing": _elrs_span(915.5, 926.9, 20),
        "source": "ExpressLRS FHSS.cpp AU915",
        "unique": False,
        "overlap": ("mlrs-915",),
    },
    {
        "id": "elrs-eu868",
        "family": "elrs",
        "label": "ELRS EU868",
        "band": "p900",
        "f0": 863.275,
        "f1": 869.575,
        "n": 13,
        "spacing": _elrs_span(863.275, 869.575, 13),
        "source": "ExpressLRS FHSS.cpp EU868",
        "unique": False,
        "overlap": ("mlrs-868",),
    },
    {
        "id": "mlrs-868",
        "family": "mlrs",
        "label": "mLRS 868",
        "band": "p900",
        "f0": 863.275,
        "f1": 868.000,
        "n": 10,
        "used": (6,),
        "spacing": 0.525,
        "source": "olliw42/mLRS fhss.h 0.525 МГц",
        "unique": False,
        "overlap": ("elrs-eu868",),
    },
    {
        "id": "crossfire-915",
        "family": "crossfire",
        "label": "Crossfire 915",
        "band": "p900",
        "f0": 902.165,
        "f1": 927.905,
        "n": 50,
        "spacing": 0.260,
        "source": "g3gg0.de Crossfire 915: 50×260 кГц",
        "unique": True,
        "overlap": (),
    },
    {
        "id": "crossfire-868",
        "family": "crossfire",
        "label": "Crossfire 868",
        "band": "p900",
        "f0": 860.165,
        "f1": 885.905,
        "n": 50,
        "spacing": 0.260,
        "source": "g3gg0.de Crossfire 868: 50×260 кГц",
        "unique": True,
        "overlap": (),
    },
    {
        "id": "crossfire-915-race",
        "family": "crossfire",
        "label": "Crossfire 915 Race",
        "band": "p900",
        "f0": 902.165,
        "f1": 927.905,
        "n": 100,
        "spacing": 0.260,
        "source": "g3gg0.de / TBS Race: 100 каналов, тот же 260 кГц",
        "unique": True,
        "overlap": (),
    },
    {
        "id": "elrs-in866",
        "family": "elrs",
        "label": "ELRS IN866",
        "band": "p900",
        "f0": 865.375,
        "f1": 866.950,
        "n": 4,
        "spacing": _elrs_span(865.375, 866.950, 4),
        "source": "ExpressLRS FHSS.cpp IN866",
        "unique": False,
        "overlap": ("mlrs-868", "mlrs-in866", "elrs-eu868"),
    },
    {
        "id": "elrs-th920",
        "family": "elrs",
        "label": "ELRS TH920",
        "band": "p900",
        "f0": 920.500,
        "f1": 924.700,
        "n": 8,
        "spacing": 0.600,
        "source": "ExpressLRS FHSS.cpp TH920 NBTC 8×600 кГц",
        "unique": False,
        "overlap": ("elrs-fcc915", "mlrs-915"),
    },
    {
        "id": "elrs-eu433",
        "family": "elrs",
        "label": "ELRS EU433",
        "band": "uhf",
        "f0": 433.100,
        "f1": 434.450,
        "n": 3,
        "spacing": _elrs_span(433.100, 434.450, 3),
        "source": "ExpressLRS FHSS.cpp EU433",
        "unique": False,
        "overlap": ("elrs-au433", "elrs-us433"),
    },
    {
        "id": "elrs-au433",
        "family": "elrs",
        "label": "ELRS AU433",
        "band": "uhf",
        "f0": 433.420,
        "f1": 434.420,
        "n": 3,
        "spacing": _elrs_span(433.420, 434.420, 3),
        "source": "ExpressLRS FHSS.cpp AU433",
        "unique": False,
        "overlap": ("elrs-eu433",),
    },
    {
        "id": "elrs-us433",
        "family": "elrs",
        "label": "ELRS US433",
        "band": "uhf",
        "f0": 433.250,
        "f1": 438.000,
        "n": 8,
        "spacing": _elrs_span(433.250, 438.000, 8),
        "source": "ExpressLRS FHSS.cpp US433",
        "unique": False,
        "overlap": ("elrs-eu433", "elrs-us433w"),
    },
    {
        "id": "elrs-us433w",
        "family": "elrs",
        "label": "ELRS US433W",
        "band": "uhf",
        "f0": 423.500,
        "f1": 438.000,
        "n": 20,
        "spacing": _elrs_span(423.500, 438.000, 20),
        "source": "ExpressLRS FHSS.cpp US433W 423.5…438 / 20",
        "unique": False,
        "overlap": ("elrs-us433", "mlrs-70cm"),
    },
    {
        "id": "mlrs-433",
        "family": "mlrs",
        "label": "mLRS 433",
        "band": "uhf",
        "f0": 433.360,
        "f1": 433.920,
        "n": 3,
        "used": (3,),
        "spacing": 0.0,
        "source": "olliw42/mLRS fhss.h 433.36/433.48/433.92 — не равномерный шаг",
        "unique": False,
        "overlap": ("elrs-eu433", "elrs-au433"),
    },
    {
        "id": "mlrs-70cm",
        "family": "mlrs",
        "label": "mLRS 70cm ham",
        "band": "uhf",
        "f0": 430.4,
        "f1": 449.6,
        "n": 33,
        "spacing": 0.6,
        "source": "olliw42/mLRS fhss.h 70cm 430.4…449.6 / 33 / 0.6 МГц",
        "unique": False,
        "overlap": ("elrs-us433", "elrs-us433w"),
    },
    {
        "id": "mlrs-in866",
        "family": "mlrs",
        "label": "mLRS IN866",
        "band": "p900",
        "f0": 865.375,
        "f1": 866.950,
        "n": 4,
        "spacing": 0.525,
        "source": "olliw42/mLRS fhss.h 866 IN 4×0.525",
        "unique": False,
        "overlap": ("elrs-in866", "mlrs-868", "elrs-eu868"),
    },
)

# --- Сетки скоростей -------------------------------------------------------

# Только то, что реально в AirRateConfig, не «висячий» enum.
ELRS_24_LORA = (50.0, 100.0, 150.0, 250.0, 333.0, 500.0)  # SX1280; 25/200 в enum, в RATE_MAX нет
ELRS_24_FLRC = (250.0, 500.0, 1000.0)
ELRS_900_LORA = (25.0, 50.0, 100.0, 200.0, 250.0)  # SX127x 25…200; LR1121 +250. Нет 150/333/500
ELRS_900_FSK = (1000.0,)  # LR1121 RATE_FSK_900_1000HZ_8CH
MLRS_24_LORA = (19.0, 31.0, 50.0)
MLRS_24_FLRC = (111.0,)
MLRS_900_LORA = (19.0, 31.0)
MLRS_900_FSK = (50.0,)
CROSSFIRE_FSK = (150.0,)
CROSSFIRE_LORA = (50.0, 4.0)
GHOST_CSS_UNIQUE = (15.0,)  # Long Range; Normal 55 и Race 160/166 пересекаются с ELRS
RATE_TOL = 0.10
SPACING_TOL = 0.18

# --- Analog / цифра видео --------------------------------------------------

# IRC / Fatshark / Oscar Liang (публичные таблицы каналов, не имя борта).
ANALOG_CHANNELS: tuple[tuple[str, str, float], ...] = (
    ("A1", "A", 5865.0), ("A2", "A", 5845.0), ("A3", "A", 5825.0), ("A4", "A", 5805.0),
    ("A5", "A", 5785.0), ("A6", "A", 5765.0), ("A7", "A", 5745.0), ("A8", "A", 5725.0),
    ("B1", "B", 5733.0), ("B2", "B", 5752.0), ("B3", "B", 5771.0), ("B4", "B", 5790.0),
    ("B5", "B", 5809.0), ("B6", "B", 5828.0), ("B7", "B", 5847.0), ("B8", "B", 5866.0),
    ("E1", "E", 5705.0), ("E2", "E", 5685.0), ("E3", "E", 5665.0), ("E4", "E", 5645.0),
    ("E5", "E", 5885.0), ("E6", "E", 5905.0), ("E7", "E", 5925.0), ("E8", "E", 5945.0),
    ("F1", "F", 5740.0), ("F2", "F", 5760.0), ("F3", "F", 5780.0), ("F4", "F", 5800.0),
    ("F5", "F", 5820.0), ("F6", "F", 5840.0), ("F7", "F", 5860.0), ("F8", "F", 5880.0),
    ("R1", "R", 5658.0), ("R2", "R", 5695.0), ("R3", "R", 5732.0), ("R4", "R", 5769.0),
    ("R5", "R", 5806.0), ("R6", "R", 5843.0), ("R7", "R", 5880.0), ("R8", "R", 5917.0),
    ("L1", "L", 5333.0), ("L2", "L", 5373.0), ("L3", "L", 5413.0), ("L4", "L", 5453.0),
    ("L5", "L", 5493.0), ("L6", "L", 5533.0), ("L7", "L", 5573.0), ("L8", "L", 5613.0),
    ("1G2-1", "1.2", 1080.0), ("1G2-2", "1.2", 1120.0), ("1G2-3", "1.2", 1160.0),
    ("1G2-4", "1.2", 1200.0), ("1G2-5", "1.2", 1240.0), ("1G2-6", "1.2", 1280.0),
    ("1G2-7", "1.2", 1320.0), ("1G2-8", "1.2", 1360.0),
)

# Полосы видео без имени модели (DJI O4 specs / Oscar Liang / HDZero class).
VIDEO_BANDS: tuple[dict[str, Any], ...] = (
    {"id": "o4-52", "label": "O4/O3 low 5.15–5.25", "f0": 5150.0, "f1": 5250.0, "kind": "digital"},
    {"id": "o4-58", "label": "O4/O3 5.725–5.850", "f0": 5725.0, "f1": 5850.0, "kind": "digital"},
    {"id": "hdzero-r", "label": "HDZero / Avatar класс ~20–27 МГц", "f0": 5640.0, "f1": 5950.0, "kind": "digital-narrow"},
    {"id": "analog-12", "label": "analog 1.2", "f0": 1080.0, "f1": 1360.0, "kind": "analog"},
    {"id": "analog-33", "label": "analog 3.3", "f0": 3080.0, "f1": 3600.0, "kind": "analog"},
    {"id": "analog-53", "label": "analog LOWRACE 5.3", "f0": 5320.0, "f1": 5640.0, "kind": "analog"},
    {"id": "analog-58", "label": "analog 5.8", "f0": 5640.0, "f1": 5950.0, "kind": "analog"},
)

ODID_MSG = {
    0x0: "basic_id",
    0x1: "location",
    0x2: "auth",
    0x3: "self_id",
    0x4: "system",
    0x5: "operator_id",
    0xF: "pack",
}

XA4_IBW_MHZ = 56.0
XA4_FS = 61.44e6


def band_of(freq_mhz: float) -> str:
    f = float(freq_mhz)
    if 134 <= f <= 175:
        return "vhf"
    if 380 <= f <= 525:
        return "uhf"
    if 850 <= f <= 950:
        return "p900"
    if 1080 <= f <= 1360:
        return "l12"
    if 1400 <= f <= 2000:
        return "s14"
    if 2400 <= f <= 2500:
        return "s24"
    if 3080 <= f <= 3600:
        return "c33"
    if 5150 <= f <= 5250:
        return "c51"
    if 5250 < f < 5640:
        return "c53"
    if 5640 <= f <= 5950:
        return "c58"
    return "other"


def _nearest_rate(rate: float, table: tuple[float, ...]) -> tuple[float, float]:
    if rate <= 0 or not table:
        return 0.0, 1e9
    best = min(table, key=lambda x: abs(x - rate) / x)
    return best, abs(best - rate) / best


def in_table(rate: float, table: tuple[float, ...], tol: float = RATE_TOL) -> float | None:
    best, err = _nearest_rate(rate, table)
    if err <= tol:
        return best
    return None


def elrs_channels(f0: float, f1: float, n: int) -> list[float]:
    if n <= 1:
        return [float(f0)]
    step = (float(f1) - float(f0)) / float(n - 1)
    return [float(f0) + i * step for i in range(int(n))]


def match_spacing(
    spacing_mhz: float,
    band: str,
    freq_mhz: float = 0.0,
    f_low: float = 0.0,
    f_high: float = 0.0,
) -> list[dict[str, Any]]:
    """Домены, чей шаг совпал и hop-set пересекает их полосу."""
    sp = float(spacing_mhz)
    if sp <= 0:
        return []
    lo = float(f_low) if f_low else float(freq_mhz)
    hi = float(f_high) if f_high else float(freq_mhz)
    hits: list[dict[str, Any]] = []
    for d in FHSS_DOMAINS:
        if band != "other" and d["band"] != band:
            continue
        if lo and hi:
            if hi < float(d["f0"]) - 2.0 or lo > float(d["f1"]) + 2.0:
                continue
        elif freq_mhz and not (float(d["f0"]) - 5.0 <= float(freq_mhz) <= float(d["f1"]) + 5.0):
            continue
        need = float(d["spacing"])
        if need <= 0:
            continue
        if abs(sp - need) / need <= SPACING_TOL:
            hits.append(d)
    return hits


def classify_fhss_domain(
    spacing_mhz: float,
    freq_mhz: float,
    f_low: float = 0.0,
    f_high: float = 0.0,
) -> dict[str, Any]:
    band = band_of(freq_mhz)
    hits = match_spacing(spacing_mhz, band, freq_mhz, f_low, f_high)
    empty = {
        "id": "fhss-unknown",
        "family": "unknown",
        "label": "FHSS, домен не сел",
        "hint": "шаг hop не из открытых сеток ELRS/mLRS/Crossfire",
        "unique": False,
        "domains": [],
        "spacingMhz": float(spacing_mhz),
    }
    if not hits:
        return empty
    families = {str(h["family"]) for h in hits}
    unique = len(families) == 1 and all(h.get("unique") for h in hits)
    labels = ", ".join(sorted({str(h["label"]) for h in hits}))
    if unique:
        fam = next(iter(families))
        return {
            "id": fam,
            "family": fam,
            "label": labels,
            "hint": f"шаг {spacing_mhz:.3f} МГц — {hits[0]['source']}. Не вход в ПЕРЕДАТЬ",
            "unique": True,
            "domains": [h["id"] for h in hits],
            "spacingMhz": float(spacing_mhz),
        }
    return {
        "id": "fhss-overlap",
        "family": "+".join(sorted(families)),
        "label": labels,
        "hint": f"шаг {spacing_mhz:.3f} МГц общий у {labels} — уникально не приписать",
        "unique": False,
        "domains": [h["id"] for h in hits],
        "spacingMhz": float(spacing_mhz),
    }


def nearest_analog_channel(freq_mhz: float, max_df: float = 2.0) -> dict[str, Any] | None:
    f = float(freq_mhz)
    best: tuple[str, str, float] | None = None
    best_d = 1e9
    for ch, band, mhz in ANALOG_CHANNELS:
        d = abs(mhz - f)
        if d < best_d:
            best_d = d
            best = (ch, band, mhz)
    if best is None or best_d > max_df:
        return None
    return {"id": best[0], "band": best[1], "mhz": best[2], "dfMhz": best_d}


def classify_rc(
    rate_hz: float,
    css: bool,
    band: str,
    hop_spacing_mhz: float = 0.0,
    freq_mhz: float = 0.0,
) -> dict[str, Any]:
    """Имя только когда сетка + (если есть) шаг hop не пересекаются."""
    rate = float(rate_hz)
    subghz = band in ("p900", "uhf")
    spacing = float(hop_spacing_mhz)
    if freq_mhz:
        xf_freq = float(freq_mhz)
    elif band == "p900":
        xf_freq = 915.0
    elif band == "uhf":
        xf_freq = 433.5
    else:
        xf_freq = 2442.0
    xf = classify_fhss_domain(spacing, xf_freq) if spacing > 0 else None

    if css and in_table(rate, GHOST_CSS_UNIQUE, 0.12):
        return {
            "id": "ghost",
            "label": "Ghost Long Range 15 Гц",
            "hint": "CSS 15 Гц — ImmersionRC Ghost v2.5 Long Range; ELRS/mLRS таких режимов нет",
            "matchedHz": 15.0,
        }

    if css:
        mlrs_tab = MLRS_900_LORA if subghz else MLRS_24_LORA
        if in_table(rate, mlrs_tab) in (19.0, 31.0):
            hit = in_table(rate, mlrs_tab)
            return {
                "id": "mlrs",
                "label": f"mLRS LoRa {hit:.0f} Гц",
                "hint": "CSS + 19/31 Гц — сетка olliw42/mLRS, не ELRS",
                "matchedHz": hit,
            }
        if in_table(rate, (50.0,)):
            if subghz and xf and xf["unique"] and xf["family"] == "crossfire":
                return {
                    "id": "crossfire",
                    "label": "Crossfire 50 Гц LoRa",
                    "hint": "50 Гц + шаг 260 кГц — g3gg0/TBS; ELRS/mLRS 900 ходят шагом 0.6/0.525",
                    "matchedHz": 50.0,
                }
            return {
                "id": "elrs-mlrs-50",
                "label": "LoRa ~50 Гц (ELRS / mLRS / Ghost 55)",
                "hint": "50 Гц CSS: ELRS и mLRS; Ghost Normal 55 Гц (v2.5) в 10% — не имя фирмы",
                "matchedHz": 50.0,
            }
        if not subghz:
            if 145.0 <= rate <= 175.0:
                return {
                    "id": "elrs-ghost-150",
                    "label": "CSS 150…166 Гц (ELRS или Ghost Race)",
                    "hint": "ELRS LoRa 150 и Ghost Race 160/166 (v2.5) — по интервалу не разделить",
                    "matchedHz": 150.0,
                }
            if in_table(rate, (250.0,)):
                return {
                    "id": "elrs-ghost-250",
                    "label": "CSS 250 Гц (ELRS или Ghost Pure Race)",
                    "hint": "ELRS LoRa 250 и Ghost Pure Race 250 Гц LoRa — оба CSS",
                    "matchedHz": 250.0,
                }
            hit = in_table(rate, ELRS_24_LORA)
            if hit and hit not in (50.0, 150.0, 250.0):
                return {
                    "id": "elrs",
                    "label": f"ELRS LoRa {hit:.0f} Гц",
                    "hint": "CSS + 100/333/500 — AirRate SX1280; Ghost/mLRS таких LoRa-режимов нет",
                    "matchedHz": hit,
                }
        else:
            hit = in_table(rate, ELRS_900_LORA)
            if hit and hit != 50.0:
                return {
                    "id": "elrs",
                    "label": f"ELRS LoRa {hit:.0f} Гц",
                    "hint": "CSS + 25/100/200/250 на 433/900 — SX127x/LR1121 AirRate; 150 на 900 в таблице нет",
                    "matchedHz": hit,
                }
        return {
            "id": "rc-unknown",
            "label": "CSS / LoRa-подобно",
            "hint": "chirp есть, интервал не сел на сетку ELRS/mLRS/Ghost",
            "matchedHz": 0.0,
        }

    if not subghz:
        if in_table(rate, MLRS_24_FLRC):
            return {
                "id": "mlrs-frsky-111",
                "label": "111 Гц без CSS (mLRS FLRC или FrSky)",
                "hint": "~9 мс: mLRS FLRC 111 и FrSky ACCST D16. Без демода не разделить",
                "matchedHz": 111.0,
            }
        hit = in_table(rate, ELRS_24_FLRC)
        if hit == 250.0:
            return {
                "id": "elrs-tracer-250",
                "label": "250 Гц без CSS (ELRS / Tracer / Ghost)",
                "hint": "ELRS FLRC/DVDA 250, TBS Tracer 250, Ghost Race250 MSK — все 2.4 без LoRa",
                "matchedHz": 250.0,
            }
        if hit == 500.0:
            return {
                "id": "elrs-ghost-500",
                "label": "500 Гц без CSS (ELRS FLRC или Ghost Race500)",
                "hint": "ELRS FLRC 500 и Ghost Race500 MSK (v2.5). 333 FLRC в common.cpp нет",
                "matchedHz": 500.0,
            }
        if hit:
            return {
                "id": "elrs",
                "label": f"ELRS FLRC {hit:.0f} Гц",
                "hint": "без CSS, 1000 Гц — сетка ExpressLRS FLRC; Ghost выше 500 не ходит",
                "matchedHz": hit,
            }
    else:
        if xf and xf["unique"] and xf["family"] == "crossfire":
            if in_table(rate, CROSSFIRE_FSK) or in_table(rate, (150.0,), 0.12):
                return {
                    "id": "crossfire",
                    "label": "Crossfire 150 Гц FSK",
                    "hint": "шаг 260 кГц + ~6.67 мс — g3gg0 FSK 150. ELRS 900 шаг 0.6 МГц",
                    "matchedHz": 150.0,
                }
            if in_table(rate, (50.0,)):
                return {
                    "id": "crossfire",
                    "label": "Crossfire 50 Гц",
                    "hint": "шаг 260 кГц на 900 — Crossfire, не ELRS/mLRS 0.6 МГц",
                    "matchedHz": 50.0,
                }
            return {
                "id": "crossfire",
                "label": "Crossfire FHSS",
                "hint": "шаг 260 кГц на 868/915 — g3gg0/TBS. Скорость не обязательна",
                "matchedHz": rate if rate > 0 else 0.0,
            }
        if in_table(rate, (150.0,), 0.12):
            return {
                "id": "crossfire-or-fsk-150",
                "label": "900 150 Гц без CSS",
                "hint": "Crossfire FSK 150 (g3gg0 6.67 мс) или другой FSK. ELRS 900 AirRate 150 Гц нет",
                "matchedHz": 150.0,
            }
        if in_table(rate, MLRS_900_FSK):
            return {
                "id": "elrs-mlrs-50",
                "label": "900 50 Гц без CSS",
                "hint": "50 Гц на 900: ELRS LoRa/DVDA, mLRS FSK, Crossfire — не разделить без шага hop",
                "matchedHz": 50.0,
            }
        if in_table(rate, ELRS_900_FSK):
            return {
                "id": "elrs",
                "label": "ELRS 900 FSK 1000 Гц",
                "hint": "RATE_FSK_900_1000HZ_8CH в ExpressLRS common.cpp; mLRS 900 так не ходит",
                "matchedHz": 1000.0,
            }
        hit = in_table(rate, ELRS_900_LORA)
        if hit and hit >= 100.0:
            return {
                "id": "elrs",
                "label": f"ELRS 900 {hit:.0f} Гц",
                "hint": "≥100 Гц на 900 — сетка ELRS SX127x/LR1121; mLRS 900 только 19/31 (и FSK 50)",
                "matchedHz": hit,
            }
        if in_table(rate, MLRS_900_LORA):
            hit = in_table(rate, MLRS_900_LORA)
            return {
                "id": "mlrs",
                "label": f"mLRS 900 {hit:.0f} Гц",
                "hint": "19/31 Гц на 900 — mLRS; ELRS 900 так низко не ходит (кроме 25)",
                "matchedHz": hit,
            }

    if xf and xf["unique"]:
        return {
            "id": xf["family"],
            "label": xf["label"],
            "hint": xf["hint"],
            "matchedHz": rate if rate > 0 else 0.0,
        }

    if rate <= 0:
        return {
            "id": "rc-unknown",
            "label": "узкий RC, мало пакетов",
            "hint": "нужно ≥2 пакета в окне памяти (~160 мс) чтобы снять интервал",
            "matchedHz": 0.0,
        }
    return {
        "id": "rc-unknown",
        "label": "узкий RC, сетка не сошлась",
        "hint": "интервал не ELRS/mLRS/Crossfire/Ghost — не имя фирмы",
        "matchedHz": 0.0,
    }


def catalog() -> list[dict[str, Any]]:
    """Полный список того, что прибор вообще умеет честно сказать."""
    rows: list[dict[str, Any]] = [
        {
            "id": "droneid",
            "layer": "l3",
            "label": "DJI DroneID O2/O3 plaintext",
            "hint": "proto17 ZC 600/147 + turbo + 91 байт anarkiwi. O3+/O4 — ZC без decrypt",
        },
        {
            "id": "opendroneid",
            "layer": "l3",
            "label": "OpenDroneID ASTM F3411",
            "hint": "25-байт + IE 221 FA:0B:BC / BLE 0xFFFA. PHY 802.11 на xA4 нет",
        },
        {
            "id": "analog-video",
            "layer": "video",
            "label": "analog PAL/NTSC + канал IRC",
            "hint": "гребёнка 15625/15734 (orecchiette) и таблица A/B/E/F/R/L",
        },
        {
            "id": "digital-video",
            "layer": "video",
            "label": "цифровой линк 10/20/40",
            "hint": "ширина FCC, не имя O3/O4/Walksnail/HDZero",
        },
    ]
    for d in FHSS_DOMAINS:
        rows.append(
            {
                "id": d["id"],
                "layer": "fhss",
                "label": d["label"],
                "hint": d["source"] + (" · уникален" if d["unique"] else " · пересекается"),
            }
        )
    rows.extend(
        [
            {"id": "elrs", "layer": "rc", "label": "ExpressLRS", "hint": "CSS 100/333/500 или FLRC 1000"},
            {"id": "mlrs", "layer": "rc", "label": "mLRS", "hint": "CSS 19/31"},
            {"id": "crossfire", "layer": "rc", "label": "TBS Crossfire", "hint": "шаг 260 кГц на 868/915"},
            {"id": "ghost", "layer": "rc", "label": "ImmersionRC Ghost", "hint": "уникален только CSS 15 Гц Long Range"},
            {"id": "elrs-mlrs-50", "layer": "rc", "label": "50 Гц dual", "hint": "ELRS / mLRS / Ghost 55"},
            {"id": "elrs-ghost-150", "layer": "rc", "label": "150 Гц CSS dual", "hint": "ELRS 150 / Ghost Race 160"},
            {"id": "elrs-ghost-250", "layer": "rc", "label": "250 Гц CSS dual", "hint": "ELRS / Ghost Pure Race"},
            {"id": "elrs-ghost-500", "layer": "rc", "label": "500 Гц FLRC dual", "hint": "ELRS FLRC / Ghost Race500"},
            {"id": "mlrs-frsky-111", "layer": "rc", "label": "111 Гц dual", "hint": "mLRS FLRC / FrSky ACCST"},
            {"id": "elrs-tracer-250", "layer": "rc", "label": "250 Гц без CSS dual", "hint": "ELRS FLRC / Tracer / Ghost MSK"},
            {"id": "crossfire-or-fsk-150", "layer": "rc", "label": "900 150 Гц dual", "hint": "Crossfire FSK; ELRS 900 150 нет"},
        ]
    )
    return rows
