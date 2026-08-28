// ============================================================================
// LEGION — FPGA без сканера: сетка стоянок.
// Коридор ÷ окно (вверх). Окно ≥ коридора → одна стоянка, без прыжков.
// analog на чипе = min(окно, analog платы). Сетка hop считает окно
// оператора, не потолок фильтра: «100 без прыжков» остаётся одной точкой.
// fs = max(analog×1e6, 520834): BW min 200 кГц ≠ sample-rate min AD9361.
// Эфир + сканер сюда не входят.
// ============================================================================
import type { AllowBand } from "../policy/allowlist";
import { mulberry32, planCenters } from "./scan";

/** Nuand bladeRF 2.0 micro: RF Bandwidth Filter max 56 MHz (IBW). */
export const FPGA_SOLO_MICRO_ANALOG_MHZ = 56;
/** Analog BW min (Nuand `bladerf2_bandwidth_range.min` = 200000). */
export const FPGA_SOLO_WINDOW_MIN_MHZ = 0.2;
/** Sample-rate min (Nuand `bladerf2_sample_rate_range.min`). Не 200 кГц. */
export const FPGA_SOLO_FS_MIN_HZ = 520834;
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

/** Фильтр чипа: не шире analog платы (micro 56 МГц). Не sample-rate. */
export function clampSoloAnalogMhz(windowMhz: number, analogMaxMhz: number): number {
  const cap = analogMaxMhz > 0 ? analogMaxMhz : FPGA_SOLO_MICRO_ANALOG_MHZ;
  const w = clampSoloHopWindowMhz(windowMhz);
  return Math.round(Math.min(w, cap) * 1000) / 1000;
}

/** fs для AIR_FS / Soapy TX. Analog 0.2 МГц законен; 200 kS/s — нет. */
export function soloFsHz(analogMhz: number): number {
  const hz = analogMhz * 1e6;
  if (!Number.isFinite(hz) || hz <= 0) return FPGA_SOLO_FS_MIN_HZ;
  return Math.max(Math.round(hz), FPGA_SOLO_FS_MIN_HZ);
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

/** 1 стоянка, 2 стоянки, 5 стоянок, 21 стоянка — не «5 стоянки». */
export function standingWordRu(n: number): string {
  const n10 = n % 10;
  const n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return "стоянка";
  if (n10 >= 2 && n10 <= 4 && (n100 < 10 || n100 > 20)) return "стоянки";
  return "стоянок";
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
    fsHz: soloFsHz(analogMhz),
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
    ? ` · на усилителе до ${analogMhz} МГц (фильтр платы ≤${analogMax} МГц)`
    : "";
  return {
    ok: true,
    reason: `коридор ${spanMhz} МГц · окно ${hopWindowMhz} МГц → ${hops} ${standingWordRu(hops)} · ${how}${clampHint} · ${fillHint}`,
    spanMhz,
    hopWindowMhz,
    analogMhz,
    fsHz: soloFsHz(analogMhz),
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

/**
 * Обход стоянок плана. Sweep = туда-сюда по centers.
 * Hop = случайный выбор из той же сетки (не непрерывный hopCenterInBand
 * хост-скана: иначе 50 МГц на 100 дал бы точки между 2425 и 2475).
 */
export class SoloWalker {
  readonly centers: number[];
  readonly pattern: FpgaSoloPattern;
  private idx = 0;
  private dir = 1;
  private readonly rng: () => number;

  constructor(plan: FpgaSoloWalkPlan, seed?: number) {
    this.centers = plan.centers;
    this.pattern = plan.pattern;
    this.rng = mulberry32(seed ?? 1337);
  }

  next(): { centerMhz: number } {
    if (this.centers.length === 0) return { centerMhz: 0 };
    if (this.pattern === "hop") {
      const i = Math.min(this.centers.length - 1, Math.floor(this.rng() * this.centers.length));
      return { centerMhz: this.centers[i] };
    }
    if (this.centers.length === 1) return { centerMhz: this.centers[0] };
    const centerMhz = this.centers[this.idx];
    const nxt = this.idx + this.dir;
    if (nxt >= this.centers.length || nxt < 0) this.dir *= -1;
    this.idx = Math.min(Math.max(this.idx + this.dir, 0), this.centers.length - 1);
    return { centerMhz };
  }
}

export function makeSoloWalker(plan: FpgaSoloWalkPlan, seed?: number): SoloWalker {
  return new SoloWalker(plan, seed);
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

export const SOLO_HOP_MICRO_ONLY =
  "FPGA solo: прыжки только на bladeRF 2.0 micro (tune LO без USB)";

/** Кино и start: x40 + hops > 1 — не «попробуем tune». */
export function soloHopBlockedReason(sdrId: string, hop: boolean): string | null {
  if (!hop || soloHopAllowed(sdrId)) return null;
  return `${SOLO_HOP_MICRO_ONLY}. На этой плате окно ≥ коридора — одна стоянка.`;
}
