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
export type SdrWalkPattern = "auto" | "sweep" | "band" | "hop";
export type AutoDispatch = "priority" | "turn";

export function runIntentArmsTx(intent: SdrRunIntent): boolean {
  return intent === "transmit";
}

/** Выбор обхода TX сам по себе не включает излучение — нужен ПЕРЕДАТЬ. */
export function walkPatternArmsTx(): boolean {
  return false;
}

export function scannerParticipates(pattern: SdrWalkPattern): boolean {
  return pattern === "auto";
}

/** Короткое имя в UI. sweep = качание (реверс на краю), не «туда-сюда». */
export function patternLabelRu(pattern: SdrWalkPattern): string {
  switch (pattern) {
    case "auto":
      return "АВТО";
    case "sweep":
      return "КАЧАНИЕ";
    case "band":
      return "СПЛОШНАЯ";
    case "hop":
      return "СЛУЧАЙНАЯ";
  }
}

export function patternOptionRu(pattern: SdrWalkPattern): string {
  switch (pattern) {
    case "auto":
      return "АВТО (сканер → ПЕРЕДАТЬ)";
    case "sweep":
      return "КАЧАНИЕ TX (реверс, без сканера)";
    case "band":
      return "СПЛОШНАЯ TX (по кругу, без сканера)";
    case "hop":
      return "СЛУЧАЙНАЯ TX (без сканера)";
  }
}

export function scanRefusedReason(pattern: SdrWalkPattern): string | null {
  if (scannerParticipates(pattern)) return null;
  return `СКАНИРОВАТЬ: в режиме ${patternLabelRu(pattern)} сканер не участвует — выберите АВТО`;
}

export function autoDispatchLabelRu(dispatch: AutoDispatch): string {
  return dispatch === "priority" ? "ПРИОРИТЕТ" : "ОБЫЧНЫЙ";
}

export function autoDispatchOptionRu(dispatch: AutoDispatch): string {
  return dispatch === "priority"
    ? "ПРИОРИТЕТ (сильнее на усилитель)"
    : "ОБЫЧНЫЙ (по очереди, выдержка)";
}

export function planSdrWork(pattern: SdrWalkPattern, dispatch: AutoDispatch = "turn"): {
  useScanner: boolean;
  openLoopTx: boolean;
  reason: string;
} {
  if (pattern === "auto") {
    const how =
      dispatch === "turn"
        ? "обычный: живые по очереди, каждая выдержка на усилителе"
        : "приоритет: сильнее сразу на усилитель";
    return {
      useScanner: true,
      openLoopTx: false,
      reason: `сканер RX → ${how}, пока оператор не стопнет`,
    };
  }
  return {
    useScanner: false,
    openLoopTx: true,
    reason: `ноутбук задаёт ${patternLabelRu(pattern)} TX LO по Ethernet, сканер не участвует, пока оператор не стопнет`,
  };
}

/**
 * Deepwave/Soapy: writeStream крутится, пока хост не deactivateStream.
 * Пустой эфир и конец прохода walker сами процесс не стопают.
 */
export function shouldKeepTransmit(opts: {
  operatorArmed: boolean;
  liveEmpty?: boolean;
  walkerFinished?: boolean;
}): boolean {
  return opts.operatorArmed;
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
