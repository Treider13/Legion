// ============================================================================
// LEGION — плейлист полос дронов. Не декодер и не имя фирмы.
// Источники частот (публичные обзоры Oscar Liang / DJI O4 / analog FPV / ELRS):
//   420–450 UHF, 850–930 LRS/ELRS, 1180–1360 analog 1.2,
//   1400–2000 цифра 1.4–2.0, 2400–2485 ISM, 3080–3600 analog 3.3,
//   5150–5250 O4 low (DJI specs), 5320–5950 analog L/U/D 5.3 + 5.8
//   (Oscar Liang LOWRACE 5333–5613 / Raceband 5658–5917).
// 8 слотов — потолок store/NIOS BAND_COUNT. 5 ГГц слиты в две, иначе 9 > 8.
// Клип по RX каталога: xA4 70–6000 (все), x40 300–3800 (без 5.x).
// ============================================================================
import { catalogById } from "../sdr/catalog";
import type { AllowBand } from "../policy/allowlist";

/** Эталонные коридоры. Не каналы протокола и не сетка ELRS. */
export const DRONE_SURVEY_TEMPLATE: readonly AllowBand[] = [
  { f1Mhz: 420, f2Mhz: 450 },
  { f1Mhz: 850, f2Mhz: 930 },
  { f1Mhz: 1180, f2Mhz: 1360 },
  { f1Mhz: 1400, f2Mhz: 2000 },
  { f1Mhz: 2400, f2Mhz: 2485 },
  { f1Mhz: 3080, f2Mhz: 3600 },
  { f1Mhz: 5150, f2Mhz: 5250 },
  { f1Mhz: 5320, f2Mhz: 5950 },
];

export const DRONE_SURVEY_MAX_BANDS = 8;

export function clipBandToRx(band: AllowBand, rx: readonly [number, number]): AllowBand | null {
  const f1 = Math.max(band.f1Mhz, rx[0]);
  const f2 = Math.min(band.f2Mhz, rx[1]);
  if (!(f2 > f1)) return null;
  return { f1Mhz: f1, f2Mhz: f2 };
}

/** Полосы дронов, которые плата реально слышит. Пусто — нет строки каталога. */
export function droneSurveyBands(sdrId: string): AllowBand[] {
  const rx = catalogById(sdrId)?.rxMhz;
  if (!rx) return [];
  const out: AllowBand[] = [];
  for (const band of DRONE_SURVEY_TEMPLATE) {
    const clipped = clipBandToRx(band, rx);
    if (clipped) out.push(clipped);
    if (out.length >= DRONE_SURVEY_MAX_BANDS) break;
  }
  return out;
}

export function droneSurveyLine(sdrId: string): string {
  const bands = droneSurveyBands(sdrId);
  if (bands.length === 0) return "полосы дронов: эта плата не в каталоге RX";
  const row = catalogById(sdrId);
  const rx = row?.rxMhz;
  const miss = DRONE_SURVEY_TEMPLATE.filter((b) => !clipBandToRx(b, rx ?? [0, 0])).length;
  const clip =
    miss > 0 && rx
      ? ` · ${miss} полос 5 ГГц вне RX ${rx[0]}–${rx[1]}`
      : "";
  return `полосы дронов ${bands.length}: ${bands.map((b) => `${b.f1Mhz}–${b.f2Mhz}`).join(", ")}${clip}`;
}

/** Короткое имя коридора. Не протокол и не фирма — только диапазон. */
export function droneBandLabel(band: AllowBand): string {
  const mid = (band.f1Mhz + band.f2Mhz) / 2;
  if (mid < 500) return "UHF";
  if (mid < 1000) return "900";
  if (mid < 1380) return "1.2";
  if (mid < 2200) return "1.4–2.0";
  if (mid < 2800) return "2.4";
  if (mid < 4000) return "3.3";
  if (mid < 5300) return "5.15";
  if (mid < 6000) return "5.3–5.95";
  return "";
}
