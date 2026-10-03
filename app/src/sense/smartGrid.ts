// ============================================================================
// LEGION — карточка сетки умной атаки (слух хоста → 0x51–0x59).
// Не подставляет ELRS 2400.4 на пустом эфире. 5.8: ZC/OFDM vs analog.
// FreqCorrection: |shift|≤200 кГц @ 2.4, ≤100 кГц @ 900 (ExpressLRS FHSS.h).
// 900 FCC915 903.5 vs mLRS 902.4: nearest residual, иначе оба ≤ порога.
// Occupancy на плате: CH_PWR vs порог + hyst, как Sandia gr-fhss_utils /
// muccc gr-iridium fft_burst_tagger (бин vs пол, не max-mag).
// ============================================================================
import {
  FHSS_DOMAINS,
  XA4_IBW_MHZ,
  fhssBandOf,
  fhssFilterResidual,
  fhssFreqcorrMaxHz,
  fhssHopSpacingMhz,
  fhssResidualF0,
  nearestAnalogChannel,
  type FhssDomain,
  type FhssLook,
} from "./protocolDb";
import { FHSS_ARM_UNIQUE_MIN } from "./fhssArmGate";
import type { AttackLook } from "./attackLook";
import type { AllowBand } from "../policy/allowlist";

export const LEGION_AIM_NONE = 0xff;
export const LEGION_CH_PWR_THR_DEFAULT = 0x40;
export const LEGION_CH_THR_SLOT_DEFAULT = 256;
export const LEGION_CH_HYST_DEFAULT = 1;
export const LEGION_FREQCORR_MAX_HZ = 200_000;
export const LEGION_GRID_F0_KHZ_GATE = 10_000_000;
export const LEGION_C58_MHZ = 5100;
export const LEGION_XLAT_NULL_BINS = 16;
export const LEGION_O4_MHZ = [5768.5, 5789.5, 5814.5] as const;

export const GRID_KIND_UNKNOWN = 0;
export const GRID_KIND_FHSS = 1;
export const GRID_KIND_OFDM = 2;
export const GRID_KIND_ANALOG = 3;
export const GRID_KIND_ZC = 4;
export const GRID_KIND_CW = 5;

export const GRID_SRC_NONE = 0;
export const GRID_SRC_MATCHER = 1;
export const GRID_SRC_PRESET = 2;
export const GRID_SRC_OPERATOR = 3;
export const GRID_SRC_TILE2 = 4;

export const GRID_FLAG_WINLIM = 1 << 0;
export const GRID_FLAG_F0UNC = 1 << 1;
export const GRID_FLAG_ZC = 1 << 2;
export const GRID_FLAG_FCORR = 1 << 3;

export const CH_PRESET_MANUAL = 0;
export const CH_PRESET_ELRS = 1;
export const CH_PRESET_ISM8 = 2;
export const CH_PRESET_O4VID3 = 3;

export const SMART_GRID_EMPTY_RU = "сетка не собрана — не умная";
export const SMART_GRID_ANALOG_RU = "аналог 5.8 — сетка умной атаки не собирается";
export const SMART_X40_C58_RU = "x40 / LMS6002D не видит 5.8 ГГц — умная атака на C58 только на xA4";

export interface SmartGridCard {
  empty: boolean;
  analog: boolean;
  smart: boolean;
  reason: string;
  f0Hz: number;
  stepHz: number;
  n: number;
  kind: number;
  source: number;
  shiftHz: number;
  priUs: number;
  flags: number;
  packedF0: number;
  meta: number;
  preset: number;
  chPwrThr: number;
  chThr: number;
  chHyst: number;
  chMode: number;
}

export interface SmartGridInput {
  sdrId?: string;
  bands?: readonly AllowBand[];
  hopsMhz?: readonly number[];
  looks?: readonly AttackLook[];
  fhss?: FhssLook | null;
  windowLimited?: boolean;
  ibwMhz?: number;
  operator?: { f0Hz: number; stepHz: number; n: number; kind?: number } | null;
  acceptO4?: boolean;
}

export function packGridF0(f0Hz: number): number {
  if (!Number.isFinite(f0Hz) || f0Hz <= 0) return 0;
  const hz = Math.round(f0Hz);
  if (hz > 0xffffffff) return Math.round(hz / 1000);
  return hz >>> 0;
}

export function packGridMeta(n: number, nUsed: number, conf: number, source: number, kind: number): number {
  return (
    (n & 0xff) |
    ((nUsed & 0xff) << 8) |
    ((conf & 0xff) << 16) |
    ((source & 0xf) << 24) |
    ((kind & 0xf) << 28)
  ) >>> 0;
}

