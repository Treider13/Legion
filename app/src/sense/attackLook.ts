// ============================================================================
// LEGION — разбор выреза Атаки. Классика AMC (кумулянты / плоскость / FAM),
// не имя борта. Ответ воркера attack_think или запас с одних бинов.
// ============================================================================
import { binsAroundPeak, cepstrumPeak, spectralFlatness, type AttackWidths } from "./attackMeasure";
import type { ScanBin } from "../sdr/types";

export type AttackLookKind = "tone" | "ofdm" | "cycle" | "noise" | "unknown";

export interface AttackLook {
  freqMhz: number;
  kind: AttackLookKind;
  label: string;
  conf: number;
  flatness: number;
  cepstrum: number;
  famCoh: number;
  famAlphaHz: number;
  c20: number;
  kurt: number;
  clip: boolean;
  leftover: number | null;
  source: "iq" | "bins";
}

export function lookFromBins(bins: readonly ScanBin[], freqMhz: number, widths: AttackWidths): AttackLook {
  const half = Math.max(widths.width26Mhz, widths.occ99Mhz, widths.width3Mhz, 0.8) * 0.8 + 0.4;
  const crop = binsAroundPeak(bins, freqMhz, half, 256);
  const flat = spectralFlatness(crop);
  const cep = cepstrumPeak(crop);
  let kind: AttackLookKind = "unknown";
  let label = "семья не ясна";
  let conf = 0.3;
  if (flat < 0.22 && widths.width3Mhz > 0 && widths.width3Mhz <= 1.5) {
    kind = "tone";
    label = "похоже на тон";
    conf = Math.min(0.8, 0.45 + (1 - flat) * 0.3);
  } else if (cep >= 0.22 && flat >= 0.25) {
    kind = "ofdm";
    label = "решётка / OFDM-подобно";
    conf = Math.min(0.85, 0.4 + cep * 0.4);
  } else if (flat >= 0.45) {
    kind = "noise";
    label = "плоский / шум-подобный";
    conf = Math.min(0.8, 0.35 + flat * 0.4);
  }
  return {
    freqMhz,
    kind,
    label,
    conf,
    flatness: flat,
    cepstrum: cep,
    famCoh: 0,
    famAlphaHz: 0,
    c20: 0,
    kurt: 0,
    clip: false,
    leftover: null,
    source: "bins",
  };
}

export function parseWorkerLook(raw: Record<string, unknown>, freqMhz: number): AttackLook {
  const kindRaw = String(raw.kind ?? "unknown");
  const kind: AttackLookKind =
    kindRaw === "tone" || kindRaw === "ofdm" || kindRaw === "cycle" || kindRaw === "noise"
      ? kindRaw
      : "unknown";
  return {
    freqMhz,
    kind,
    label: String(raw.label ?? "семья не ясна"),
    conf: Number(raw.conf) || 0,
    flatness: Number(raw.flatness) || 0,
    cepstrum: Number(raw.cepstrum) || 0,
    famCoh: Number(raw.famCoh) || 0,
    famAlphaHz: Number(raw.famAlphaHz) || 0,
    c20: Number(raw.c20) || 0,
    kurt: Number(raw.kurt) || 0,
    clip: raw.clip === true,
    leftover: raw.leftover == null ? null : Number(raw.leftover),
    source: "iq",
  };
}

export function lookRu(look: AttackLook | undefined): string {
  if (!look) return "разбор ещё копится";
  const pct = Math.round(look.conf * 100);
  const src = look.source === "iq" ? "по памяти IQ" : "по спектру";
  return `${look.label} · уверенность ${pct}% · ${src}`;
}
