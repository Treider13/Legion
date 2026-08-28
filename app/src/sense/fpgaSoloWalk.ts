// ============================================================================
// LEGION — FPGA без сканера: сетка стоянок.
// Коридор ÷ окно (вверх). Окно ≥ коридора → одна стоянка, без прыжков.
// analog/fs на чипе = min(окно, analog платы). Сетка hop считает окно
// оператора, не потолок фильтра: «100 без прыжков» остаётся одной точкой.
// Эфир + сканер сюда не входят.
// ============================================================================
import type { AllowBand } from "../policy/allowlist";
import { ScanWalker, planCenters } from "./scan";

/** Nuand bladeRF 2.0 micro: RF Bandwidth Filter max 56 MHz (IBW). */
export const FPGA_SOLO_MICRO_ANALOG_MHZ = 56;
export const FPGA_SOLO_WINDOW_MIN_MHZ = 0.2;
export const FPGA_SOLO_DWELL_MIN_MS = 200;
export const FPGA_SOLO_DWELL_MAX_MS = 5000;
export const FPGA_SOLO_DWELL_DEFAULT_MS = 500;

export type FpgaSoloPattern = "sweep" | "hop";

export function clampSoloDwellMs(ms: number): number {
  const n = Number.isFinite(ms) && ms > 0 ? ms : FPGA_SOLO_DWELL_DEFAULT_MS;
  return Math.round(Math.min(Math.max(n, FPGA_SOLO_DWELL_MIN_MS), FPGA_SOLO_DWELL_MAX_MS));
}

export function clampSoloHopWindowMhz(want: number): number {
  const w = Number.isFinite(want) && want > 0 ? want : 10;
  return Math.round(Math.max(w, FPGA_SOLO_WINDOW_MIN_MHZ) * 1000) / 1000;
}

/** Фильтр и fs чипа: не шире analog платы (micro 56 МГц). */
export function clampSoloAnalogMhz(windowMhz: number, analogMaxMhz: number): number {
  const cap = analogMaxMhz > 0 ? analogMaxMhz : FPGA_SOLO_MICRO_ANALOG_MHZ;
  const w = clampSoloHopWindowMhz(windowMhz);
  return Math.round(Math.min(w, cap) * 1000) / 1000;
}

/** Волна, которая при синтезе на fs окна занимает почти всё Nyquist. Тон — нет. */
export function waveFillsSoloWindow(kind: string): boolean {
  return (
    kind === "awgn" ||
    kind === "ofdm" ||
    kind === "scfdma" ||
    kind === "otfs" ||
    kind === "afdm" ||
    kind === "ocdm" ||
    kind === "css" ||
    kind === "dsss" ||
    kind === "zadoffchu" ||
    kind === "p4"
  );
}

export interface FpgaSoloWalkInput {
  f1Mhz: number;
  f2Mhz: number;
  windowMhz: number;
  analogMaxMhz?: number;
  dwellMs?: number;
  pattern?: FpgaSoloPattern;
  wave?: string;
}

export interface FpgaSoloWalkPlan {
  ok: boolean;
  reason: string;
  spanMhz: number;
  hopWindowMhz: number;
  analogMhz: number;
  fsHz: number;
  centers: number[];
  hops: number;
  dwellMs: number;
  pattern: FpgaSoloPattern;
  hop: boolean;
  fills: boolean;
  analogClamped: boolean;
  bands: AllowBand[];
}