export function packGridFlags(f: {
  windowLimited?: boolean;
  f0Unconfirmed?: boolean;
  zcHit?: boolean;
  freqcorr?: boolean;
  hypIndex?: number;
  hypCount?: number;
  windowBins?: number;
}): number {
  let w = 0;
  if (f.windowLimited) w |= GRID_FLAG_WINLIM;
  if (f.f0Unconfirmed) w |= GRID_FLAG_F0UNC;
  if (f.zcHit) w |= GRID_FLAG_ZC;
  if (f.freqcorr) w |= GRID_FLAG_FCORR;
  w |= ((f.hypIndex ?? 0) & 0xf) << 4;
  w |= ((f.hypCount ?? 0) & 0xff) << 8;
  w |= ((f.windowBins ?? LEGION_XLAT_NULL_BINS) & 0xff) << 16;
  return w >>> 0;
}

export function xlatWindowMhz(fsHz: number): number {
  const fs = Number.isFinite(fsHz) && fsHz > 0 ? fsHz : 56e6;
  return Math.round((fs / LEGION_XLAT_NULL_BINS / 1e4)) / 100;
}

export function bandTouchesC58(bands: readonly AllowBand[] | undefined): boolean {
  return (bands ?? []).some((b) => b.f1Mhz >= LEGION_C58_MHZ || b.f2Mhz >= LEGION_C58_MHZ);
}

export function emptySmartGrid(reason = SMART_GRID_EMPTY_RU): SmartGridCard {
  return {
    empty: true,
    analog: false,
    smart: false,
    reason,
    f0Hz: 0,
    stepHz: 0,
    n: 0,
    kind: GRID_KIND_UNKNOWN,
    source: GRID_SRC_NONE,
    shiftHz: 0,
    priUs: 0,
    flags: packGridFlags({ windowBins: LEGION_XLAT_NULL_BINS }),
    packedF0: 0,
    meta: 0,
    preset: CH_PRESET_MANUAL,
    chPwrThr: 0,
    chThr: 0,
    chHyst: 0,
    chMode: 0,
  };
}

function finish(card: Omit<SmartGridCard, "packedF0" | "meta" | "empty" | "smart">): SmartGridCard {
  const cardLive = card.n > 0 && card.f0Hz > 0 && card.stepHz > 0;
  /* O4VID3 без карточки — fallback LUT, не тихая подстановка ELRS 2400.4. */
  const presetOnly = card.preset === CH_PRESET_O4VID3 && !card.analog;
  const empty = card.analog || (!cardLive && !presetOnly);
  return {
    ...card,
    empty,
    smart: !empty && !card.analog,
    packedF0: packGridF0(card.f0Hz),
    meta: packGridMeta(card.n, card.n, Math.round(0xff * (card.analog ? 0 : 0.7)), card.source, card.kind),
  };
}

function hopMatch(hops: readonly number[], d: FhssDomain): { shiftHz: number; hits: number } | null {
  if (d.spacing <= 0 || hops.length < 2) return null;
  const step = d.spacing * 1e6;
  const f0 = d.f0 * 1e6;
  const shifts: number[] = [];
  for (const h of hops) {
    const hz = h * 1e6;
    const k = Math.round((hz - f0) / step);
    if (k < 0 || k >= d.n) continue;
    const center = f0 + k * step;
    const sh = hz - center;
    if (Math.abs(sh) <= step / 2 + 1) shifts.push(sh);
  }
  if (shifts.length < 2) return null;
  shifts.sort((a, b) => a - b);
  const shiftHz = shifts[Math.floor(shifts.length / 2)]!;
  if ((d.band === "s24" || d.band === "p900") && Math.abs(shiftHz) > fhssFreqcorrMaxHz(d.band)) return null;
  return { shiftHz: Math.round(shiftHz), hits: shifts.length };
}

function collectHops(i: SmartGridInput): number[] {
  const out: number[] = [];
  for (const h of i.hopsMhz ?? []) {
    if (Number.isFinite(h) && h > 0) out.push(h);
  }
  if (i.fhss?.hit) {
    for (const h of i.fhss.hopSetMhz) {
      if (Number.isFinite(h) && h > 0) out.push(h);
    }
  }
  for (const look of i.looks ?? []) {
    if (look.fhss?.hit) {
      for (const h of look.fhss.hopSetMhz) {
        if (Number.isFinite(h) && h > 0) out.push(h);
      }
    }
  }
  return [...new Set(out.map((x) => Math.round(x * 1000) / 1000))];
}

