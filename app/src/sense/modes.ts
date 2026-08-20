// ============================================================================
// LEGION — два кардинально разных режима. Не смешивать.
//
// SDR:  ПК --Ethernet--> SDR (антенна RX + RF out на усилитель).
//       Старт/стоп и события эфира идут по Ethernet. ESP32 не участвует.
// ESP32: ПК --USB--> ESP32 --SPI--> ADF4351 --> усилитель.
//       Коридор/скорость/частота. Нет SDR и нет антенны скана.
// ============================================================================
export type LegionMode = "sdr" | "esp32";

export function modeOf(workspace: string): LegionMode {
  return workspace === "sdr" || workspace === "scan" ? "sdr" : "esp32";
}

/** Нельзя крутить коридор ESP32 и TX SDR одновременно — разные тракты. */
export function modeConflict(
  want: LegionMode,
  corridorRunning: boolean,
  sdrTransmit: boolean,
): string | null {
  if (want === "esp32" && sdrTransmit) {
    return "режим ESP32 занят: сначала СТОП ПЕРЕДАЧУ в режиме SDR";
  }
  if (want === "sdr" && corridorRunning) {
    return "режим SDR занят: сначала СТОП коридора ESP32";
  }
  return null;
}
