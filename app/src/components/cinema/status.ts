// ============================================================================
// LEGION — строка статуса главного кадра. Пять состояний для оператора:
// ОЖИДАНИЕ / ПОИСК / РЕТРАНСЛЯЦИЯ / ПЕРЕДАЧА (коридор, генерация) / ОШИБКА.
// Чистая функция — тестируется без DOM (scripts/test_orchestrator.ts).
// ============================================================================

export type HeroKind = "idle" | "search" | "relay" | "relay-wait" | "tx" | "error";

export interface HeroState {
  scanRunning: boolean;
  transmitArmed: boolean;
  corridorRunning: boolean;
  signalTxActive: boolean;
  fpgaArmed: boolean;
  fpgaBusy: boolean;
  fpgaMode: string;
  fpgaStatus: { ok?: boolean; det_active?: boolean; wd_fired?: boolean; reason?: string; warn?: string } | null;
  lastForwardMhz: number | null;
  lastInterceptMhz: number | null;
  scanCenterMhz: number | null;
  telemFreq: number | null;
  freqMhz: string;
}

export interface HeroLine {
  kind: HeroKind;
  text: string;
  detail: string;
}

export function heroStatusLine(s: HeroState): HeroLine {
  const freq =
    s.lastForwardMhz ?? s.lastInterceptMhz ?? s.scanCenterMhz ?? s.telemFreq ?? parseFloat(s.freqMhz);
  const freqTxt = freq != null && Number.isFinite(freq) ? `${freq.toFixed(3)} МГц` : "";

  const wdFired = s.fpgaStatus?.wd_fired === true;
  // Watchdog — липкий: стор снимает ARM сразу (fpgaDisarm/fpgaReturnToScan),
  // поэтому ОШИБКА показываем и после снятия ARM. Но уступаем любой живой
  // активности: авто-цикл восстановился (scanRunning) или оператор пошёл в
  // другой тракт (коридор/передача) — stale-тревога не маскирует работу.
  const otherLive = s.scanRunning || s.corridorRunning || s.transmitArmed || s.signalTxActive;
  // fpgaBusy = новый цикл (handoff) уже в полёте — stale wd из прошлого ARM
  // не показываем: первый же опрос после ARM обновит латч.
  if (wdFired && (s.fpgaArmed || (!otherLive && !s.fpgaBusy))) {
    return {
      kind: "error",
      text: "ОШИБКА",
      detail: "сторожевой таймер погасил TX — проверьте связь со шлюзом" + (freqTxt ? ` · ${freqTxt}` : ""),
    };
  }
  // Статус недоступен в активной фазе (ARM или handoff в полёте) = шлюз умер
  // на ходу. В idle не вооружаемся: лабораторный СТАТУС без шлюза — не авария.
  if (s.fpgaStatus != null && s.fpgaStatus.ok === false && (s.fpgaArmed || s.fpgaBusy)) {
    return {
      kind: "error",
      text: "ОШИБКА",
      detail: `статус FPGA недоступен: ${s.fpgaStatus.reason ?? "нет ответа шлюза"}`,
    };
  }
  if (s.fpgaArmed && s.fpgaMode === "lb_gated") {
    // Ретрансляция: гейт открыт = эфир идёт на усилитель; закрыт = ждём сигнал.
    const warn = s.fpgaStatus?.warn ? ` · ${s.fpgaStatus.warn}` : "";
    return s.fpgaStatus?.det_active === true
      ? { kind: "relay", text: "РЕТРАНСЛЯЦИЯ", detail: `${freqTxt} · гейт открыт · эфир → усилитель${warn}` }
      : { kind: "relay-wait", text: "РЕТРАНСЛЯЦИЯ", detail: `${freqTxt} · гейт закрыт · ждём сигнал${warn}` };
  }
  if (s.fpgaArmed) {
    const warn = s.fpgaStatus?.warn ? ` · ${s.fpgaStatus.warn}` : "";
    return {
      kind: "tx",
      text: "ГЕНЕРАЦИЯ",
      detail: `${freqTxt} · FPGA: ${s.fpgaMode === "nco" ? "тон" : "волна из памяти"}${warn}`,
    };
  }
  if (s.fpgaBusy) {
    return { kind: "search", text: "ПОИСК", detail: "подготовка FPGA (парковка, калибровка)…" };
  }
  if (s.scanRunning) {
    return { kind: "search", text: "ПОИСК", detail: `${freqTxt} · сканер слушает коридор` };
  }
  if (s.transmitArmed || s.signalTxActive) {
    return { kind: "tx", text: "ПЕРЕДАЧА", detail: `${freqTxt} · TX на усилитель` };
  }
  if (s.corridorRunning) {
    return { kind: "tx", text: "КОРИДОР", detail: `${freqTxt} · ESP32 ведёт синтезатор` };
  }
  return { kind: "idle", text: "ОЖИДАНИЕ", detail: freqTxt };
}
