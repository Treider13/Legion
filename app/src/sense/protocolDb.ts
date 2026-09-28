// ============================================================================
// LEGION — базы протоколов / каналов / FHSS. Зеркало tools/protocol_db.py
// Числа из ExpressLRS FHSS.cpp, olliw42/mLRS fhss.h, g3gg0 Crossfire,
// Ghost manual v2.5, IRC/Fatshark + Oscar Liang. Не имя борта в TX.
// ============================================================================

export type RcId =
  | "elrs"
  | "mlrs"
  | "elrs-mlrs-50"
  | "crossfire"
  | "ghost"
  | "mlrs-frsky-111"
  | "elrs-tracer-250"
  | "elrs-ghost-150"
  | "elrs-ghost-250"
  | "elrs-ghost-500"
  | "crossfire-or-fsk-150"
  | "rc-unknown";

export interface FhssDomain {
  id: string;
  family: string;
  label: string;
  band: string;
  f0: number;
  f1: number;
  n: number;
  spacing: number;
  source: string;
  unique: boolean;
}

export interface AnalogChannel {
  id: string;
  band: string;
  mhz: number;
}

export interface FhssLook {
  hit: boolean;
  hops: number;
  unique: number;
  hopSetMhz: number[];
  spacingMhz: number;
  dwellMs: number;
  intervalMs: number;
  rateHz: number;
  hopBwMhz: number;
  spanMhz: number;
  fLowMhz: number;
  fHighMhz: number;
  windowLimited: boolean;
  ibwMhz: number;
  hint: string;
  domain?: { id: string; family: string; label: string; hint: string; unique: boolean } | null;
  pathMhz?: number[];
}

export interface ProtoMatch {
  id: RcId | "fhss-overlap" | "fhss-unknown";
  label: string;
  hint: string;
  unique: boolean;
}

export const XA4_IBW_MHZ = 56;

