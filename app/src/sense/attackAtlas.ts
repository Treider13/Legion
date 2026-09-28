// ============================================================================
// LEGION — атлас семей эфира для карточки Атаки. Только энергия:
// полоса / ширина / duty / соседи. Не декодер, не вход в TX, не имя фирмы.
// Ширина сначала, потом корзина — иначе 10/20 на 5.8 зовут аналогом.
// ============================================================================
import type { AnalogComb } from "./analogComb";
import type { AttackTrack } from "./attackTracks";
import { ATTACK_VIDEO_BW_MHZ } from "./attackDetect";
import { classifyFhssDomain, nearestAnalogChannel, type AnalogChannel, type FhssLook, type RcId } from "./protocolDb";

export type AttackBand =
  | "vhf"
  | "uhf"
  | "p900"
  | "l12"
  | "s14"
  | "s24"
  | "c33"
  | "c51"
  | "c53"
  | "c58"
  | "other";

export interface AttackAtlasRow {
  id: string;
  label: string;
  hint: string;
}

export interface RcClassHint {
  id: RcId;
  label: string;
  hint: string;
  rateHz?: number;
  css?: boolean;
}

export interface Layer3Hint {
  id: "droneid" | "opendroneid";
  label: string;
  hint: string;
}

export interface AttackClassExtra {
  rc?: RcClassHint | null;
  layer3?: Layer3Hint | null;
  fhss?: FhssLook | null;
  analogChannel?: AnalogChannel | null;
}

export function bandBucket(mhz: number): AttackBand {
  if (mhz >= 134 && mhz <= 175) return "vhf";
  if (mhz >= 380 && mhz <= 525) return "uhf";
  if (mhz >= 850 && mhz <= 950) return "p900";
  if (mhz >= 1080 && mhz <= 1360) return "l12";
  if (mhz >= 1400 && mhz <= 2000) return "s14";
  if (mhz >= 2400 && mhz <= 2500) return "s24";
  if (mhz >= 3080 && mhz <= 3600) return "c33";
  if (mhz >= 5150 && mhz <= 5250) return "c51";
  if (mhz > 5250 && mhz < 5640) return "c53";
  if (mhz >= 5640 && mhz <= 5950) return "c58";
  return "other";
}

// O4 — 5170–5250 и 5725–5850 (DJI specs / Oscar Liang). Mid-C 5250–5640
// это analog LOWRACE/U/D (5333–5613), не цифровой линк дрона.
const DIGITAL_BANDS: readonly AttackBand[] = ["s14", "s24", "c51", "c58"];
const ANALOG_BANDS: readonly AttackBand[] = ["l12", "c33", "c53", "c58"];

