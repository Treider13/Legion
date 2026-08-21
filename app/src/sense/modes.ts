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

/** Полосы скана и полосы ESP32 — два списка. Скан не пишет ALLOW на UART. */
export function bandListFor(mode: LegionMode): "sdrBands" | "allowBands" {
  return mode === "sdr" ? "sdrBands" : "allowBands";
}

/** Нельзя крутить коридор ESP32 и TX SDR одновременно — разные тракты. */
/** Слушать антенну / обход полосы — не TX. ПЕРЕДАТЬ — авто на усилитель. */
export type SdrRunIntent = "listen" | "transmit";

export function runIntentArmsTx(intent: SdrRunIntent): boolean {
  return intent === "transmit";
}

/** Обход (туда-сюда / сплошная / случайная) не включает TX сам. */
export function walkPatternArmsTx(): boolean {
  return false;
}

export function autoForwardAllowed(opts: {
  transmitArmed: boolean;
  loadOk: boolean;
  sdrCanTx: boolean;
}): boolean {
  return opts.transmitArmed && opts.loadOk && opts.sdrCanTx;
}

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