export const FHSS_DOMAINS: readonly FhssDomain[] = [
  { id: "elrs-ism2g4", family: "elrs", label: "ELRS ISM2G4", band: "s24", f0: 2400.4, f1: 2479.4, n: 80, spacing: 1.0, source: "ExpressLRS FHSS.cpp ISM2G4", unique: false },
  { id: "mlrs-2p4", family: "mlrs", label: "mLRS 2.4", band: "s24", f0: 2401.0, f1: 2480.0, n: 80, spacing: 1.0, source: "olliw42/mLRS fhss.h", unique: false },
  { id: "elrs-fcc915", family: "elrs", label: "ELRS FCC915", band: "p900", f0: 903.5, f1: 926.9, n: 40, spacing: (926.9 - 903.5) / 39, source: "ExpressLRS FHSS.cpp FCC915", unique: false },
  { id: "mlrs-915", family: "mlrs", label: "mLRS 915 FCC", band: "p900", f0: 902.4, f1: 927.6, n: 43, spacing: 0.6, source: "olliw42/mLRS fhss.h", unique: false },
  { id: "elrs-au915", family: "elrs", label: "ELRS AU915", band: "p900", f0: 915.5, f1: 926.9, n: 20, spacing: (926.9 - 915.5) / 19, source: "ExpressLRS FHSS.cpp AU915", unique: false },
  { id: "elrs-eu868", family: "elrs", label: "ELRS EU868", band: "p900", f0: 863.275, f1: 869.575, n: 13, spacing: (869.575 - 863.275) / 12, source: "ExpressLRS FHSS.cpp EU868", unique: false },
  { id: "mlrs-868", family: "mlrs", label: "mLRS 868", band: "p900", f0: 863.275, f1: 868.0, n: 10, spacing: 0.525, source: "olliw42/mLRS fhss.h", unique: false },
  { id: "crossfire-915", family: "crossfire", label: "Crossfire 915", band: "p900", f0: 902.165, f1: 927.905, n: 50, spacing: 0.26, source: "g3gg0.de 50×260 кГц", unique: true },
  { id: "crossfire-868", family: "crossfire", label: "Crossfire 868", band: "p900", f0: 860.165, f1: 885.905, n: 50, spacing: 0.26, source: "g3gg0.de 50×260 кГц", unique: true },
  { id: "crossfire-915-race", family: "crossfire", label: "Crossfire 915 Race", band: "p900", f0: 902.165, f1: 927.905, n: 100, spacing: 0.26, source: "g3gg0.de / TBS Race 100×260 кГц", unique: true },
  { id: "elrs-in866", family: "elrs", label: "ELRS IN866", band: "p900", f0: 865.375, f1: 866.95, n: 4, spacing: (866.95 - 865.375) / 3, source: "ExpressLRS FHSS.cpp IN866", unique: false },
  { id: "elrs-th920", family: "elrs", label: "ELRS TH920", band: "p900", f0: 920.5, f1: 924.7, n: 8, spacing: 0.6, source: "ExpressLRS FHSS.cpp TH920", unique: false },
  { id: "elrs-eu433", family: "elrs", label: "ELRS EU433", band: "uhf", f0: 433.1, f1: 434.45, n: 3, spacing: (434.45 - 433.1) / 2, source: "ExpressLRS FHSS.cpp EU433", unique: false },
  { id: "elrs-au433", family: "elrs", label: "ELRS AU433", band: "uhf", f0: 433.42, f1: 434.42, n: 3, spacing: (434.42 - 433.42) / 2, source: "ExpressLRS FHSS.cpp AU433", unique: false },
  { id: "elrs-us433", family: "elrs", label: "ELRS US433", band: "uhf", f0: 433.25, f1: 438.0, n: 8, spacing: (438.0 - 433.25) / 7, source: "ExpressLRS FHSS.cpp US433", unique: false },
  { id: "elrs-us433w", family: "elrs", label: "ELRS US433W", band: "uhf", f0: 423.5, f1: 438.0, n: 20, spacing: (438.0 - 423.5) / 19, source: "ExpressLRS FHSS.cpp US433W", unique: false },
  { id: "mlrs-433", family: "mlrs", label: "mLRS 433", band: "uhf", f0: 433.36, f1: 433.92, n: 3, spacing: 0, source: "olliw42/mLRS 433.36/433.48/433.92", unique: false },
  { id: "mlrs-70cm", family: "mlrs", label: "mLRS 70cm ham", band: "uhf", f0: 430.4, f1: 449.6, n: 33, spacing: 0.6, source: "olliw42/mLRS fhss.h 70cm 0.6 МГц", unique: false },
  { id: "mlrs-in866", family: "mlrs", label: "mLRS IN866", band: "p900", f0: 865.375, f1: 866.95, n: 4, spacing: 0.525, source: "olliw42/mLRS fhss.h 866 IN", unique: false },
];

export const ANALOG_CHANNELS: readonly AnalogChannel[] = [
  { id: "A1", band: "A", mhz: 5865 }, { id: "A2", band: "A", mhz: 5845 }, { id: "A3", band: "A", mhz: 5825 }, { id: "A4", band: "A", mhz: 5805 },
  { id: "A5", band: "A", mhz: 5785 }, { id: "A6", band: "A", mhz: 5765 }, { id: "A7", band: "A", mhz: 5745 }, { id: "A8", band: "A", mhz: 5725 },
  { id: "B1", band: "B", mhz: 5733 }, { id: "B2", band: "B", mhz: 5752 }, { id: "B3", band: "B", mhz: 5771 }, { id: "B4", band: "B", mhz: 5790 },
  { id: "B5", band: "B", mhz: 5809 }, { id: "B6", band: "B", mhz: 5828 }, { id: "B7", band: "B", mhz: 5847 }, { id: "B8", band: "B", mhz: 5866 },
  { id: "E1", band: "E", mhz: 5705 }, { id: "E2", band: "E", mhz: 5685 }, { id: "E3", band: "E", mhz: 5665 }, { id: "E4", band: "E", mhz: 5645 },
  { id: "E5", band: "E", mhz: 5885 }, { id: "E6", band: "E", mhz: 5905 }, { id: "E7", band: "E", mhz: 5925 }, { id: "E8", band: "E", mhz: 5945 },
  { id: "F1", band: "F", mhz: 5740 }, { id: "F2", band: "F", mhz: 5760 }, { id: "F3", band: "F", mhz: 5780 }, { id: "F4", band: "F", mhz: 5800 },
  { id: "F5", band: "F", mhz: 5820 }, { id: "F6", band: "F", mhz: 5840 }, { id: "F7", band: "F", mhz: 5860 }, { id: "F8", band: "F", mhz: 5880 },
  { id: "R1", band: "R", mhz: 5658 }, { id: "R2", band: "R", mhz: 5695 }, { id: "R3", band: "R", mhz: 5732 }, { id: "R4", band: "R", mhz: 5769 },
  { id: "R5", band: "R", mhz: 5806 }, { id: "R6", band: "R", mhz: 5843 }, { id: "R7", band: "R", mhz: 5880 }, { id: "R8", band: "R", mhz: 5917 },
  { id: "L1", band: "L", mhz: 5333 }, { id: "L2", band: "L", mhz: 5373 }, { id: "L3", band: "L", mhz: 5413 }, { id: "L4", band: "L", mhz: 5453 },
  { id: "L5", band: "L", mhz: 5493 }, { id: "L6", band: "L", mhz: 5533 }, { id: "L7", band: "L", mhz: 5573 }, { id: "L8", band: "L", mhz: 5613 },
  { id: "1G2-1", band: "1.2", mhz: 1080 }, { id: "1G2-2", band: "1.2", mhz: 1120 }, { id: "1G2-3", band: "1.2", mhz: 1160 }, { id: "1G2-4", band: "1.2", mhz: 1200 },
  { id: "1G2-5", band: "1.2", mhz: 1240 }, { id: "1G2-6", band: "1.2", mhz: 1280 }, { id: "1G2-7", band: "1.2", mhz: 1320 }, { id: "1G2-8", band: "1.2", mhz: 1360 },
];

