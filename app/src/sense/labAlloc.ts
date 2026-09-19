// ============================================================================
// LEGION — сетка распределений. Парсер и таблица pavsa FrequencyAllocations
// (freq-europe.csv, EFIS ECA). Не выдуманные полосы. Только пересечение
// с RX xA4 70–6000 МГц. Не гейт FPGA.
// ============================================================================
import { FREQ_EUROPE_XA4, type AllocBand } from "./data/freqEuropeXa4";

export type { AllocBand };

export function bandsInSpan(f1: number, f2: number, table: readonly AllocBand[] = FREQ_EUROPE_XA4): AllocBand[] {
  if (!(f2 > f1)) return [];
  return table.filter((b) => b.f2Mhz > f1 && b.f1Mhz < f2);
}

export function allocAtMhz(mhz: number, table: readonly AllocBand[] = FREQ_EUROPE_XA4): AllocBand | null {
  if (!Number.isFinite(mhz)) return null;
  let best: AllocBand | null = null;
  let bestSpan = Number.POSITIVE_INFINITY;
  for (const b of table) {
    if (mhz < b.f1Mhz || mhz > b.f2Mhz) continue;
    const span = b.f2Mhz - b.f1Mhz;
    if (span < bestSpan) {
      best = b;
      bestSpan = span;
    }
  }
  return best;
}

export { FREQ_EUROPE_XA4 };
