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
  return workspace === "sdr" || workspace === "scan" || workspace === "signal" || workspace === "sdrFlash" || workspace === "sdrCustom"
    ? "sdr"
    : "esp32";
}

/** Полосы скана и полосы ESP32 — два списка. Скан не пишет ALLOW на UART. */
export function bandListFor(mode: LegionMode): "sdrBands" | "allowBands" {
  return mode === "sdr" ? "sdrBands" : "allowBands";
}

/** Нельзя крутить коридор ESP32 и TX SDR одновременно — разные тракты. */
/** Слушать антенну / обход полосы — не TX. ПЕРЕДАТЬ — авто на усилитель. */
export type SdrRunIntent = "listen" | "transmit";
export type SdrWalkPattern = "auto" | "sweep" | "band" | "hop" | "fpga";
export type AutoDispatch = "priority" | "turn" | "park";

export function isFpgaAirPattern(pattern: SdrWalkPattern): boolean {
  return pattern === "fpga";
}

export function runIntentArmsTx(intent: SdrRunIntent): boolean {
  return intent === "transmit";
}

/** Выбор обхода TX сам по себе не включает излучение — нужен ПЕРЕДАТЬ. */
export function walkPatternArmsTx(): boolean {
  return false;
}

export function scannerParticipates(pattern: SdrWalkPattern): boolean {
  // fpga: глаза — плата (энергия у АЦП). Хост-сканер в круге не участвует.
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
    case "fpga":
      return "АВТОПЕРЕХВАТ";
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
    case "fpga":
      return "Автоматический перехват (плата смотрит эфир → TX на усилитель, USB не в круге)";
  }
}

export function scanRefusedReason(pattern: SdrWalkPattern): string | null {
  if (scannerParticipates(pattern) || isFpgaAirPattern(pattern)) return null;
  return `СКАНИРОВАТЬ: в режиме ${patternLabelRu(pattern)} сканер не участвует — выберите АВТО`;
}

export function autoDispatchLabelRu(dispatch: AutoDispatch): string {
  if (dispatch === "priority") return "ПРИОРИТЕТ";
  if (dispatch === "park") return "СТОЯНКА";
  return "ОБЫЧНЫЙ";
}

export function autoDispatchOptionRu(dispatch: AutoDispatch): string {
  if (dispatch === "priority") return "ПРИОРИТЕТ (сильнее рядом — на неё)";
  if (dispatch === "park") return "СТОЯНКА (узкий — один LO, хопы цифрой; шире взгляда — обзор и взгляд на всплеск)";
  return "ОБЫЧНЫЙ (по очереди, выдержка)";
}

export function planSdrWork(pattern: SdrWalkPattern, dispatch: AutoDispatch = "turn"): {
  useScanner: boolean;
  openLoopTx: boolean;
  useFpgaAir: boolean;
  reason: string;
} {
  if (pattern === "fpga") {
    return {
      useScanner: false,
      openLoopTx: false,
      useFpgaAir: true,
      reason:
        "Автоматический перехват: после Старта хозяин — SDR. Плата сама видит энергию в аналоговом окне и сама открывает TX. " +
        "Гейт в текущем взгляде — микросекунды. Стоянка: LO на середине коридора, хопы внутри окна — на усилитель без PLL. По очереди — плитка взглядов и выдержка. USB не в круге увидел→усилитель. Ноутбук — коридор, Старт/Стоп и наблюдение.",
    };
  }
  if (pattern === "auto") {
    const how =
      dispatch === "priority"
        ? "приоритет: держим; сильнее рядом — на неё, пропала — следующая"
        : dispatch === "park"
          ? "стоянка: узкий коридор — один LO, хопы внутри цифрой; шире взгляда — глухой обзор и взгляд на всплеск"
          : "обычный: живые по очереди, каждая выдержка на усилителе";
    return {
      useScanner: true,
      openLoopTx: false,
      useFpgaAir: false,
      reason: `сканер RX → ${how}, пока оператор не стопнет`,
    };
  }
  return {
    useScanner: false,
    openLoopTx: true,
    useFpgaAir: false,
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
  fpgaArmed = false,
): string | null {
  const sdrLive = sdrTransmit || fpgaArmed;
  if (want === "esp32" && sdrLive) {
    return fpgaArmed
      ? "режим ESP32 занят: сначала ОСТАНОВИТЬ FPGA"
      : "режим ESP32 занят: сначала СТОП ПЕРЕДАЧУ в режиме SDR";
  }
  if (want === "sdr" && corridorRunning) {
    return "режим SDR занят: сначала СТОП коридора ESP32";
  }
  return null;
}

export type FpgaRunMode = "player" | "nco" | "lb_gated" | "lb_always";

/** Режим ARM по-русски — для whisper/лога оператора. На проводе (шлюз)
 *  остаются wire-имена player/nco/lb_gated/lb_always. */
export function fpgaRunModeRu(mode: FpgaRunMode): string {
  switch (mode) {
    case "player":
      return "генерация · волна из памяти";
    case "nco":
      return "генерация · тон";
    case "lb_gated":
      return "ретрансляция по энергии";
    case "lb_always":
      return "ретрансляция постоянная";
  }
}

/** FPGA без сканера: ноутбук ставит контент, SDR играет. Не lb_gated. */
export function isFpgaTaskMode(mode: FpgaRunMode): boolean {
  return mode === "player" || mode === "nco" || mode === "lb_always";
}

/** Живой онбордовый перехват (плата смотрит эфир). Не путать с пунктом меню. */
export function isFpgaAirLive(armed: boolean, mode: FpgaRunMode): boolean {
  return armed && mode === "lb_gated";
}

/** Живая задача с ноутбука. Не конвейер I²+Q². */
export function isFpgaTaskLive(armed: boolean, mode: FpgaRunMode): boolean {
  return armed && isFpgaTaskMode(mode);
}