export function planFpgaSoloWalk(i: FpgaSoloWalkInput): FpgaSoloWalkPlan {
  const analogMax = i.analogMaxMhz ?? FPGA_SOLO_MICRO_ANALOG_MHZ;
  const pattern: FpgaSoloPattern = i.pattern === "hop" ? "hop" : "sweep";
  const dwellMs = clampSoloDwellMs(i.dwellMs ?? FPGA_SOLO_DWELL_DEFAULT_MS);
  const hopWindowMhz = clampSoloHopWindowMhz(i.windowMhz);
  const analogMhz = clampSoloAnalogMhz(hopWindowMhz, analogMax);
  const analogClamped = analogMhz + 1e-9 < hopWindowMhz;
  const fills = waveFillsSoloWindow(i.wave ?? "");
  const empty = (reason: string): FpgaSoloWalkPlan => ({
    ok: false,
    reason,
    spanMhz: 0,
    hopWindowMhz,
    analogMhz,
    fsHz: analogMhz * 1e6,
    centers: [],
    hops: 0,
    dwellMs,
    pattern,
    hop: false,
    fills,
    analogClamped,
    bands: [],
  });
  const f1 = i.f1Mhz;
  const f2 = i.f2Mhz;
  if (!Number.isFinite(f1) || !Number.isFinite(f2) || f1 <= 0 || f2 < f1) {
    return empty("FPGA solo: задайте коридор F1…F2 в мегагерцах");
  }
  const band: AllowBand = { f1Mhz: f1, f2Mhz: f2 };
  if (!(i.windowMhz > 0) || !Number.isFinite(i.windowMhz)) {
    return empty("FPGA solo: задайте окно на усилитель > 0 МГц");
  }
  const spanMhz = Math.round((band.f2Mhz - band.f1Mhz) * 1000) / 1000;
  const centers = planCenters([band], hopWindowMhz);
  const hops = centers.length;
  const hop = hops > 1;
  const how = hop ? (pattern === "hop" ? "случайно" : "туда-сюда") : "без прыжков";
  const fillHint = fills
    ? "волна заполнит окно"
    : "волна узкая — на усилителе палочка, не пятно";
  const clampHint = analogClamped
    ? ` · на усилителе до ${analogMhz} МГц (фильтр micro ≤${analogMax} МГц)`
    : "";
  return {
    ok: true,
    reason: `коридор ${spanMhz} МГц · окно ${hopWindowMhz} МГц → ${hops} ${hops === 1 ? "стоянка" : "стоянки"} · ${how}${clampHint} · ${fillHint}`,
    spanMhz,
    hopWindowMhz,
    analogMhz,
    fsHz: analogMhz * 1e6,
    centers,
    hops,
    dwellMs,
    pattern,
    hop,
    fills,
    analogClamped,
    bands: [band],
  };
}

export function soloWalkLineRu(p: FpgaSoloWalkPlan, idx = 0): string {
  if (!p.ok || p.centers.length === 0) return p.reason;
  const mhz = p.centers[Math.min(Math.max(idx, 0), p.centers.length - 1)];
  return `стоянка ${idx + 1}/${p.hops} · ${mhz.toFixed(3)} МГц · окно ${p.analogMhz} МГц`;
}

/** Сетка = окно оператора. analog платы сюда не кладём: иначе 100 МГц
 *  окно сжалось бы до 56 и hop-сетка разъехалась бы с планом. */
export function makeSoloWalker(plan: FpgaSoloWalkPlan, seed?: number): ScanWalker {
  return new ScanWalker({
    bands: plan.bands,
    pattern: plan.pattern,
    windowMhz: plan.hopWindowMhz,
    analogBwMhz: plan.hopWindowMhz,
    dwellMs: plan.dwellMs,
    seed,
  });
}

export function soloParkOpts(plan: FpgaSoloWalkPlan): { analogMhz: number; spanMhz: number; fsHz: number } {
  return { analogMhz: plan.analogMhz, spanMhz: plan.analogMhz, fsHz: plan.fsHz };
}

export function soloTuneCmd(
  freqMhz: number,
  plan: FpgaSoloWalkPlan,
  token: string,
): Record<string, unknown> {
  return {
    op: "tune",
    freq_mhz: freqMhz,
    fs_hz: plan.fsHz,
    bw_mhz: plan.analogMhz,
    token,
  };
}

/** Прыжки — только micro: шлюз tune пишет AIR_* без USB. x40 — одна стоянка. */
export function soloHopAllowed(sdrId: string): boolean {
  return sdrId === "bladerf-micro-xa4" || sdrId === "bladerf-micro-xa9";
}
