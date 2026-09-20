import { modeOf } from "../sense/modes";

export type DisplayRange = { f1: number; f2: number };
type RangeState = {
  workspace: string;
  sdrBands: readonly { f1Mhz: number; f2Mhz: number }[];
  sdrF1: string;
  sdrF2: string;
  corrF1: string;
  corrF2: string;
};

function frequency(text: string): number {
  const value = text.trim();
  return /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value) ? Number(value) : Number.NaN;
}

function validRange(f1: number, f2: number): boolean {
  return Number.isFinite(f1) && Number.isFinite(f2) && f1 >= 0 && f2 >= f1 && Number.isFinite(f2 - f1);
}

// Shared presentation rule from SpectrumScope: configured bands take precedence.
// This reads settings only; device validation and commands stay in their existing paths.
export function displayRange(s: RangeState): DisplayRange | null {
  let f1: number;
  let f2: number;
  if (modeOf(s.workspace) === "sdr") {
    if (s.sdrBands.length) {
      if (s.sdrBands.some((b) => !validRange(b.f1Mhz, b.f2Mhz))) return null;
      f1 = Math.min(...s.sdrBands.map((b) => b.f1Mhz));
      f2 = Math.max(...s.sdrBands.map((b) => b.f2Mhz));
    } else {
      f1 = frequency(s.sdrF1);
      f2 = frequency(s.sdrF2);
    }
  } else {
    f1 = frequency(s.corrF1);
    f2 = frequency(s.corrF2);
  }
  return validRange(f1, f2) ? { f1, f2 } : null;
}

// Endpoints preserve the supplied number. A cursor uses the visible pixel resolution.
export function formatFrequency(mhz: number | null, resolution?: number): string {
  if (mhz == null || !Number.isFinite(mhz)) return "—";
  if (resolution != null && Number.isFinite(resolution) && resolution > 0) {
    const digits = Math.min(20, Math.max(3, Math.ceil(-Math.log10(resolution))));
    return String(Number(mhz.toFixed(digits)));
  }
  return String(mhz);
}

export function formatDisplayRange(range: DisplayRange | null): string {
  if (!range) return "Коридор не задан";
  return range.f1 === range.f2
    ? `${formatFrequency(range.f1)} МГц`
    : `${formatFrequency(range.f1)}–${formatFrequency(range.f2)} МГц`;
}

export function displayRangeNotice(range: DisplayRange | null): string | null {
  if (!range) return "Укажите корректные F1 и F2";
  return range.f1 === range.f2 ? `Одна частота · ${formatDisplayRange(range)}` : null;
}

// Bounded, evenly spaced ticks for both canvases, including sub-MHz corridors.
export function frequencyTicks({ f1, f2 }: DisplayRange, width: number): number[] {
  if (!validRange(f1, f2) || f1 === f2) return [];
  const count = Math.max(2, Math.min(8, Math.floor(width / 88)));
  const rough = (f2 - f1) / count;
  const unit = 10 ** Math.floor(Math.log10(rough));
  const fraction = rough / unit;
  const step = unit * (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10);
  if (!Number.isFinite(step) || step <= 0) return [];
  const first = Math.ceil(f1 / step);
  const digits = Math.min(20, Math.max(0, -Math.floor(Math.log10(step))));
  const ticks = new Set<number>();
  for (let i = 0; i <= count + 1; i++) {
    const value = Number(((first + i) * step).toFixed(digits));
    if (value >= f1 && value <= f2) ticks.add(value);
  }
  return [...ticks];
}
