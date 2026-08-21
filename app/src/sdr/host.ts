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

export function flashFileRequired(byteLength: number): { ok: boolean; reason: string } {
  if (!(byteLength > 0)) {
    return { ok: false, reason: "нет файла образа — выберите скачанный с сайта вендора файл" };
  }
  return { ok: true, reason: `размер ${byteLength} байт` };
}