export function classifyAttackFamily(
  t: Pick<AttackTrack, "freqMhz" | "widthMhz" | "duty" | "streak">,
  windowMhz?: number,
  comb?: AnalogComb | null,
  extra?: AttackClassExtra | null,
): AttackAtlasRow {
  const band = bandBucket(t.freqMhz);
  const hopLike = t.duty < 0.45 && t.streak <= 2;
  const sticky = t.duty >= 0.7;
  const win = windowMhz != null && windowMhz > 0 ? windowMhz : undefined;
  const analogHit = !!comb?.hit && sticky && t.widthMhz >= ATTACK_VIDEO_BW_MHZ;

  if (analogHit) {
    const std = comb?.kind === "ntsc" ? "NTSC 15734" : "PAL 15625";
    const ch = extra?.analogChannel ?? nearestAnalogChannel(t.freqMhz);
    const chs = ch ? ` · канал ${ch.id} ${ch.mhz.toFixed(0)}` : "";
    return {
      id: "analog-video",
      label: ch ? `аналог ${ch.id}` : "аналоговое видео (гребёнка)",
      hint: `${std} на FM — orecchiette/DragonSig${chs}. Не имя борта`,
    };
  }

  if (extra?.layer3 && (extra.layer3.id === "droneid" || extra.layer3.id === "opendroneid")) {
    return extra.layer3;
  }

  const rc = extra?.rc;
  if (rc && rc.id !== "rc-unknown" && (band === "s24" || band === "p900" || band === "uhf") && t.widthMhz <= 2.5) {
    return { id: rc.id, label: rc.label, hint: rc.hint };
  }
  const fhss = extra?.fhss;
  if (fhss?.hit && fhss.spacingMhz > 0 && (band === "s24" || band === "p900" || band === "uhf") && t.widthMhz <= 2.5) {
    const dom = classifyFhssDomain(fhss.spacingMhz, band, t.freqMhz);
    if (dom.unique) {
      return { id: dom.id, label: dom.label, hint: dom.hint };
    }
  }

  if (t.widthMhz < 6 && band === "p900") {
    return {
      id: "rc-900",
      label: "узкий 900-класс",
      hint: "узкий 900: ELRS, Crossfire и LRS в одном классе — по спектру не разделить",
    };
  }
  if (hopLike && t.widthMhz <= 2 && band === "s24") {
    return {
      id: "rc-24",
      label: "узкий пакетный RC 2.4",
      hint: "узкий hop 2.4: ELRS, mLRS и Tracer в одном классе — по спектру не разделить",
    };
  }
  if (hopLike && t.widthMhz >= 9 && t.widthMhz <= 22 && DIGITAL_BANDS.includes(band)) {
    return {
      id: "digital-burst",
      label: "широкие вспышки",
      hint: "может быть ID-слой; декод только сбоку, не в ПЕРЕДАТЬ",
    };
  }
  if (hopLike && t.widthMhz <= 2) {
    return {
      id: "hop-narrow",
      label: "прыгает / пакетный",
      hint: "низкий duty — «нет в кадре» ≠ нет в полосе",
    };
  }
  if (sticky && win != null && t.widthMhz >= 0.85 * win) {
    return {
      id: "window-fill",
      label: "заполнил окно слуха",
      hint: "фильтр платы уже край — канал может быть шире (60/80 не влезает в 56)",
    };
  }
  if (sticky && t.widthMhz > 22 && t.widthMhz <= 40) {
    return {
      id: "digital-wide",
      label: "широкая цифра / широкое видео",
      hint: "22–40 МГц: analog~30, HDZero~27, цифра 40 — не имя модели",
    };
  }
  if (sticky && t.widthMhz >= 9 && t.widthMhz <= 22 && DIGITAL_BANDS.includes(band)) {
    return {
      id: "digital-video",
      label: "цифровой линк",
      hint: "9–22 МГц класс (FCC 10/20) — не имя модели",
    };
  }
  if (
    comb == null &&
    sticky &&
    t.widthMhz >= ATTACK_VIDEO_BW_MHZ &&
    t.widthMhz <= 16 &&
    ANALOG_BANDS.includes(band)
  ) {
    return {
      id: "analog-video",
      label: "похоже на аналоговое видео",
      hint: "6–16 МГц, высокий duty — похоже на аналоговое видео, имя борта не даём",
    };
  }
  if (sticky && t.widthMhz >= ATTACK_VIDEO_BW_MHZ) {
    return {
      id: "wide-sticky",
      label: "широкое, держится",
      hint: "видеоподобный класс вне типичных FPV-полос",
    };
  }
  if (hopLike) {
    return {
      id: "hop-narrow",
      label: "прыгает / пакетный",
      hint: "низкий duty — «нет в кадре» ≠ нет в полосе",
    };
  }
  return {
    id: "unknown",
    label: "энергия, семья не ясна",
    hint: "нет открытого декодера — имя фирмы не пишем",
  };
}

const TWO_FLOOR: AttackAtlasRow = {
  id: "two-floor",
  label: "два этажа: видео + hop рядом",
  hint: "похоже на FPV: широкое видео и отдельный RC. Имя борта спектр не доказывает",
};

