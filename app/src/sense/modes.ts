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
  return workspace === "sdr" || workspace === "scan" || workspace === "signal" || workspace === "sdrFlash" || workspace === "sdrCustom" || workspace === "position"
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
  // sweep/band/hop: слух классов есть, но TX Атаки сюда не смешиваем.
  return pattern === "auto";
}

/** Слух RfClass: Атака и open-loop. FPGA — observe tap, не этот хост-FFT. */
export function detectorListens(pattern: SdrWalkPattern): boolean {
  return pattern === "auto" || pattern === "sweep" || pattern === "band" || pattern === "hop";
}

/** Хост-слух Soapy: Атака / классы, либо фаза 1 умной атаки (TX выкл). */
export function hostListenActive(pattern: SdrWalkPattern, smartListenLive = false): boolean {
  return detectorListens(pattern) || (pattern === "fpga" && smartListenLive);
}

/** Имя онбордового режима для оператора. Wire id — scanPattern="fpga". */
export const FPGA_AIR_MODE_RU = "Умная атака";
export const FPGA_AIR_MODE_RU_CAPS = "УМНАЯ АТАКА";
export const FPGA_AIR_MODE_START_RU = "СТАРТ УМНОЙ АТАКИ";
/** Фаза 2: заморозить карточку и ARM. Старт сам не ARM'ит. */
export const FPGA_AIR_MODE_ACCEPT_RU = "ПРИНЯТЬ";
export const SMART_ARM_NEED_ACCEPT_RU = "ARM без Принять запрещён";
export const SMART_PEAK_OVERRIDE_RU = "пик без сетки (не умная)";

/** Имя хост-режима для оператора. Wire id — scanPattern="auto". */
export const HOST_ATTACK_MODE_RU = "Атака";
export const HOST_ATTACK_MODE_RU_CAPS = "АТАКА";

/** Короткое имя в UI. sweep = качание (реверс на краю), не «туда-сюда». */
export function patternLabelRu(pattern: SdrWalkPattern): string {
  switch (pattern) {
    case "auto":
      return HOST_ATTACK_MODE_RU_CAPS;
    case "sweep":
      return "КАЧАНИЕ";
    case "band":
      return "СПЛОШНАЯ";
    case "hop":
      return "СЛУЧАЙНАЯ";
    case "fpga":
      return FPGA_AIR_MODE_RU_CAPS;
  }
}

export function patternOptionRu(pattern: SdrWalkPattern): string {
  switch (pattern) {
    case "auto":
      return `${HOST_ATTACK_MODE_RU} (сканер → ПЕРЕДАТЬ)`;
    case "sweep":
      return "КАЧАНИЕ TX (реверс; слух классов — СКАНИРОВАТЬ)";
    case "band":
      return "СПЛОШНАЯ TX (по кругу; слух классов — СКАНИРОВАТЬ)";
    case "hop":
      return "СЛУЧАЙНАЯ TX (слух классов — СКАНИРОВАТЬ)";
    case "fpga":
      return `${FPGA_AIR_MODE_RU} (слух Soapy → Принять карточку → плата; USB не в круге)`;
  }
}

export function scanRefusedReason(pattern: SdrWalkPattern): string | null {
  if (detectorListens(pattern) || isFpgaAirPattern(pattern)) return null;
  return `СКАНИРОВАТЬ: в режиме ${patternLabelRu(pattern)} слуха нет`;
}

/** xA4 один BBPLL (Nuand t=13047): 61.44-слух во время полки схлопнет TX. */
export function classScanBlockedByTx(pattern: SdrWalkPattern, transmitArmed: boolean): string | null {
  if (!transmitArmed) return null;
  if (!detectorListens(pattern) || scannerParticipates(pattern)) return null;
  return "СКАНИРОВАТЬ: при ПЕРЕДАТЬ слух уже на часах полки — один BBPLL, 61.44 не крутим";
}

export function autoDispatchLabelRu(dispatch: AutoDispatch): string {
  if (dispatch === "priority") return "ПРИОРИТЕТ";
  if (dispatch === "park") return "СТОЯНКА";
  return "ОБЫЧНЫЙ";
}

export function autoDispatchOptionRu(dispatch: AutoDispatch): string {
  if (dispatch === "priority") return "ПРИОРИТЕТ (сильнее — перескок и новая выдержка)";
  if (dispatch === "park") return "СТОЯНКА (узкий — один LO, хопы цифрой; шире взгляда — обзор и взгляд на всплеск)";
  return "ОБЫЧНЫЙ (по очереди, выдержка)";
}

/** Умная атака: ИИ снаружи всегда. park leftover → обычный. */
export const FPGA_AI_LABEL_RU = "ИИ";
export const FPGA_AI_OPTION_RU = "ИИ (окно на всплеск, хопы цифрой)";

export function fpgaInnerDispatch(dispatch: AutoDispatch): "turn" | "priority" {
  return dispatch === "priority" ? "priority" : "turn";
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
        `${FPGA_AIR_MODE_RU}: Старт — слух Soapy, карточка живая, TX выкл. Принять замораживает карточку и отдаёт ARM плате. ` +
        "Пустая сетка / аналог 5.8 / x40+C58 — ARM нет (пик без сетки — только явный override). " +
        "Гейт в текущем взгляде — микросекунды. Живой канал last_live 1.5 с, не таймер периода прохода. USB не в круге увидел→усилитель.",
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
      reason: `${HOST_ATTACK_MODE_RU}: сканер RX → ${how}, пока оператор не стопнет`,
    };
  }
  return {
    useScanner: false,
    openLoopTx: true,
    useFpgaAir: false,
    reason:
      `ноутбук задаёт ${patternLabelRu(pattern)} TX LO по Ethernet, сканер Атаки не участвует, пока оператор не стопнет. ` +
      "Слух классов — СКАНИРОВАТЬ без TX или на часах полки после ПЕРЕДАТЬ",
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
