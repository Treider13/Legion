// ============================================================================
// LEGION — предусловия открытия SDR. Без Soapy/CLI процесс не притворяется эфиром.
// ============================================================================

export interface HostOpenInput {
  emulation: boolean;
  hasSoapyOrCli: boolean;
  imageBytes: number;
}

export function hostOpenAllowed(i: HostOpenInput): { ok: boolean; reason: string } {
  if (i.emulation) {
    return { ok: true, reason: "эмуляция: IQ/TX — модель хоста, не кабель и не эфир" };
  }
  if (!i.hasSoapyOrCli) {
    return {
      ok: false,
      reason: "нет SoapySDR на хосте — поставьте python3-soapysdr + SoapyRemote или включите эмуляцию",
    };
  }
  return { ok: true, reason: "хост-инструмент есть — открытие через Soapy/UHD, не UART ESP32" };
}

/** CLI вендора ищет файл в cwd процесса Tauri — имя без пути врёт «успех». */
export function usableImagePath(path: string): boolean {
  const p = path.trim();
  if (!p) return false;
  if (p.startsWith("/")) return true;
  if (/^[A-Za-z]:[\\/]/.test(p)) return true;
  if (p.startsWith("\\\\")) return true;
  return false;
}

export function flashFileRequired(byteLength: number, path = ""): { ok: boolean; reason: string } {
  if (!usableImagePath(path)) {
    return {
      ok: false,
      reason:
        "нужен абсолютный путь к образу вендора (поле ОБРАЗ или desktop file.path) — имя без каталога CLI ищет в cwd",
    };
  }
  if (!(byteLength > 0)) {
    return { ok: true, reason: `путь ${path.trim()}` };
  }
  return { ok: true, reason: `размер ${byteLength} байт · ${path.trim()}` };
}