const SPACING_TOL = 0.18;

export const PROTOCOL_CATALOG: readonly { id: string; layer: string; label: string; hint: string }[] = [
  { id: "droneid", layer: "l3", label: "DJI DroneID O2/O3", hint: "proto17 ZC 600/147 + 91 байт. O3+/O4 без decrypt" },
  { id: "opendroneid", layer: "l3", label: "OpenDroneID F3411", hint: "IE 221 FA:0B:BC / BLE 0xFFFA. PHY 802.11 нет" },
  { id: "analog-video", layer: "video", label: "analog PAL/NTSC + IRC", hint: "гребёнка 15625/15734 и A/B/E/F/R/L" },
  { id: "digital-video", layer: "video", label: "цифра 10/20/40", hint: "ширина FCC, не имя модели" },
  { id: "elrs", layer: "rc", label: "ExpressLRS", hint: "CSS 100/333/500 или FLRC 1000" },
  { id: "mlrs", layer: "rc", label: "mLRS", hint: "CSS 19/31 Гц" },
  { id: "crossfire", layer: "rc", label: "TBS Crossfire", hint: "шаг 260 кГц на 868/915" },
  { id: "ghost", layer: "rc", label: "ImmersionRC Ghost", hint: "уникален только CSS 15 Гц Long Range" },
  { id: "elrs-mlrs-50", layer: "rc", label: "50 Гц dual", hint: "ELRS / mLRS / Ghost 55" },
  { id: "elrs-ghost-150", layer: "rc", label: "150 Гц CSS dual", hint: "ELRS 150 / Ghost Race 160" },
  { id: "elrs-ghost-250", layer: "rc", label: "250 Гц CSS dual", hint: "ELRS / Ghost Pure Race" },
  { id: "elrs-ghost-500", layer: "rc", label: "500 Гц FLRC dual", hint: "ELRS FLRC / Ghost Race500" },
  { id: "mlrs-frsky-111", layer: "rc", label: "111 Гц dual", hint: "mLRS FLRC / FrSky ACCST" },
  { id: "elrs-tracer-250", layer: "rc", label: "250 Гц без CSS dual", hint: "ELRS FLRC / Tracer / Ghost MSK" },
  { id: "crossfire-or-fsk-150", layer: "rc", label: "900 150 Гц dual", hint: "Crossfire FSK; ELRS 900 150 нет" },
  ...FHSS_DOMAINS.map((d) => ({
    id: d.id,
    layer: "fhss",
    label: d.label,
    hint: `${d.source}${d.unique ? " · уникален" : " · пересекается"}`,
  })),
];

