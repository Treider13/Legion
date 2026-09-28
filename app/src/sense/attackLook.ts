// ============================================================================
// LEGION — разбор выреза Атаки. Классика AMC (кумулянты / плоскость / FAM),
// не имя борта. Ответ воркера attack_think или запас с одних бинов.
// ============================================================================
import { analogCombRu, ANALOG_COMB_NONE, parseAnalogComb, type AnalogComb } from "./analogComb";
import { binsAroundPeak, cepstrumPeak, spectralFlatness, type AttackWidths } from "./attackMeasure";
import { ATTACK_ASSOC_MHZ } from "./attackTracks";
import {
  droneidModel,
  droneidState,
  droneidStateRu,
  nearestAnalogChannel,
  parseAnalogChannel,
  parseFhssLook,
  type AnalogChannel,
  type DroneidStateFlags,
  type FhssLook,
  type RcId,
} from "./protocolDb";
import type { ScanBin } from "../sdr/types";

export type AttackLookKind = "tone" | "ofdm" | "cycle" | "noise" | "unknown";

export interface DroneidPlain {
  serial?: string;
  latitude?: number;
  longitude?: number;
  altitude?: number;
  height?: number;
  uuid?: string;
  product_type?: number;
  model?: string;
  seqno?: number;
  state_info?: number;
  state?: DroneidStateFlags;
  velocity_north?: number;
  velocity_east?: number;
  velocity_up?: number;
  yaw?: number;
  home_latitude?: number;
  home_longitude?: number;
  phone_app_latitude?: number;
  phone_app_longitude?: number;
}

export interface DroneidLook {
  hit: boolean;
  ok: boolean;
  zcScore: number;
  plain: DroneidPlain | null;
  reason?: string | null;
  encrypted?: boolean;
  zcRoot?: number;
}

export interface OpendroneidLook {
  hit: boolean;
  ok: boolean;
  uas: {
    uasId?: string;
    latitude?: number;
    longitude?: number;
    altGeo?: number;
    operatorId?: string;
    status?: string;
  } | null;
  reason?: string | null;
}

