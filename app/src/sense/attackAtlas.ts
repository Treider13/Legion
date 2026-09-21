// ============================================================================
// LEGION — атлас семей эфира для карточки Атаки. Только энергия:
// полоса / ширина / duty. Не декодер, не вход в TX.
// Факты: FCC OcuSync 10/20 МГц; wardragon analog ≥6–8 МГц; ExpressLRS
// узкий hop; Kismet Wi-Fi DroneID ≠ OcuSync RF (другая антенна).
// ============================================================================
import type { AttackTrack } from "./attackTracks";
import { ATTACK_VIDEO_BW_MHZ } from "./attackDetect";

export interface AttackAtlasRow {
  id: string;
  label: string;
  hint: string;
}

export function bandBucket(mhz: number): "p900" | "l12" | "s24" | "c33" | "c58" | "other" {
  if (mhz >= 850 && mhz <= 950) return "p900";
  if (mhz >= 1180 && mhz <= 1360) return "l12";
  if (mhz >= 2400 && mhz <= 2500) return "s24";
  if (mhz >= 3300 && mhz <= 3600) return "c33";
  if (mhz >= 5640 && mhz <= 5950) return "c58";
  return "other";
}

export function classifyAttackFamily(t: Pick<AttackTrack, "freqMhz" | "widthMhz" | "duty" | "streak">): AttackAtlasRow {
  const band = bandBucket(t.freqMhz);
  const wide = t.widthMhz >= ATTACK_VIDEO_BW_MHZ;
  const digital = t.widthMhz >= 9 && t.widthMhz <= 22;
  const hopLike = t.duty < 0.45 && t.streak <= 2;
  const sticky = t.duty >= 0.7;

  if (wide && (band === "c58" || band === "l12" || band === "c33") && sticky) {
    return {
      id: "analog-video",
      label: "похоже на аналоговое видео",
      hint: "ширина ≥6 МГц, высокий duty — wardragon MIN_BW / analog FPV",
    };
  }
  if (digital && (band === "s24" || band === "c58") && sticky) {
    return {
      id: "digital-video",
      label: "широкий цифровой линк",
      hint: "10/20 МГц класс (FCC OcuSync) — не имя модели",
    };
  }
  if (digital && (band === "s24" || band === "c58") && hopLike) {
    return {
      id: "digital-burst",
      label: "широкие вспышки 2.4/5.8",
      hint: "может быть ID-слой; декод только сбоку, не в ПЕРЕДАТЬ",
    };
  }
  if (!wide && band === "p900") {
    return {
      id: "rc-900",
      label: "узкий 900-класс",
      hint: "ELRS/Crossfire/LRS по спектру не разделяются",
    };
  }
  if (!wide && band === "s24" && hopLike) {
    return {
      id: "rc-24",
      label: "узкий пакетный RC 2.4",
      hint: "ELRS/FrSky/Spektrum — одна корзина",
    };
  }
  if (t.widthMhz >= 16 && t.widthMhz <= 22 && sticky && (band === "s24" || band === "c58")) {
    return {
      id: "wifi-like",
      label: "похоже на Wi-Fi канал",
      hint: "~20 МГц стоит — не Remote ID (нужна другая антенна)",
    };
  }
  if (wide && sticky) {
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

export function atlasForTracks(tracks: readonly AttackTrack[]): Array<AttackTrack & { atlas: AttackAtlasRow }> {
  return tracks.map((t) => ({ ...t, atlas: classifyAttackFamily(t) }));
}