export function classifyFhssDomain(spacingMhz: number, band: string, freqMhz = 0): ProtoMatch {
  const hits = FHSS_DOMAINS.filter((d) => {
    if (d.spacing <= 0) return false;
    if (band !== "other" && d.band !== band) return false;
    if (freqMhz > 0 && (freqMhz < d.f0 - 5 || freqMhz > d.f1 + 5)) return false;
    return Math.abs(spacingMhz - d.spacing) / d.spacing <= SPACING_TOL;
  });
  if (hits.length === 0) {
    return { id: "fhss-unknown", label: "FHSS, домен не сел", hint: "шаг не из открытых сеток", unique: false };
  }
  const families = new Set(hits.map((h) => h.family));
  const unique = families.size === 1 && hits.every((h) => h.unique);
  const labels = [...new Set(hits.map((h) => h.label))].join(", ");
  if (unique) {
    const fam = hits[0]!.family as RcId;
    return { id: fam, label: labels, hint: `шаг ${spacingMhz.toFixed(3)} МГц — ${hits[0]!.source}`, unique: true };
  }
  return {
    id: "fhss-overlap",
    label: labels,
    hint: `шаг ${spacingMhz.toFixed(3)} МГц общий у ${labels} — не имя фирмы`,
    unique: false,
  };
}

export function nearestAnalogChannel(freqMhz: number, maxDf = 2): AnalogChannel & { dfMhz: number } | null {
  let best: AnalogChannel | null = null;
  let bestD = 1e9;
  for (const ch of ANALOG_CHANNELS) {
    const d = Math.abs(ch.mhz - freqMhz);
    if (d < bestD) {
      bestD = d;
      best = ch;
    }
  }
  if (!best || bestD > maxDf) return null;
  return { ...best, dfMhz: bestD };
}

export function parseFhssLook(raw: unknown): FhssLook | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (o.hit !== true) return null;
  const hopSet = Array.isArray(o.hopSetMhz) ? o.hopSetMhz.map((x) => Number(x)).filter((n) => Number.isFinite(n)) : [];
  const domainRaw = o.domain && typeof o.domain === "object" ? (o.domain as Record<string, unknown>) : null;
  return {
    hit: true,
    hops: Number(o.hops) || 0,
    unique: Number(o.unique) || hopSet.length,
    hopSetMhz: hopSet,
    spacingMhz: Number(o.spacingMhz) || 0,
    dwellMs: Number(o.dwellMs) || 0,
    intervalMs: Number(o.intervalMs) || 0,
    rateHz: Number(o.rateHz) || 0,
    hopBwMhz: Number(o.hopBwMhz) || 0,
    spanMhz: Number(o.spanMhz) || 0,
    fLowMhz: Number(o.fLowMhz) || 0,
    fHighMhz: Number(o.fHighMhz) || 0,
    windowLimited: o.windowLimited === true,
    ibwMhz: Number(o.ibwMhz) || XA4_IBW_MHZ,
    hint: String(o.hint ?? ""),
    domain: domainRaw
      ? {
          id: String(domainRaw.id ?? ""),
          family: String(domainRaw.family ?? ""),
          label: String(domainRaw.label ?? ""),
          hint: String(domainRaw.hint ?? ""),
          unique: domainRaw.unique === true,
        }
      : null,
    pathMhz: Array.isArray(o.pathMhz) ? o.pathMhz.map((x) => Number(x)).filter((n) => Number.isFinite(n)) : [],
  };
}

export function parseAnalogChannel(raw: unknown): AnalogChannel | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== "string" || !Number.isFinite(Number(o.mhz))) return null;
  return { id: o.id, band: String(o.band ?? ""), mhz: Number(o.mhz) };
}

export function hopRailPct(freqMhz: number, fLow: number, fHigh: number): number {
  const span = Math.max(0.2, fHigh - fLow);
  return Math.min(100, Math.max(0, ((freqMhz - fLow) / span) * 100));
}

export function isHopRcId(id: string): boolean {
  return (
    id === "elrs" ||
    id === "mlrs" ||
    id === "elrs-mlrs-50" ||
    id === "crossfire" ||
    id === "ghost" ||
    id === "mlrs-frsky-111" ||
    id === "elrs-tracer-250" ||
    id === "elrs-ghost-150" ||
    id === "elrs-ghost-250" ||
    id === "elrs-ghost-500" ||
    id === "crossfire-or-fsk-150"
  );
}