export interface RcLook {
  id: RcId;
  label: string;
  hint: string;
  rateHz: number;
  intervalMs?: number;
  css: boolean;
  cssScore?: number;
  packets?: number;
  spacingMhz?: number;
}

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
  analog: AnalogComb;
  droneid?: DroneidLook | null;
  opendroneid?: OpendroneidLook | null;
  rc?: RcLook | null;
  fhss?: FhssLook | null;
  analogChannel?: AnalogChannel | null;
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
    analog: { ...ANALOG_COMB_NONE },
    droneid: null,
    opendroneid: null,
    rc: null,
    fhss: null,
    analogChannel: null,
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
    analog: parseAnalogComb(raw),
    droneid: parseDroneidLook(raw.droneid),
    opendroneid: parseOpendroneidLook(raw.opendroneid),
    rc: parseRcLook(raw.rc),
    fhss: parseFhssLook(raw.fhss),
    analogChannel:
      parseAnalogChannel(raw.analogChannel) ??
      (parseAnalogComb(raw).hit ? nearestAnalogChannel(freqMhz) : null),
  };
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function finiteNum(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function parseDroneidState(raw: unknown, stateInfo?: number): DroneidStateFlags | undefined {
  const o = asRecord(raw);
  if (o) {
    return {
      serialValid: o.serial_valid === true || o.serialValid === true,
      privacy: o.privacy === true,
      homepoint: o.homepoint === true,
      uuidSet: o.uuid_set === true || o.uuidSet === true,
      motorOn: o.motor_on === true || o.motorOn === true,
      inAir: o.in_air === true || o.inAir === true,
      gpsValid: o.gps_valid === true || o.gpsValid === true,
      altValid: o.alt_valid === true || o.altValid === true,
      heightValid: o.height_valid === true || o.heightValid === true,
      horizValid: o.horiz_valid === true || o.horizValid === true,
      vupValid: o.vup_valid === true || o.vupValid === true,
      pitchrollValid: o.pitchroll_valid === true || o.pitchrollValid === true,
    };
  }
  return droneidState(stateInfo);
}

function parseDroneidLook(raw: unknown): DroneidLook | null {
  const o = asRecord(raw);
  if (!o || o.hit !== true) return null;
  const plainRaw = asRecord(o.plain);
  const productType = finiteNum(plainRaw?.product_type);
  const stateInfo = finiteNum(plainRaw?.state_info);
  const modelRaw = typeof plainRaw?.model === "string" ? plainRaw.model : undefined;
  const plain: DroneidPlain | null = plainRaw
    ? {
        serial: typeof plainRaw.serial === "string" ? plainRaw.serial : undefined,
        latitude: finiteNum(plainRaw.latitude),
        longitude: finiteNum(plainRaw.longitude),
        altitude: finiteNum(plainRaw.altitude),
        height: finiteNum(plainRaw.height),
        uuid: typeof plainRaw.uuid === "string" && plainRaw.uuid ? plainRaw.uuid : undefined,
        product_type: productType,
        model: modelRaw || droneidModel(productType),
        seqno: finiteNum(plainRaw.seqno),
        state_info: stateInfo,
        state: parseDroneidState(plainRaw.state, stateInfo),
        velocity_north: finiteNum(plainRaw.velocity_north),
        velocity_east: finiteNum(plainRaw.velocity_east),
        velocity_up: finiteNum(plainRaw.velocity_up),
        yaw: finiteNum(plainRaw.yaw),
        home_latitude: finiteNum(plainRaw.home_latitude),
        home_longitude: finiteNum(plainRaw.home_longitude),
        phone_app_latitude: finiteNum(plainRaw.phone_app_latitude),
        phone_app_longitude: finiteNum(plainRaw.phone_app_longitude),
      }
    : null;
  return {
    hit: true,
    ok: o.ok === true,
    zcScore: Number(o.zcScore) || 0,
    plain: plain && plain.serial ? plain : null,
    reason: typeof o.reason === "string" ? o.reason : null,
    encrypted: o.encrypted === true,
    zcRoot: Number(o.zcRoot) || 0,
  };
}

function parseOpendroneidLook(raw: unknown): OpendroneidLook | null {
  const o = asRecord(raw);
  if (!o || o.hit !== true) return null;
  const uasRaw = asRecord(o.uas);
  return {
    hit: true,
    ok: o.ok === true,
    uas: uasRaw
      ? {
          uasId: typeof uasRaw.uasId === "string" ? uasRaw.uasId : undefined,
          latitude: Number(uasRaw.latitude),
          longitude: Number(uasRaw.longitude),
          altGeo: Number(uasRaw.altGeo),
          operatorId: typeof uasRaw.operatorId === "string" ? uasRaw.operatorId : undefined,
          status: typeof uasRaw.status === "string" ? uasRaw.status : undefined,
        }
      : null,
    reason: typeof o.reason === "string" ? o.reason : null,
  };
}

function parseRcLook(raw: unknown): RcLook | null {
  const o = asRecord(raw);
  if (!o) return null;
  const idRaw = String(o.id ?? "rc-unknown");
  const known: RcId[] = [
    "elrs",
    "mlrs",
    "elrs-mlrs-50",
    "crossfire",
    "ghost",
    "mlrs-frsky-111",
    "elrs-tracer-250",
    "elrs-ghost-150",
    "elrs-ghost-250",
    "elrs-ghost-500",
    "crossfire-or-fsk-150",
    "rc-unknown",
  ];
  const id: RcId = (known as string[]).includes(idRaw) ? (idRaw as RcId) : "rc-unknown";
  return {
    id,
    label: String(o.label ?? "узкий RC"),
    hint: String(o.hint ?? ""),
    rateHz: Number(o.rateHz) || 0,
    intervalMs: Number(o.intervalMs) || 0,
    css: o.css === true,
    cssScore: Number(o.cssScore) || 0,
    packets: Number(o.packets) || 0,
    spacingMhz: Number(o.spacingMhz) || 0,
  };
}

/**
 * Кого отдать воркеру IQ. Он режет вырез вокруг текущей стоянки.
 * След вне этого окна (915 при слухе на 5800) даёт алиас чужого кадра,
 * и разбор потом висит на чужой частоте. Берём громкие следы внутри окна,
 * не первые по времени создания: hop оставляет десятки старых id.
 */
export function pickAttackThinkTracks<T extends { freqMhz: number; powerDbm: number; state: string }>(
  tracks: readonly T[],
  centerMhz: number,
  spanMhz: number,
  limit = 3,
): T[] {
  if (!Number.isFinite(centerMhz) || !(spanMhz > 0) || limit <= 0) return [];
  const half = spanMhz / 2;
  return tracks
    .filter((t) => t.state !== "cooled" && Math.abs(t.freqMhz - centerMhz) <= half)
    .sort((a, b) => b.powerDbm - a.powerDbm)
    .slice(0, limit);
}

/**
 * Разбор IQ садится на ближайший след и только внутри ворот трекера (0.2 МГц).
 * Первый след в 0.35 МГц забирал чужой разбор: 2440.00 получал OFDM с 2440.30.
 */
export function matchAttackLook<T extends { freqMhz: number }>(
  tracks: readonly T[],
  freqMhz: number,
): T | null {
  if (!Number.isFinite(freqMhz)) return null;
  let best: T | null = null;
  let bestD = Infinity;
  for (const t of tracks) {
    const d = Math.abs(t.freqMhz - freqMhz);
    if (d < bestD) {
      best = t;
      bestD = d;
    }
  }
  if (best == null || bestD > ATTACK_ASSOC_MHZ) return null;
  return best;
}

const YAW_TO_DEG = 57.296;

function fmtPos(lat?: number, lon?: number): string {
  if (lat == null || lon == null || !Number.isFinite(lat) || !Number.isFinite(lon)) return "";
  return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
}

export function droneidPlainLines(p: DroneidPlain): string[] {
  const model = p.model || droneidModel(p.product_type);
  const head = ["DroneID", model, p.serial].filter((x) => !!x).join(" ");
  const lines = [head];
  const pos = fmtPos(p.latitude, p.longitude);
  const alt = p.altitude != null && Number.isFinite(p.altitude) ? `${p.altitude.toFixed(0)} м` : "";
  const h = p.height != null && Number.isFinite(p.height) ? `H ${p.height.toFixed(0)}` : "";
  if (pos || alt || h) lines.push([pos, alt, h].filter(Boolean).join(" · "));
  const vn = p.velocity_north;
  const ve = p.velocity_east;
  const vu = p.velocity_up;
  const vel =
    vn != null && ve != null && vu != null && Number.isFinite(vn) && Number.isFinite(ve) && Number.isFinite(vu)
      ? `N/E/U ${vn.toFixed(0)}/${ve.toFixed(0)}/${vu.toFixed(0)}`
      : "";
  const yaw = p.yaw != null && Number.isFinite(p.yaw) ? `курс ${(p.yaw * YAW_TO_DEG).toFixed(0)}°` : "";
  if (vel || yaw) lines.push([vel, yaw].filter(Boolean).join(" · "));
  const home = fmtPos(p.home_latitude, p.home_longitude);
  if (home) lines.push(`дом ${home}`);
  const flags = droneidStateRu(p.state ?? droneidState(p.state_info));
  const extra = [
    p.seqno != null && Number.isFinite(p.seqno) ? `seq ${p.seqno}` : "",
    p.uuid ? `UUID ${p.uuid}` : "",
    flags,
  ].filter(Boolean);
  if (extra.length) lines.push(extra.join(" · "));
  return lines;
}

export function lookRu(look: AttackLook | undefined): string {
  if (!look) return "разбор ещё копится";
  const pct = Math.round(look.conf * 100);
  const src = look.source === "iq" ? "по памяти IQ" : "по спектру";
  const comb = analogCombRu(look.analog);
  const bits = [look.label];
  if (comb) bits.push(comb);
  if (look.droneid?.ok && look.droneid.plain?.serial) {
    bits.push(droneidPlainLines(look.droneid.plain)[0] || `DroneID ${look.droneid.plain.serial}`);
  } else if (look.droneid?.hit) {
    bits.push(look.droneid.encrypted ? "DroneID без plaintext" : "DroneID ZC");
  }
  if (look.opendroneid?.uas?.uasId) {
    const od = look.opendroneid.uas;
    bits.push(`RID ${od.uasId}${od.status ? ` ${od.status}` : ""}`);
  }
  if (look.rc && look.rc.id !== "rc-unknown") bits.push(look.rc.label);
  if (look.fhss?.hit) {
    const n = look.fhss.unique || look.fhss.hops;
    bits.push(`FHSS ${n} кан. шаг ${look.fhss.spacingMhz.toFixed(2)} МГц`);
  }
  if (look.analogChannel) bits.push(`канал ${look.analogChannel.id}`);
  bits.push(`уверенность ${pct}%`, src);
  return bits.join(" · ");
}
