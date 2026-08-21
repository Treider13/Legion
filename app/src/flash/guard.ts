// ============================================================================
// LEGION — запрет перекрёстной прошивки. SDR-образ ≠ ESP32 и наоборот.
// Неверная запись кирпичит плату.
// ============================================================================
import { classifyFirmware } from "../sdr/firmware";
import { rejectAlienFirmware } from "../sdr/task";

export type FlashDomain = "sdr" | "esp32";

export function looksLikeSdrFirmware(filename: string): boolean {
  const base = filename.split(/[/\\]/).pop() ?? filename;
  if (classifyFirmware(base) !== "unknown") return true;
  return /\.(rbf|frm|img)$/i.test(base);
}

export function looksLikeEsp32Firmware(filename: string): boolean {
  const base = filename.split(/[/\\]/).pop() ?? filename;
  if (/hackrf/i.test(base)) return false;
  if (/hosted|bladerf|pluto|usrp|n210|lime/i.test(base)) return false;
  return /bootloader|partition-table|esp32|\.elf$|legion.*\.(bin|elf)/i.test(base);
}

/** Чужой jam / чужой домен. null = можно проверять дальше. */
export function refuseCrossFlash(domain: FlashDomain, filename: string): string | null {
  const alien = rejectAlienFirmware(filename);
  if (alien) return alien;
  if (domain === "sdr" && looksLikeEsp32Firmware(filename)) {
    return "это файл ESP32 — на SDR не шьём (кирпич). Вкладка ПРОШИВКА ESP32.";
  }
  if (domain === "esp32" && looksLikeSdrFirmware(filename)) {
    return "это образ SDR (FPGA/FX3) — на ESP32 не шьём (кирпич). Вкладка ПРОШИВКА SDR.";
  }
  return null;
}