function looksAnalogC58(i: SmartGridInput, hops: readonly number[]): boolean {
  for (const look of i.looks ?? []) {
    if (look.analog?.hit && look.freqMhz >= LEGION_C58_MHZ) return true;
    if (look.analogChannel && look.freqMhz >= LEGION_C58_MHZ) return true;
  }
  const probe = hops.find((h) => h >= LEGION_C58_MHZ);
  if (probe != null && nearestAnalogChannel(probe, 2)) {
    const digital = (i.looks ?? []).some((l) => l.droneid?.hit || l.kind === "ofdm");
    if (!digital) return true;
  }
  return false;
}

function looksZcC58(i: SmartGridInput): boolean {
  return (i.looks ?? []).some((l) => l.droneid?.hit && (l.droneid.zcScore > 0 || l.freqMhz >= LEGION_C58_MHZ));
}

function looksOfdmC58(i: SmartGridInput): boolean {
  return (i.looks ?? []).some((l) => l.kind === "ofdm" && l.freqMhz >= LEGION_C58_MHZ);
}

function looksOfdm24(i: SmartGridInput): boolean {
  return (i.looks ?? []).some(
    (l) => l.kind === "ofdm" && l.freqMhz >= 2400 && l.freqMhz <= 2480 && (l.leftover == null || l.leftover > 0),
  );
}

function pickInputFhss(i: SmartGridInput): FhssLook | null {
  if (i.fhss?.hit) return i.fhss;
  let best: FhssLook | null = null;
  for (const look of i.looks ?? []) {
    const fhss = look.fhss;
    if (!fhss?.hit) continue;
    const n = fhss.unique || fhss.hopSetMhz.length;
    const bestN = best ? best.unique || best.hopSetMhz.length : -1;
    if (!best || n > bestN) best = fhss;
  }
  return best;
}

function measuredF0Mhz(fhss: FhssLook, hops: readonly number[], spacingMhz: number): number | null {
  if (fhss.f0AbsMhz != null && Number.isFinite(fhss.f0AbsMhz) && fhss.f0AbsMhz >= 50) {
    return fhss.f0AbsMhz;
  }
  const { residualMhz, fRefMhz } = fhssResidualF0(hops, spacingMhz);
  const res = fhss.f0ResidualMhz != null && Number.isFinite(fhss.f0ResidualMhz) ? fhss.f0ResidualMhz : residualMhz;
  const abs = fRefMhz + res;
  return abs >= 50 ? abs : null;
}

/** GRID_* из FhssLook. n = unique/hopSet, F0 = f0Abs (f_ref+residual). Не каталог 80 / 2400.4. */
export function gridFromMeasuredFhss(
  fhss: FhssLook | null | undefined,
  hopsMhz: readonly number[] = [],
  windowLimited = false,
): SmartGridCard | null {
  if (!fhss?.hit) return null;
  const hops = [
    ...new Set(
      [...(fhss.hopSetMhz ?? []), ...hopsMhz]
        .filter((h) => Number.isFinite(h) && h > 0)
        .map((h) => Math.round(h * 1000) / 1000),
    ),
  ].sort((a, b) => a - b);
  const unique = fhss.unique || fhss.nSlots || hops.length;
  if (unique < FHSS_ARM_UNIQUE_MIN || hops.length < FHSS_ARM_UNIQUE_MIN) return null;
  const spacing = fhss.spacingMhz > 0 ? fhss.spacingMhz : fhssHopSpacingMhz(hops);
  if (!(spacing >= 0.15)) return null;
  const f0Mhz = measuredF0Mhz(fhss, hops, spacing);
  if (f0Mhz == null) return null;
  const n = Math.min(80, Math.max(FHSS_ARM_UNIQUE_MIN, Math.round(unique)));
  const winLim = windowLimited || fhss.windowLimited === true;
  const mid = hops[Math.floor(hops.length / 2)] ?? f0Mhz;
  const s24 = fhssBandOf(mid) === "s24";
  const elrsLike = s24 && Math.abs(spacing - 1) <= 0.05;
  const label = fhss.domain?.label ? `FHSS ${fhss.domain.label}` : "FHSS look";
  return finish({
    analog: false,
    reason: `${label} · n=${n} · F0 ${f0Mhz.toFixed(3)}`,
    f0Hz: Math.round(f0Mhz * 1e6),
    stepHz: Math.round(spacing * 1e6),
    n,
    kind: GRID_KIND_FHSS,
    source: GRID_SRC_MATCHER,
    shiftHz: 0,
    priUs: 0,
    flags: packGridFlags({
      windowLimited: winLim,
      windowBins: LEGION_XLAT_NULL_BINS,
    }),
    preset: CH_PRESET_MANUAL,
    chPwrThr: LEGION_CH_PWR_THR_DEFAULT,
    chThr: 0,
    chHyst: LEGION_CH_HYST_DEFAULT,
    chMode: elrsLike ? 1 : 0,
  });
}

