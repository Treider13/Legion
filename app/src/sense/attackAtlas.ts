// ============================================================================
// LEGION — атлас семей эфира для карточки Атаки. Только энергия:
// полоса / ширина / duty / соседи. Не декодер, не вход в TX, не имя фирмы.
// Ширина сначала, потом корзина — иначе 10/20 на 5.8 зовут аналогом.
// ============================================================================
import type { AttackTrack } from "./attackTracks";
import { ATTACK_VIDEO_BW_MHZ } from "./attackDetect";

export type AttackBand =
  | "vhf"
  | "uhf"
  | "p900"
  | "l12"
  | "s14"
  | "s24"
  | "c33"
  | "c51"
  | "c58"
  | "other";

export interface AttackAtlasRow {
  id: string;
  label: string;
  hint: string;
}

export function bandBucket(mhz: number): AttackBand {
  if (mhz >= 134 && mhz <= 175) return "vhf";
  if (mhz >= 380 && mhz <= 525) return "uhf";
  if (mhz >= 850 && mhz <= 950) return "p900";
  if (mhz >= 1180 && mhz <= 1360) return "l12";
  if (mhz >= 1400 && mhz <= 2000) return "s14";
  if (mhz >= 2400 && mhz <= 2500) return "s24";
  if (mhz >= 3080 && mhz <= 3600) return "c33";
  if (mhz >= 5150 && mhz <= 5250) return "c51";
  if (mhz >= 5640 && mhz <= 5950) return "c58";
  return "other";
}

const DIGITAL_BANDS: readonly AttackBand[] = ["s14", "s24", "c51", "c58"];
const ANALOG_BANDS: readonly AttackBand[] = ["l12", "c33", "c58"];

export function classifyAttackFamily(
  t: Pick<AttackTrack, "freqMhz" | "widthMhz" | "duty" | "streak">,
  windowMhz?: number,
): AttackAtlasRow {
  const band = bandBucket(t.freqMhz);
  const hopLike = t.duty < 0.45 && t.streak <= 2;
  const sticky = t.duty >= 0.7;
  const win = windowMhz != null && windowMhz > 0 ? windowMhz : undefined;

  if (t.widthMhz < 6 && band === "p900") {
    return {
      id: "rc-900",
      label: "узкий 900-класс",
      hint: "ELRS/Crossfire/LRS по спектру не разделяются",
    };
  }
  if (hopLike && t.widthMhz <= 2 && band === "s24") {
    return {
      id: "rc-24",
      label: "узкий пакетный RC 2.4",
      hint: "вспышка ~0.8 МГц, сетка шагом ~1 МГц — не имя протокола",
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
  if (sticky && t.widthMhz >= ATTACK_VIDEO_BW_MHZ && t.widthMhz <= 16 && ANALOG_BANDS.includes(band)) {
    return {
      id: "analog-video",
      label: "похоже на аналоговое видео",
      hint: "6–16 МГц, высокий duty — не 10/20 цифра",
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
  hint: "липкая широкая палка и узкие вспышки в одной корзине — не один протокол",
};

function hopPeer(t: Pick<AttackTrack, "widthMhz" | "duty" | "streak">): boolean {
  return t.duty < 0.45 && t.streak <= 2 && t.widthMhz <= 2;
}

function videoPeer(t: Pick<AttackTrack, "widthMhz" | "duty">): boolean {
  return t.duty >= 0.7 && t.widthMhz >= ATTACK_VIDEO_BW_MHZ;
}

export function atlasForTracks(
  tracks: readonly AttackTrack[],
  windowMhz?: number,
): Array<AttackTrack & { atlas: AttackAtlasRow }> {
  return tracks.map((t) => {
    const atlas = classifyAttackFamily(t, windowMhz);
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