function hopPeer(t: Pick<AttackTrack, "widthMhz" | "duty" | "streak">): boolean {
  return t.duty < 0.45 && t.streak <= 2 && t.widthMhz <= 2;
}

function videoPeer(t: Pick<AttackTrack, "widthMhz" | "duty">): boolean {
  return t.duty >= 0.7 && t.widthMhz >= ATTACK_VIDEO_BW_MHZ;
}

export function extraFromLook(look?: {
  rc?: RcClassHint | null;
  droneid?: { hit?: boolean; ok?: boolean; plain?: { serial?: string; latitude?: number; longitude?: number } | null; encrypted?: boolean; zcScore?: number } | null;
  opendroneid?: { hit?: boolean; ok?: boolean; uas?: { uasId?: string; latitude?: number; longitude?: number } | null } | null;
  fhss?: FhssLook | null;
  analogChannel?: AnalogChannel | null;
} | null): AttackClassExtra | undefined {
  if (!look) return undefined;
  let layer3: Layer3Hint | undefined;
  const did = look.droneid;
  if (did?.ok && did.plain?.serial) {
    const lat = did.plain.latitude;
    const lon = did.plain.longitude;
    const pos =
      lat != null && lon != null && Number.isFinite(lat) && Number.isFinite(lon)
        ? ` · ${lat.toFixed(5)}, ${lon.toFixed(5)}`
        : "";
    layer3 = {
      id: "droneid",
      label: `DroneID ${did.plain.serial}`,
      hint: `Layer 3 DJI O2/O3 plaintext (proto17/anarkiwi)${pos}. Не вход в ПЕРЕДАТЬ`,
    };
  } else if (did?.hit) {
    layer3 = {
      id: "droneid",
      label: did.encrypted ? "DroneID (без plaintext)" : "DroneID ZC",
      hint: did.encrypted
        ? "ZC root 600/147 есть, CRC не сошёлся — O3+/O4 так и задумано, не decrypt"
        : "ZC DroneID, кадр ещё не собран",
    };
  }
  const od = look.opendroneid;
  if (!layer3 && od?.hit) {
    const id = od.uas?.uasId || "Remote ID";
    const lat = od.uas?.latitude;
    const lon = od.uas?.longitude;
    const pos =
      lat != null && lon != null && Number.isFinite(lat) && Number.isFinite(lon)
        ? ` · ${lat.toFixed(5)}, ${lon.toFixed(5)}`
        : "";
    layer3 = {
      id: "opendroneid",
      label: `OpenDroneID ${id}`,
      hint: `ASTM F3411 / IE 221 FA:0B:BC${pos}. PHY 802.11 на xA4 не демодулируем`,
    };
  }
  return { rc: look.rc ?? undefined, layer3, fhss: look.fhss ?? undefined, analogChannel: look.analogChannel ?? undefined };
}

export function atlasForTracks(
  tracks: readonly AttackTrack[],
  windowMhz?: number,
  combs?: ReadonlyMap<number, AnalogComb>,
  looks?: ReadonlyMap<number, Parameters<typeof extraFromLook>[0]>,
): Array<AttackTrack & { atlas: AttackAtlasRow }> {
  return tracks.map((t) => {
    const atlas = classifyAttackFamily(t, windowMhz, combs?.get(t.id), extraFromLook(looks?.get(t.id)));
    const band = bandBucket(t.freqMhz);
    const peers = tracks.filter((p) => p.id !== t.id && bandBucket(p.freqMhz) === band);
    const two =
      (videoPeer(t) && peers.some(hopPeer)) ||
      (hopPeer(t) && peers.some(videoPeer));
    return { ...t, atlas: two ? TWO_FLOOR : atlas };
  });
}

export const ATTACK_SILENT_HINT =
  "эфир тихий — волокно / автономия / чужая сотовая этим режимом не видны";