export function matchSmartGrid(i: SmartGridInput): SmartGridCard {
  if (i.sdrId === "bladerf-x40" && (bandTouchesC58(i.bands) || collectHops(i).some((h) => h >= LEGION_C58_MHZ))) {
    return emptySmartGrid(SMART_X40_C58_RU);
  }

  const op = i.operator;
  if (op && op.f0Hz > 0 && op.stepHz > 0 && op.n > 0) {
    const n = Math.min(80, Math.max(1, Math.round(op.n)));
    const c58 = op.f0Hz >= LEGION_C58_MHZ * 1e6;
    const ofdm = (op.kind ?? 0) === GRID_KIND_OFDM || op.stepHz >= 10e6;
    return finish({
      analog: false,
      reason: c58 ? "карточка 5.8 (оператор)" : "карточка оператора",
      f0Hz: Math.round(op.f0Hz),
      stepHz: Math.round(op.stepHz),
      n,
      kind: op.kind ?? (ofdm ? GRID_KIND_OFDM : GRID_KIND_FHSS),
      source: GRID_SRC_OPERATOR,
      shiftHz: 0,
      priUs: 0,
      flags: packGridFlags({ windowBins: LEGION_XLAT_NULL_BINS }),
      preset: c58 ? CH_PRESET_O4VID3 : ofdm && !c58 ? CH_PRESET_ISM8 : CH_PRESET_ELRS,
      chPwrThr: ofdm && !c58 ? 0 : LEGION_CH_PWR_THR_DEFAULT,
      chThr: ofdm && !c58 ? LEGION_CH_THR_SLOT_DEFAULT : 0,
      chHyst: LEGION_CH_HYST_DEFAULT,
      chMode: ofdm && !c58 ? 0 : 1,
    });
  }

  if (i.acceptO4) {
    return finish({
      analog: false,
      reason: "O4VID3 по умолчанию",
      f0Hz: 0,
      stepHz: 0,
      n: 0,
      kind: GRID_KIND_ZC,
      source: GRID_SRC_PRESET,
      shiftHz: 0,
      priUs: 0,
      flags: packGridFlags({ zcHit: false, windowBins: LEGION_XLAT_NULL_BINS }),
      preset: CH_PRESET_O4VID3,
      chPwrThr: LEGION_CH_PWR_THR_DEFAULT,
      chThr: 0,
      chHyst: LEGION_CH_HYST_DEFAULT,
      chMode: 0,
    });
  }

  const hops = collectHops(i);
  if (looksAnalogC58(i, hops)) {
    return finish({
      analog: true,
      reason: SMART_GRID_ANALOG_RU,
      f0Hz: 0,
      stepHz: 0,
      n: 0,
      kind: GRID_KIND_ANALOG,
      source: GRID_SRC_MATCHER,
      shiftHz: 0,
      priUs: 0,
      flags: packGridFlags({ windowBins: LEGION_XLAT_NULL_BINS }),
      preset: CH_PRESET_MANUAL,
      chPwrThr: 0,
      chThr: 0,
      chHyst: 0,
      chMode: 0,
    });
  }

  const zc = looksZcC58(i);
  if (zc || looksOfdmC58(i)) {
    return finish({
      analog: false,
      reason: zc ? "5.8 цифра · ZC 600/147" : "5.8 цифра · OFDM",
      f0Hz: 0,
      stepHz: 0,
      n: 0,
      kind: zc ? GRID_KIND_ZC : GRID_KIND_OFDM,
      source: GRID_SRC_PRESET,
      shiftHz: 0,
      priUs: 0,
      flags: packGridFlags({ zcHit: zc, windowBins: LEGION_XLAT_NULL_BINS }),
      preset: CH_PRESET_O4VID3,
      chPwrThr: LEGION_CH_PWR_THR_DEFAULT,
      chThr: 0,
      chHyst: LEGION_CH_HYST_DEFAULT,
      chMode: 0,
    });
  }

  const winLim = i.windowLimited === true || i.fhss?.windowLimited === true ||
    (i.looks ?? []).some((l) => l.fhss?.windowLimited);
  const ibw = i.ibwMhz ?? i.fhss?.ibwMhz ?? XA4_IBW_MHZ;
  const hopSpan = hops.length >= 2 ? Math.max(...hops) - Math.min(...hops) : 0;
  const cropped = winLim || hopSpan > ibw + 0.5;

  const measured = gridFromMeasuredFhss(pickInputFhss(i), hops, cropped);
  if (measured && measured.smart && !measured.empty) return measured;

  if (hops.length >= 2) {
    let scored: Array<{ d: FhssDomain; shiftHz: number; hits: number }> = [];
    for (const d of FHSS_DOMAINS) {
      const m = hopMatch(hops, d);
      if (m) scored.push({ d, ...m });
    }
    scored.sort((a, b) => b.hits - a.hits || Math.abs(a.shiftHz) - Math.abs(b.shiftHz));
    if (scored.length > 0) {
      const { residualMhz, fRefMhz } = fhssResidualF0(hops, scored[0]!.d.spacing);
      const mid = hops.length < 3 ? hops[Math.floor(hops.length / 2)]! : [...hops].sort((a, b) => a - b)[Math.floor(hops.length / 2)]!;
      scored = fhssFilterResidual(
        scored,
        residualMhz,
        fRefMhz,
        fhssBandOf(mid),
        (s) => s.d.f0,
        (s) => s.d.spacing,
        hops,
      );
      const best = scored[0]!;
      const families = new Set(scored.filter((s) => s.hits === best.hits).map((s) => s.d.family));
      const unconf = families.size > 1;
      const s24 = best.d.band === "s24";
      const ism8 = s24 && best.d.spacing >= 9.5;
      const elrsLike = s24 && Math.abs(best.d.spacing - 1) <= 0.05;
      const gateHz = fhssFreqcorrMaxHz(best.d.band);
      const fcorr = (best.d.band === "s24" || best.d.band === "p900")
        && Math.abs(best.shiftHz) > 0 && Math.abs(best.shiftHz) <= gateHz;
      return finish({
        analog: false,
        reason: unconf
          ? `FHSS ${[...families].join("/")} — f0 не подтверждён`
          : `${best.d.label}${fcorr ? ` · FreqCorrection ${best.shiftHz} Гц` : ""}`,
        f0Hz: Math.round(best.d.f0 * 1e6),
        stepHz: Math.round(best.d.spacing * 1e6),
        n: Math.min(80, best.d.n),
        kind: ism8 ? GRID_KIND_OFDM : GRID_KIND_FHSS,
        source: GRID_SRC_MATCHER,
        shiftHz: fcorr ? best.shiftHz : 0,
        priUs: 0,
        flags: packGridFlags({
          windowLimited: cropped,
          f0Unconfirmed: unconf,
          freqcorr: fcorr,
          hypCount: scored.length,
          windowBins: LEGION_XLAT_NULL_BINS,
        }),
        preset: ism8 ? CH_PRESET_ISM8 : elrsLike ? CH_PRESET_ELRS : CH_PRESET_MANUAL,
        chPwrThr: ism8 ? 0 : LEGION_CH_PWR_THR_DEFAULT,
        chThr: ism8 ? LEGION_CH_THR_SLOT_DEFAULT : 0,
        chHyst: LEGION_CH_HYST_DEFAULT,
        chMode: elrsLike ? 1 : 0,
      });
    }
  }

  if (looksOfdm24(i)) {
    return finish({
      analog: false,
      reason: "ISM 2.4 · 8×10 МГц",
      f0Hz: 2_400_000_000,
      stepHz: 10_000_000,
      n: 8,
      kind: GRID_KIND_OFDM,
      source: GRID_SRC_MATCHER,
      shiftHz: 0,
      priUs: 0,
      flags: packGridFlags({ windowLimited: cropped, windowBins: LEGION_XLAT_NULL_BINS }),
      preset: CH_PRESET_ISM8,
      chPwrThr: 0,
      chThr: LEGION_CH_THR_SLOT_DEFAULT,
      chHyst: LEGION_CH_HYST_DEFAULT,
      chMode: 0,
    });
  }

  return emptySmartGrid(SMART_GRID_EMPTY_RU);
}

export function xlatAimRu(fsHz: number, ch: number): string {
  const w = xlatWindowMhz(fsHz);
  if (ch === LEGION_AIM_NONE) return `окно ${w} МГц · канал не выбран`;
  return `окно ${w} МГц вокруг канала ${ch}`;
}
