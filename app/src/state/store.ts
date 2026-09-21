// ============================================================================
// LEGION — zustand store: состояние подключения, генератора и журнал.
// ============================================================================
import { create } from "zustand";

import { cueFreqAllowed, hzInAllowlist, parseBand, type AllowBand } from "../policy/allowlist";
import { LegionClient } from "../protocol/client";
import { MockSdrBackend } from "../sdr/backend";
import {
  isEsp32FlashEnv,
  parseEsp32Chip,
  planEsp32Flash,
  type Esp32FlashEnv,
  type Esp32FlashResult,
} from "../flash/esp32";
import { planSdrWrite } from "../flash/sdrWrite";
import {
  planLegionBuild,
  planLegionFlashGateway,
  planLegionFlashLocal,
  type LegionFlashAction,
} from "../flash/legionCustom";
import { defaultFlashName, planEthernet, sdrOpenArgs } from "../sdr/official";
import { catalogById, parseSdrRxBand } from "../sdr/catalog";
import { hostOpenAllowed, usableImagePath } from "../sdr/host";
import {
  catalogCaps,
  hostClose,
  hostEsp32ChipId,
  hostEsp32Flash,
  hostFlash,
  hostOpen,
  hostHealth,
  hostPing,
  hostSdrAvailable,
  hostDetCapture,
  hostPark,
  hostIperf3,
  hostScan,
  hostAttackScan,
  hostAttackThink,
  hostTx,
  hostTxOff,
  hostTxWave,
  hostFpga,
  hostLegionBuildCancel,
  hostLegionBuildStart,
  hostLegionBuildStatus,
  hostLegionEnvInfo,
  hostLegionToolchain,
  markCatalogPresent,
  requireHwForSdr,
  type FpgaStatus,
} from "../sdr/hostClient";
import { cropPsdBins, detectFromBins, hostPaintSpanMhz, hostScanSpanMhz } from "../sdr/backend";
import type { Detection, FlashResult, ScanBin, SdrDeviceInfo } from "../sdr/types";
import { defaultParams, type WaveKind } from "../sdr/waveforms";
import { detectAttackHits } from "../sense/attackDetect";
import { attackListenPlan } from "../sense/attackListen";
import { AttackTracker, type AttackTrack } from "../sense/attackTracks";
import { parseWorkerLook } from "../sense/attackLook";
import { AttackSessionMemory } from "../sense/attackMemory";
import { buildAttackScene, type AttackRow, type AttackSceneView } from "../sense/attackScene";
import { type AttackAdvice, type AttackHintKind } from "../sense/attackAdvisor";
import {
  ATTACK_COOLDOWN_MS,
  ATTACK_HOLD_DEFAULT_MS,
  attackPaintOwnsTx,
  attackWaveParams,
  clampAttackHoldMs,
  clampPaintToCaps,
  clipPaintToAllowlist,
  paintCenterMhz,
  paintRefuseReason,
  paintSpanMhz,
  paintTxFsHz,
  paintWaveHint,
  type AttackPaint,
} from "../sense/attackPaint";
import { isTauriRuntime } from "../transport/types";
import { HandoffGate, planHandoff, type HandoffPlan } from "../sense/fastpath";
import {
  FPGA_AIR_BW_DEFAULT_MHZ,
  FPGA_AIR_GONE_MS,
  FPGA_OBSERVE_MS,
  FPGA_DEFAULT_DET_THR,
  FPGA_TURN_DWELL_DEFAULT_MS,
  FPGA_SURVEY_PERIOD_DEFAULT_MS,
  FPGA_US_DET_SHIFT,
  airThrTable,
  airTractParams,
  clampDetShift,
  detCountStagnant,
  detCaptureWindows,
  fpgaAirSupported,
  fpgaArmCmd,
  fpgaObserveLine,
  parseLocaleNumber,
  ncoFtwFromFrac,
  planFpgaAir,
  planOnboardIntercept,
} from "../sense/fpgaFastpath";
import {
  FPGA_SOLO_DWELL_DEFAULT_MS,
  airHopBlockedReason,
  makeSoloWalker,
  planFpgaSoloWalk,
  soloHopBlockedReason,
  soloParkOpts,
  soloTuneCmd,
  type FpgaSoloPattern,
} from "../sense/fpgaSoloWalk";
import {
  heldHitAlive,
  pickArmedAutoTarget,
  refreshSkipMhz,
  RESENSE_MS,
  shouldContinuePriorityTick,
} from "../sense/hold";
import {
  FPGA_AIR_MODE_RU,
  FPGA_AI_LABEL_RU,
  fpgaInnerDispatch,
  fpgaRunModeRu,
  isFpgaAirPattern,
  modeConflict,
  modeOf,
  planSdrWork,
  scanRefusedReason,
  scannerParticipates,
  type AutoDispatch,
} from "../sense/modes";
import {
  OWN_TX_GUARD_MHZ,
  markForwarded,
  mergeDetections,
  pickStrongest,
  withoutOwnTx,
} from "../sense/orchestrator";
import { clampWindowMhz, clipToAllowlist, ScanWalker, type ScanPattern } from "../sense/scan";
import {
  emptyLabPsd,
  freezeLabBaseline as freezeLabPsd,
  ingestLabFrame,
  occupancyCoverage,
  occupancyMask,
  resetLabHolds as resetLabPsdHolds,
  resetLabPsd,
  startLabBaseline as beginLabBaseline,
  type LabPsdState,
} from "../sense/labPsd";
import { SpurFilter } from "../sense/labSpur";
import {
  LAB_MIN_DURATION_SEC,
  LAB_MIN_WIDTH_MHZ,
  XA4_RX_MHZ,
  LabEventTracker,
  buildLabJournal,
  hostPeaksForJournal,
  listHits,
  parseIperfJson,
  parseMhzList,
  buildPlaylist,
  parsePlaylistJson,
  playlistStepPatch,
  recordBper,
  recordJsr,
  type BperRecord,
  type IperfRecord,
  type JsrRecord,
  type LabEvent,
  type LabJournalFile,
  type LabPlaylist,
} from "../sense/labJournal";
import { sensitivityToThresholdDb, thresholdToSensitivity } from "../sense/sensitivity";
import { MockTransport } from "../transport/mock";
import { Sl22Transport } from "../sl22/transport";
import { TauriSerialTransport } from "../transport/tauriSerial";
import type { SerialPortDescriptor, Transport, TransportKind, TransportState } from "../transport/types";
import { WebSerialTransport } from "../transport/webSerial";
import { WebSocketTransport } from "../transport/websocket";

export type WorkspaceId =
  | "synth"
  | "corridor"
  | "sdr"
  | "scan"
  | "signal"
  | "pa"
  | "sdrFlash"
  | "sdrCustom"
  | "position"
  | "esp32Flash";
export type SdrFlashAction = "flash-fx3" | "flash-fpga" | "load-fpga";

export interface LogEntry {
  ts: number;
  dir: "tx" | "rx" | "sys";
  text: string;
}

export interface StatusJson {
  freq: number;
  mode: string;
  lock: number;
  rf: number;
  power: number;
  version: string;
  board: string;
}

interface LegionStore {
  // подключение
  transportKind: TransportKind;
  transportState: TransportState;
  transportDetail?: string;
  ports: SerialPortDescriptor[];
  selectedPort: string;
  wsUrl: string;
  // генератор
  freqMhz: string;
  lock: boolean | null;
  powerDbm: number;
  rfOn: boolean;
  attDb: number;
  status: StatusJson | null;
  // коридор (фаза 3)
  corrF1: string;
  corrF2: string;
  corrStepKhz: string;
  corrDwellMs: string;
  corrSeed: string;
  corrMode: "SWEEP" | "HOP" | "CHIRP";
  corridorRunning: boolean;
  telemFreq: number | null;
  telemLock: boolean | null;
  // меню
  workspace: WorkspaceId;
  // политика / PA
  allowBands: AllowBand[];
  allowF1: string;
  allowF2: string;
  loadOk: boolean;
  paMa: number;
  paOn: boolean;
  autoCue: boolean;
  transmitArmed: boolean;
  lastForwardMhz: number | null;
  // SDR (хост, не ESP32) — свой allowlist и своя нагрузка, не UART
  sdrBands: AllowBand[];
  sdrF1: string;
  sdrF2: string;
  sdrLoadOk: boolean;
  sdrDevices: SdrDeviceInfo[];
  sdrId: string;
  sdrGateway: string;
  sdrOpened: SdrDeviceInfo | null;
  sdrRemote: string;
  sdrFlashName: string;
  sdrFlashAction: SdrFlashAction;
  sdrFlashConfirm: boolean;
  lastFlash: FlashResult | null;
  flashBusy: boolean;
  esp32FlashEnv: Esp32FlashEnv;
  esp32FlashConfirm: boolean;
  esp32Chip: string | null;
  esp32ChipPort: string | null;
  esp32ChipRaw: string;
  lastEsp32Flash: Esp32FlashResult | null;
  sdrEmulation: boolean;
  sdrHostReady: boolean;
  sdrHostDetail: string;
  sdrImageBytes: number;
  sdrImagePath: string;
  // КАСТОМ FPGA (ревизия legion): сборка из fpga/ на этом ПК + запись .rbf
  legionBuildPhase: "idle" | "building" | "done" | "failed";
  legionBuildLog: string;
  legionArtifactPath: string;
  legionArtifactSha256: string;
  legionEnvDetail: string;
  legionCanBuild: boolean;
  legionFlashTarget: "local" | "gateway";
  legionFlashAction: LegionFlashAction;
  legionFlashPath: string;
  legionFlashConfirm: boolean;
  lastLegionFlash: { ok: boolean; reason: string } | null;
  // SCAN RX
  scanRunning: boolean;
  scanThresholdDb: number;
  /** 0 = все подряд, 100 = только сильные. */
  scanSensitivity: number;
  scanPattern: ScanPattern;
  /** Атака: приоритет = сильнейшая живая (сильнее перехватывает); обычный = очередь. */
  autoDispatch: AutoDispatch;
  scanWindowMhz: string;
  scanDwellMs: string;
  sdrHoldSince: number | null;
  scanCenterMhz: number | null;
  scanBins: ScanBin[];
  detections: Detection[];
  lastInterceptMhz: number | null;
  lastCueReason: string;
  /** Хост-Атака (scanPattern=auto): треки CFAR + атлас. Пусто в других режимах. */
  attackTracks: AttackTrack[];
  /** Рамка оператора на спектре. null = старый auto-handoff (тест гонок). */
  attackPaint: AttackPaint | null;
  attackPaintDraft: AttackPaint | null;
  attackHoldMs: number;
  attackTxUntil: number | null;
  /** Карточка разбора Атаки. Пусто в других режимах. */
  attackRows: AttackRow[];
  attackAdvice: AttackAdvice;
  attackMemoryLine: string;
  attackSuggestPaint: AttackPaint | null;
  lastSdrTxUs: number | null;
  lastForwardPowerDbm: number | null;
  /** Композит коридора + peak/min/полка. Не гейт FPGA. */
  labPsd: LabPsdState;
  labEvents: LabEvent[];
  labKnown: string;
  labIgnore: string;
  labKnownMhz: number[];
  labIgnoreMhz: number[];
  labMinDurationSec: number;
  labMinWidthMhz: number;
  labShowPeak: boolean;
  labShowMin: boolean;
  labShowBaseline: boolean;
  labSubtractBaseline: boolean;
  labShowPersistence: boolean;
  labShowRtsa: boolean;
  labShowAlloc: boolean;
  labSpurOn: boolean;
  labSpurReady: boolean;
  labIperfHost: string;
  labIperfPort: string;
  labIperfSec: string;
  labIperfUdp: boolean;
  labIperfLoops: string;
  labIperfBusy: boolean;
  labPlaylist: LabPlaylist | null;
  labPlaylistIdx: number;
  labIperf: IperfRecord | null;
  labBper: BperRecord | null;
  labJsr: JsrRecord | null;
  labCoverage: number | null;
  // ТИП СИГНАЛА (baseband → SDR, нагрузка 50 Ом)
  signalKind: WaveKind;
  signalParams: Record<string, number>;
  signalFreqMhz: string;
  /** TX именно сигнальной волны — взаимоисключение со сканером-оркестратором. */
  signalTxActive: boolean;
  /** Зашитая волна для ВСЕХ TX-путей SDR (Атака/приоритет, open-loop). null = CW тон. */
  txWaveKind: WaveKind | null;
  txWaveParams: Record<string, number>;
  // FPGA-ревизия legion (bladeRF 1 x40): автономный тракт в FPGA
  fpgaMode: "player" | "nco" | "lb_gated" | "lb_always";
  fpgaArmed: boolean;
  /** lb_gated ARM из авто-цикла сканера (handoff), не кино/панели —
   *  ему одному положен автовозврат в скан (стагнация/watchdog/heartbeat). */
  fpgaAutoCycle: boolean;
  fpgaBusy: boolean;
  /** СТОП ещё не завершён: ждём DISARM или освобождение USB. Блокирует запуск. */
  fpgaStopPending: boolean;
  /** Незавершённый этап: отключение и освобождение соединения подтверждаются отдельно. */
  fpgaStopPhase: "disarm" | "release" | null;
  fpgaStatus: FpgaStatus | null;
  /** Шлюз распознал ревизию legion в FPGA. null — неизвестно (старый шлюз/USB у хоста). */
  fpgaLegion: boolean | null;
  /** Токен шлюза (LEGION_FPGA_TOKEN на агенте); пустой = открытая LAN стенда. */
  fpgaToken: string;
  /** Порог средней энергии I²+Q² для lb_gated. 0 шлюз отвергает. */
  fpgaDetThr: number;
  /** win_shift 4..12. По умолчанию 4 → 16 сэмплов @ 2 МГц = 8 µs. */
  fpgaDetShift: number;
  /** Выдержка на сигнал внутри окна, мс (строка UI). Обычный и приоритет. */
  fpgaTurnDwellMs: string;
  /** Период сканирования коридора, мс (строка UI). */
  fpgaSurveyPeriodMs: string;
  /** Полоса канала подавления lb_* (fs = max(полоса, 520834 Гц)), МГц, строка UI. */
  fpgaAirBwMhz: string;
  /** Эфир-обход (air-hop): выдержка на стоянке, мс (строка UI). */
  fpgaAirDwellMs: string;
  /** Эфир-обход: порядок стоянок — туда-сюда (sweep) или случайно (hop). */
  fpgaAirWalkPattern: FpgaSoloPattern;
  /** Главный старт: только FPGA или эфир+FPGA. null — не с главного кадра. */
  fpgaPath: "solo" | "air" | null;
  /** Solo: ширина окна на усилитель, МГц (не analog-потолок). */
  fpgaSoloWindowMhz: string;
  fpgaSoloDwellMs: string;
  fpgaSoloPattern: FpgaSoloPattern;
  // журнал
  log: LogEntry[];

  setTransportKind(k: TransportKind): void;
  setSelectedPort(p: string): void;
  setWsUrl(u: string): void;
  setFreqMhz(f: string): void;
  setCorrField(field: "corrF1" | "corrF2" | "corrStepKhz" | "corrDwellMs" | "corrSeed", v: string): void;
  setCorrMode(m: "SWEEP" | "HOP" | "CHIRP"): void;
  setWorkspace(w: WorkspaceId): void;
  setAllowField(field: "allowF1" | "allowF2", v: string): void;
  setSdrAllowField(field: "sdrF1" | "sdrF2", v: string): void;
  addSdrBand(): void;
  clearSdrBands(): void;
  setSdrLoad(ok: boolean): void;
  setPaMa(ma: number): void;
  setAutoCue(v: boolean): void;
  setSdrId(id: string): void;
  setSdrGateway(v: string): void;
  setSdrFlashName(v: string): void;
  setSdrFlashAction(a: SdrFlashAction): void;
  setSdrFlashConfirm(v: boolean): void;
  setEsp32FlashEnv(v: Esp32FlashEnv): void;
  setEsp32FlashConfirm(v: boolean): void;
  setSdrEmulation(v: boolean): void;
  setSdrImageFile(name: string, byteLength: number, path?: string): void;
  setScanThreshold(db: number): void;
  setScanSensitivity(sens: number): void;
  setScanPattern(p: ScanPattern): void;
  setAutoDispatch(d: AutoDispatch): void;
  setScanWindowMhz(v: string): void;
  setScanDwellMs(v: string): void;
  setAttackPaint(p: AttackPaint | null): void;
  setAttackPaintDraft(p: AttackPaint | null): void;
  clearAttackPaint(): void;
  setAttackHoldMs(ms: number): void;
  applyAttackHint(kind: AttackHintKind): void;
  resetSdrLock(): Promise<void>;
  refreshPorts(): Promise<void>;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(cmd: string): Promise<void>;
  setFrequency(): Promise<void>;
  setPower(dbm: number): Promise<void>;
  setAtt(db: number): Promise<void>;
  setRf(on: boolean): Promise<void>;
  pollStatus(): Promise<void>;
  runSelftest(): Promise<void>;
  corridorStart(): Promise<void>;
  corridorStop(): Promise<void>;
  addAllowBand(): Promise<void>;
  clearAllowBands(): Promise<void>;
  setLoad(ok: boolean): Promise<void>;
  applyPaCurrent(): Promise<void>;
  setPaEnabled(on: boolean): Promise<void>;
  cueTo(mhz: number): Promise<void>;
  probeSdr(): Promise<void>;
  openSdr(opts?: { requireHw?: string }): Promise<void>;
  closeSdr(): Promise<void>;
  flashSdr(action?: SdrFlashAction): Promise<void>;
  setLegionFlashTarget(v: "local" | "gateway"): void;
  setLegionFlashAction(a: LegionFlashAction): void;
  setLegionFlashPath(v: string): void;
  setLegionFlashConfirm(v: boolean): void;
  legionEnvRefresh(): Promise<void>;
  legionToolchainRun(): Promise<void>;
  legionBuildStart(): Promise<void>;
  legionBuildCancel(): Promise<void>;
  legionFlash(): Promise<void>;
  probeEsp32Chip(): Promise<void>;
  flashEsp32(): Promise<void>;
  injectDemoTone(): void;
  startScan(): void;
  stopScan(): void;
  startTransmit(): Promise<void>;
  stopTransmit(): Promise<void>;
  forwardTo(mhz: number): Promise<void>;
  setSignalKind(k: WaveKind): void;
  setSignalParam(key: string, v: number): void;
  setSignalFreqMhz(v: string): void;
  /** Выбрать волну для всех TX-путей, не начиная эфир (в отличие от signalFlash). */
  armTxWave(kind: WaveKind): void;
  signalFlash(): Promise<void>;
  disarmTxWave(): void;
  setFpgaMode(m: "player" | "nco" | "lb_gated" | "lb_always"): void;
  setFpgaToken(v: string): void;
  setFpgaDetThr(v: number): void;
  setFpgaDetShift(v: number): void;
  setFpgaTurnDwellMs(v: string): void;
  setFpgaSurveyPeriodMs(v: string): void;
  setFpgaAirBwMhz(v: string): void;
  setFpgaAirDwellMs(v: string): void;
  setFpgaAirWalkPattern(p: FpgaSoloPattern): void;
  setFpgaSoloWindowMhz(v: string): void;
  setFpgaSoloDwellMs(v: string): void;
  setFpgaSoloPattern(p: FpgaSoloPattern): void;
  fpgaArm(): Promise<void>;
  /** Главный кадр: ARM ревизии legion. air = lb_gated, solo = nco/player. */
  startFpgaPath(path: "solo" | "air"): Promise<boolean>;
  /** Отозвать solo-старт в полёте (кино СТОП, даже если ещё не ARM). */
  abortFpgaSolo(): void;
  /** Отозвать эфир-старт / handoff в полёте (кино СТОП, даже если ещё не ARM). */
  abortFpgaAir(): void;
  /** Отозвать ручной ARM панели в полёте (кино СТОП, даже если ещё не ARM). */
  abortFpgaArm(): void;
  fpgaDisarm(): Promise<void>;
  /** Операторский СТОП режима FPGA+сканер: скан стоп + DISARM + USB хосту. */
  stopFpgaAir(): Promise<void>;
  fpgaPollStatus(): Promise<void>;
  clearLog(): void;
  startLabBaseline(): void;
  freezeLabBaseline(): void;
  resetLabHolds(): void;
  clearLabPsd(): void;
  setLabKnown(v: string): void;
  setLabIgnore(v: string): void;
  setLabMinDurationSec(v: number): void;
  setLabMinWidthMhz(v: number): void;
  setLabShowPeak(v: boolean): void;
  setLabShowMin(v: boolean): void;
  setLabShowBaseline(v: boolean): void;
  setLabSubtractBaseline(v: boolean): void;
  setLabShowPersistence(v: boolean): void;
  setLabShowRtsa(v: boolean): void;
  setLabShowAlloc(v: boolean): void;
  setLabSpurOn(v: boolean): void;
  setLabIperfHost(v: string): void;
  setLabIperfPort(v: string): void;
  setLabIperfSec(v: string): void;
  setLabIperfUdp(v: boolean): void;
  setLabIperfLoops(v: string): void;
  runLabIperf(): Promise<boolean>;
  applyPlaylist(data: unknown): boolean;
  applyPlaylistJson(raw: string): boolean;
  applyPlaylistStep(index: number): boolean;
  setLabIperfJson(raw: string): boolean;
  setLabBper(ok: number, bad: number): boolean;
  setLabJsr(opts: { jsr?: number; eSig?: number; pJ?: number }): boolean;
  clearLabJournal(): void;
  exportLabJournal(): LabJournalFile;
}

const MAX_LOG = 500;

let gTransport: Transport | null = null;
let gClient: LegionClient | null = null;
const gSdr = new MockSdrBackend();
let gLive = false;
let gWalker: ScanWalker | null = null;
let gScanTimer: ReturnType<typeof setInterval> | null = null;
/** stopScan / новый startScan: старый tick после await hostAttackScan не пишет в новый обход. */
let gScanGen = 0;
let gTxWalk: ReturnType<typeof setInterval> | null = null;
/** FPGA solo: прыжки LO через шлюз tune. Не скан и не recapture RAM. */
let gSoloWalk: ReturnType<typeof setInterval> | null = null;
let gSoloWalkGen = 0;

function stopTxWalk(): void {
  if (gTxWalk) {
    clearInterval(gTxWalk);
    gTxWalk = null;
  }
}

function stopSoloWalk(): void {
  gSoloWalkGen += 1;
  if (gSoloWalk) {
    clearInterval(gSoloWalk);
    gSoloWalk = null;
  }
}

/** Эфир-обход (air-hop): прыжки LO через шлюз tune с порогом стоянки. */
let gAirWalk: ReturnType<typeof setInterval> | null = null;

function stopAirWalk(): void {
  if (gAirWalk) {
    clearInterval(gAirWalk);
    gAirWalk = null;
  }
}

/** Поколение solo-старта: кино СТОП инкрементит, даже если fpgaArmed ещё false
 *  (capture/park в полёте). startFpgaPath сверяет после каждого await. */
let gFpgaSoloGen = 0;

export function peekFpgaSoloGen(): number {
  return gFpgaSoloGen;
}

/** Поколение ручного ARM (панель): кино СТОП / DISARM бампают — fpgaArm
 *  в полёте сверяет после await и не коммитит. */
let gFpgaArmGen = 0;

export function peekFpgaArmGen(): number {
  return gFpgaArmGen;
}
let gTxWatch: ReturnType<typeof setInterval> | null = null;
/** Heartbeat ноутбука → FPGA watchdog (deadman end-to-end, 2 Гц). */
let gFpgaKick: ReturnType<typeof setInterval> | null = null;
/** СТОП/новый ARM рвёт in-flight kick: иначе отказ старого heartbeat
 *  зовёт DISARM уже другой сессии (тот же класс, что gFpgaObserveGen). */
let gFpgaKickGen = 0;
/** kick RPC > 500 мс — не копим очередь на шлюзе и не плодим второй DISARM. */
let gFpgaKickInflight = false;
/** Телеметрия наблюдения (не тракт): ноутбук читает статус, конвейер на SDR. */
let gFpgaObserve: ReturnType<typeof setInterval> | null = null;
/** Поколение наблюдения: СТОП/новый kick рвёт stale STATUS. */
let gFpgaObserveGen = 0;
/** STATUS RPC > тика — не копим очередь и не даём старому ответу перетереть новый. */
let gFpgaObserveInflight = false;
/** Момент, когда deadman железа последний раз был доказанно сброшен: ARM
 *  (enable 0→1 обнуляет счётчик watchdog, legion_watchdog.vhd) или успешный
 *  kick. Status-опрос сюда НЕ входит: чтение STATUS не кормит watchdog —
 *  при полудуплексном отказе USB (запись мертва, чтение живо) опросы
 *  продлевали бы доказательство вечно, хотя FPGA уже погасила TX.
 *  Часы — performance.now() (монотонные): скачок NTP по Date.now() не должен
 *  ни продлевать, ни подделывать доказательство.
 *  Давность kick — диагностическое значение, а не подтверждение DISARM:
 *  без ответа шлюза приложение не может объявлять остановку состоявшейся. */
let gLastKickOkMs: number | null = null;

export function peekLastKickOkMs(): number | null {
  return gLastKickOkMs;
}

/** Тесты: подделать давность последнего kick. */
export function pokeLastKickOkMs(v: number | null): void {
  gLastKickOkMs = v;
}
/** Двойной клик ЗАШИТЬ в async-окне между кликом и set(transmitArmed). */
let gSignalBusy = false;
const gGate = new HandoffGate();
/** Хост и FPGA — два трекера: опрос STATUS не закрывает Welch-вспышки. */
const gLabHost = new LabEventTracker();
const gLabFpga = new LabEventTracker();
const gLabSpur = new SpurFilter();

function labCorridor(s: { sdrBands: AllowBand[]; sdrF1: string; sdrF2: string }): { f1: number; f2: number } {
  const f1 = s.sdrBands.length ? Math.min(...s.sdrBands.map((b) => b.f1Mhz)) : parseFloat(s.sdrF1) || 2400;
  const f2 = s.sdrBands.length ? Math.max(...s.sdrBands.map((b) => b.f2Mhz)) : parseFloat(s.sdrF2) || 2500;
  return { f1, f2 };
}

function stopFpgaKick(): void {
  if (gFpgaKick) {
    clearInterval(gFpgaKick);
    gFpgaKick = null;
  }
  gFpgaKickGen += 1;
  // Иначе старый RPC держит inflight: тик 500 мс новой сессии skip,
  // первый kick только через 1 с — край WD_LIMIT после ARM.
  gFpgaKickInflight = false;
}

function stopFpgaObserve(): void {
  if (gFpgaObserve) {
    clearInterval(gFpgaObserve);
    gFpgaObserve = null;
  }
  // In-flight STATUS после СТОП/нового ARM не должен красить lastForward
  // и тем более звать DISARM уже другой сессии (окно хуже при тике 80 мс).
  gFpgaObserveGen += 1;
  gFpgaObserveInflight = false;
}

/** Эфирный FPGA-тракт (lb_*): bladeRF 2.0 micro xA4/xA9 (AD9361 — после
 *  ухода хоста тракт поднимает NIOS-прошивка через AIR-регистры, факт:
 *  bladerf2_close → rfic->standby в libbladeRF) и bladeRF 1 x40 (LMS6002D —
 *  CONTROL bit1/2 со шлюза). Подмены каталога нет: каждая плата работает
 *  как сама себя. HackRF/Pluto/N210 этим трактом не кормятся. */
export function fpgaBoardPlan(sdrId: string): {
  ok: boolean;
  sdrId: string;
  switched: boolean;
  reason: string;
} {
  if (fpgaAirSupported(sdrId)) {
    return { ok: true, sdrId, switched: false, reason: "" };
  }
  return {
    ok: false,
    sdrId,
    switched: false,
    reason: `FPGA: ${sdrId} без ревизии legion — нужен bladeRF 2.0 micro xA4/xA9 или bladeRF 1 x40`,
  };
}

export function fpgaGatewayRefused(ping: {
  ok?: boolean;
  fake?: boolean;
  reason?: string;
}): string | null {
  if (!ping.ok) return ping.reason ?? "FPGA шлюз не отвечает (нужен desktop + legion_gateway)";
  if (ping.fake) return "FPGA: шлюз в FAKE — регистры не железо, ARM нельзя";
  return null;
}

/** Шлюз жив, но FPGA — hosted (0x80 не отвечает): ARM ушёл бы в пустоту.
 *  false — точно hosted; null/undefined — неизвестно (USB у хоста), не режем. */
export function fpgaLegionMissing(ping: {
  ok?: boolean;
  legion?: boolean | null;
}): string | null {
  if (ping.ok && ping.legion === false) {
    return "в FPGA нет ревизии legion (прошит hosted?) — ARM невозможен. Вкладка КАСТОМ FPGA: СОБРАТЬ → ПРОШИТЬ";
  }
  return null;
}

/** HDL: без capture_done плеер гонит нули (legion_player.vhd).
 *  acceptance_bench E3 проверяет флаг до ARM. sleep — не доказательство. */
export function fpgaPlayerReady(st: {
  ok?: boolean;
  capture_done?: boolean;
  reason?: string;
}): string | null {
  if (!st.ok) return st.reason ?? "FPGA: статус недоступен — захват не подтверждён";
  if (!st.capture_done) return "FPGA: в памяти нет волны (сначала загрузите её на SDR) — генерация невозможна";
  return null;
}

/** 16 сэмплов. Время окна = 2^shift / fs, не константа 8 мкс. */
const FPGA_DET_SHIFT_FAST = FPGA_US_DET_SHIFT;
/** NCO FTW и парковка эфирных режимов: 2 MSPS → окно детектора 16 = 8 мкс,
 *  петля видит ±1 МГц вокруг LO. */
const FPGA_FS_HZ = 2_000_000;

function waitMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function detWindowUs(fsHz: number, shift = FPGA_DET_SHIFT_FAST): number {
  return ((2 ** shift) / Math.max(fsHz, 1)) * 1e6;
}

function formatDetWindow(fsHz: number): string {
  const us = detWindowUs(fsHz);
  const mhz = fsHz / 1e6;
  const usTxt = us < 10 ? us.toFixed(2) : us.toFixed(0);
  const mhzTxt = Number.isInteger(mhz) ? String(mhz) : mhz.toFixed(1);
  return `~${usTxt} мкс @ ${mhzTxt} MSPS`;
}
/** Краткий RX без тона. Watch не должен глушить TX-arm. */
let gResense = false;
/** После СБРОСИТЬ не хватаем ту же частоту сразу. */
let gSkipMhz: number | null = null;
/** ОБЫЧНЫЙ в FPGA+сканер: последняя ARM-частота. Переживает возврат в скан
 *  (fpgaReturnToScan обнуляет lastForwardMhz) — от неё берётся следующая по
 *  кругу. Сброс — операторский/эпохальный стоп (fpgaDisarm), не автовозврат. */
let gFpgaTurnLastMhz: number | null = null;
void gFpgaTurnLastMhz;
/** Источник lb_gated ARM живёт в сторе (fpgaAutoCycle): его читает и UI
 *  (hero/панель), не только тики. */
/** FPGA+сканер: handoff в полёте (один за раз — USB и LO общие). */
let gFpgaHandoffBusy = false;
/** Время последней ошибки handoff. */
let gHandoffFailAt = 0;
void gHandoffFailAt;
/** Автовозврат из ARM: det_count не растёт FPGA_AIR_GONE_MS = энергия пропала. */
let gLastDetCount: number | null = null;
let gDetStagnantSinceMs: number | null = null;
let gLastScanEventSeq = 0;
/** Последнее залогированное предупреждение шлюза (длительная работа) — не спамим. */
let gArmWarnLast = "";
/** Поколение авто-цикла FPGA+сканер: инкрементит операторский СТОП.
 *  Handoff сверяет поколение после await ARM — сменилось, значит оператор
 *  стопнул в полёте: не коммитим ARM, откатываемся (паттерн gTxGen). */
let gFpgaAirGen = 0;
/** Поколение опроса сборки legion: отмена/новый старт режут старый цикл. */
let gLegionBuildGen = 0;

export function peekFpgaAirGen(): number {
  return gFpgaAirGen;
}
/** Реентерабельность возврата: два опроса подряд не должны звать её вместе. */
let gFpgaReturnBusy = false;
/** Поколение TX-эпохи. Инкрементируют stopTransmit/closeSdr/resetSdrLock/
 *  setSdrEmulation/setSdrLoad(false). In-flight handoff/re-sense сверяют
 *  поколение после await: сменилось — не коммитим и не восстанавливаем TX
 *  (найдено аудитом гонок: TX оживал после СТОП). */
let gTxGen = 0;
/** Хост-Атака: трекер и выдержка рамки. Не трогает FPGA / ESP32 / sweep. */
const gAttackTracker = new AttackTracker();
const gAttackMemory = new AttackSessionMemory();
let gAttackThinkAt = 0;
let gAttackThinkBusy = false;
let gAttackThinkGen = 0;
let gAttackThinkResidual: { tracks: AttackTrack[]; fsHz: number; centerMhz: number } | null = null;

function bumpAttackThinkGen(): void {
  gAttackThinkGen += 1;
  gAttackThinkResidual = null;
}

const EMPTY_ATTACK_ADVICE: AttackAdvice = { scene: "", after: "", hints: [], suggestPaint: null };

function attackViewOf(
  s: {
    scanPattern: string;
    attackPaint: AttackPaint | null;
    txWaveKind: WaveKind | null;
    attackHoldMs: number;
    sdrBands: AllowBand[];
    transmitArmed: boolean;
  },
  tracks: readonly AttackTrack[],
  bins: readonly ScanBin[],
  windowMhz: number,
): AttackSceneView {
  return buildAttackScene({
    tracks,
    bins,
    windowMhz,
    memory: gAttackMemory,
    paint: s.attackPaint,
    wave: s.txWaveKind,
    holdMs: s.attackHoldMs,
    bands: s.sdrBands,
    transmitArmed: s.transmitArmed,
  });
}

function attackBrainPatch(
  s: {
    scanPattern: string;
    attackPaint: AttackPaint | null;
    txWaveKind: WaveKind | null;
    attackHoldMs: number;
    sdrBands: AllowBand[];
    transmitArmed: boolean;
  },
  tracks: readonly AttackTrack[],
  bins: readonly ScanBin[],
  windowMhz: number,
): {
  attackTracks: AttackTrack[];
  attackRows: AttackRow[];
  attackAdvice: AttackAdvice;
  attackMemoryLine: string;
  attackSuggestPaint: AttackPaint | null;
} {
  if (s.scanPattern !== "auto") {
    return {
      attackTracks: [],
      attackRows: [],
      attackAdvice: EMPTY_ATTACK_ADVICE,
      attackMemoryLine: "",
      attackSuggestPaint: null,
    };
  }
  gAttackMemory.noteHops(tracks, Date.now());
  gAttackMemory.noteScene(Date.now(), tracks);
  const view = attackViewOf(s, tracks, bins, windowMhz);
  return {
    attackTracks: tracks.map((t) => ({ ...t })),
    attackRows: view.rows,
    attackAdvice: view.advice,
    attackMemoryLine: view.memoryLine,
    attackSuggestPaint: view.advice.suggestPaint,
  };
}
let gAttackHoldTimer: ReturnType<typeof setTimeout> | null = null;
let gAttackLastTxEnd = 0;

function clearAttackHoldTimer(): void {
  if (gAttackHoldTimer) {
    clearTimeout(gAttackHoldTimer);
    gAttackHoldTimer = null;
  }
}

function stopTxWatch(): void {
  if (gTxWatch) {
    clearInterval(gTxWatch);
    gTxWatch = null;
  }
}

/** Зашитая волна занимает до ±fs/2 = ±1 МГц вокруг центра (fs=2 МГц воркера) —
 *  маска своего TX шире CW-тона, иначе сканер ловит собственные края спектра. */
function ownTxGuardMhz(armed: boolean): number {
  return armed ? 1.2 : OWN_TX_GUARD_MHZ;
}

export const useLegion = create<LegionStore>((set, get) => {
  const pushLog = (dir: LogEntry["dir"], text: string) =>
    set((s) => ({ log: [...s.log.slice(-MAX_LOG + 1), { ts: Date.now(), dir, text }] }));

  // Один адрес и одна попытка на весь цикл остановки, включая ручные повторы.
  let fpgaStopTarget: { gateway: string; token: string; phase: "disarm" | "release" } | null = null;
  let fpgaDisarmFlight: Promise<void> | null = null;
  let fpgaDisarmRetry: ReturnType<typeof setTimeout> | null = null;
  const fpgaConnectionLocked = (): boolean => {
    const s = get();
    return s.fpgaArmed || s.fpgaBusy || s.fpgaStopPending;
  };

  const ingestHostLab = (bins: ScanBin[], now: number): void => {
    const s = get();
    const filtered = s.labSpurOn ? gLabSpur.filter(bins) : bins;
    if (s.labSpurOn !== false && s.labSpurReady !== gLabSpur.isCalibrated()) {
      set({ labSpurReady: gLabSpur.isCalibrated() });
    }
    const { f1, f2 } = labCorridor(get());
    const next = ingestLabFrame(get().labPsd, filtered, f1, f2, now);
    const peaks = hostPeaksForJournal(filtered, get().scanThresholdDb, get().labMinWidthMhz);
    const live = peaks
      .filter((p) => listHits(p.freqMhz, s.labKnownMhz, s.labIgnoreMhz)?.kind !== "ignore")
      .map((p) => ({
        source: "host-welch" as const,
        freqMhz: p.freqMhz,
        powerDbm: p.powerDbm,
        noiseDbm: p.noiseDbm,
        snrDb: p.snrDb,
        widthMhz: p.widthMhz,
        widthKind: "3db" as const,
        forwarded: s.lastForwardMhz != null && Math.abs(p.freqMhz - s.lastForwardMhz) < 0.3,
      }));
    const closed = gLabHost.ingest(live, now, s.labMinDurationSec);
    const mask = occupancyMask(next.composite, next.baseline);
    set({
      labPsd: next,
      labEvents: closed.length ? [...s.labEvents, ...closed].slice(-200) : s.labEvents,
      labCoverage: occupancyCoverage(mask),
    });
  };

  const ingestFpgaLab = (freqMhz: number | null, detActive: boolean, now: number): void => {
    const s = get();
    const look = parseLocaleNumber(s.fpgaAirBwMhz);
    const live =
      detActive && freqMhz != null && freqMhz > 0 && listHits(freqMhz, s.labKnownMhz, s.labIgnoreMhz)?.kind !== "ignore"
        ? [
            {
              source: "fpga-gate" as const,
              freqMhz,
              powerDbm: null,
              noiseDbm: null,
              snrDb: null,
              widthMhz: Number.isFinite(look) && look > 0 ? look : 2,
              widthKind: "look" as const,
              forwarded: true,
            },
          ]
        : [];
    const closed = gLabFpga.ingest(live, now, s.labMinDurationSec);
    if (closed.length) set({ labEvents: [...get().labEvents, ...closed].slice(-200) });
  };

  const beginSoloWalk = (
    walker: ReturnType<typeof makeSoloWalker>,
    plan: ReturnType<typeof planFpgaSoloWalk>,
    gw: (cmd: Record<string, unknown>) => Promise<FpgaStatus>,
  ): void => {
    stopSoloWalk();
    if (!plan.hop) return;
    const gen = gSoloWalkGen;
    gSoloWalk = setInterval(() => {
      if (gen !== gSoloWalkGen || !get().fpgaArmed || get().fpgaPath !== "solo") {
        stopSoloWalk();
        return;
      }
      const step = walker.next();
      void gw(soloTuneCmd(step.centerMhz, plan, get().fpgaToken)).then((r) => {
        if (gen !== gSoloWalkGen) return;
        if (!r.ok) {
          pushLog("sys", `FPGA tune: ${r.reason ?? "отказ"} — стоянка прежняя`);
          return;
        }
        set({
          lastForwardMhz: step.centerMhz,
          lastCueReason: `${plan.reason} · ${step.centerMhz.toFixed(3)} МГц · окно ${plan.analogMhz} МГц`,
        });
      });
    }, plan.dwellMs);
  };

  /** Эфир-обход: на каждой стоянке tune несёт и LO, и порог из калибровочной
   *  таблицы — одной командой, без лишнего round-trip (скорость обхода не
   *  режем). Ретрансляция по энергии — в FPGA, ноутбук только крутит сетку. */
  const beginAirWalk = (
    walker: ReturnType<typeof makeSoloWalker>,
    plan: ReturnType<typeof planFpgaSoloWalk>,
    tract: { fsHz: number; bwMhz: number },
    thrTable: readonly number[],
    centers: readonly number[],
    gw: (cmd: Record<string, unknown>) => Promise<FpgaStatus>,
  ): void => {
    stopAirWalk();
    if (!plan.hop) return;
    // Поколение эфира — как gSoloWalkGen у solo: отзыв (abortFpgaAir/СТОП/
    // DISARM бампают gFpgaAirGen) рвёт тики и stale-ответы tune, а не только
    // флаг fpgaArmed (между abort и disarm он ещё true — окно в сетевых мс).
    const gen = gFpgaAirGen;
    // tune медленнее выдержки (LAN/USB-шторм) — тик пропускаем, а не копим
    // очередь на шлюзе (там операции и так под _op_lock, но зачем очередь).
    let inflight = false;
    gAirWalk = setInterval(() => {
      if (gen !== gFpgaAirGen || !get().fpgaArmed || get().fpgaPath !== "air") {
        stopAirWalk();
        return;
      }
      if (inflight) return;
      inflight = true;
      const step = walker.next();
      const i = centers.indexOf(step.centerMhz);
      const thr = thrTable[i >= 0 ? i : 0] ?? thrTable[0];
      void gw({
        op: "tune",
        freq_mhz: step.centerMhz,
        fs_hz: tract.fsHz,
        bw_mhz: tract.bwMhz,
        det_thr: thr,
        token: get().fpgaToken,
      })
        .then((r) => {
          if (gen !== gFpgaAirGen || !get().fpgaArmed || get().fpgaPath !== "air") return;
          if (!r.ok) {
            pushLog("sys", `FPGA эфир tune: ${r.reason ?? "отказ"} — стоянка прежняя`);
            return;
          }
          set({
            lastForwardMhz: step.centerMhz,
            lastCueReason: `FPGA ретрансляция · обход ${step.centerMhz.toFixed(3)} МГц · канал ${tract.bwMhz} МГц · порог ${thr}`,
          });
        })
        .finally(() => {
          inflight = false;
        });
    }, plan.dwellMs);
  };

  const beginFpgaKick = (): void => {
    stopFpgaKick();
    stopFpgaObserve();
    set({ fpgaStatus: null });
    // ARM только что подтвердился ответом шлюза, а enable 0→1 сбросил
    // счётчик watchdog в железе — это точка отсчёта deadman-доказательства.
    gLastKickOkMs = performance.now();
    const kickGen = gFpgaKickGen;
    gFpgaKick = setInterval(() => {
      if (kickGen !== gFpgaKickGen) return;
      if (gFpgaKickInflight) return;
      gFpgaKickInflight = true;
      void hostFpga({ op: "kick", token: get().fpgaToken }, get().sdrGateway)
        .then((kr) => {
          if (kickGen !== gFpgaKickGen) return;
          if (kr.ok) {
            gLastKickOkMs = performance.now();
            return;
          }
          pushLog("sys", `FPGA heartbeat не дошёл: ${kr.reason ?? "?"} — шлём DISARM, watchdog гасит TX если шлюз мёртв`);
          if (isFpgaAirPattern(get().scanPattern) && get().fpgaMode === "lb_gated" && get().fpgaAutoCycle) {
            // Авто-цикл: канал мёртв → возврат к скану (TX уже гаснет железом).
            void fpgaReturnToScan(null);
          } else {
            void get().fpgaDisarm();
          }
        })
        .finally(() => {
          if (kickGen === gFpgaKickGen) gFpgaKickInflight = false;
        });
    }, 500); // 2 Гц. Solo fs>2 МГц: шлюз ставит WD_LIMIT ≈ 1 с (не дефолт 61).
    gFpgaObserve = setInterval(() => {
      void get().fpgaPollStatus();
    }, FPGA_OBSERVE_MS);
    void get().fpgaPollStatus();
  };

  // Троттлинг телеметрии: прошивка шлёт до ~100 строк/с, а каждый set()
  // перерисовывает панели — коалесцируем до ~15 Гц (глазу и маркеру хватает).
  let telemLastMs = 0;

  const parseLockFrom = (line: string): boolean | null => {
    const m = /LOCK=(\d)/.exec(line);
    return m ? m[1] === "1" : null;
  };

  const executeHandoff = (plan: HandoffPlan, sdrUs: number, powerDbm: number): void => {
    // Режим SDR: никаких CUE / PA / RF на ESP32.
    const wave = get().txWaveKind ?? "cw";
    set({
      detections: markForwarded(get().detections, plan.freqMhz),
      lastForwardMhz: plan.freqMhz,
      lastForwardPowerDbm: powerDbm,
      lastSdrTxUs: sdrUs || get().lastSdrTxUs,
      sdrHoldSince: Date.now(),
      lastCueReason: `атака → ${plan.freqMhz.toFixed(3)} МГц на усилитель · ${wave} · ${sdrUs} µs host`,
    });
  };

  const runHandoff = (mhz: number, powerDbm = 0): void => {
    void runHandoffAsync(mhz, powerDbm);
  };

  const runHandoffAsync = async (mhz: number, powerDbm = 0): Promise<boolean> => {
    const st = get();
    const caps = catalogCaps(st.sdrId);
    const plan = planHandoff({
      det: mhzAsDet(mhz, powerDbm),
      bands: st.sdrBands,
      loadOk: st.sdrLoadOk,
      transmitArmed: st.transmitArmed,
      lastCuedMhz: gGate.lastCuedMhz,
      inflight: gGate.inflight,
      sdrCanTx: gLive ? caps.canTx : gSdr.canTx(),
    });
    if (plan.skip) return false;
    const gen = gTxGen;
    gGate.reserve(plan.freqMhz);
    let sdrUs = 0;
    try {
      if (plan.sdrTx) {
        // Зашитая волна (вкладка ТИП СИГНАЛА) идёт во все TX-пути; иначе CW тон.
        const armed = get().txWaveKind;
        const tx = gLive
          ? armed
            ? await hostTxWave(plan.freqMhz, armed, get().txWaveParams)
            : await hostTx(plan.freqMhz)
          : armed
            ? gSdr.txWave(plan.freqMhz, armed)
            : gSdr.txCue(plan.freqMhz);
        sdrUs = tx.latencyUs;
        pushLog("sys", tx.reason);
        if (!tx.ok) {
          gGate.abort();
          return false;
        }
        if (gen !== gTxGen) {
          // Пока ждали hostTx, оператор стопнул/сбросил/закрыл SDR. Его txOff
          // ушёл в worker ПОСЛЕ нашего tx (порядок мьютекса SESSION в Rust) —
          // эфир уже погашен. Не коммитим UI и НЕ шлём ещё один txOff
          // (он убил бы TX новой эпохи, если та уже стартовала).
          gGate.abort();
          pushLog("sys", "handoff отменён оператором в полёте — состояние не коммитим");
          return false;
        }
        gGate.commit(plan.freqMhz);
        gSkipMhz = null;
      }
      executeHandoff(plan, sdrUs, powerDbm);
      return true;
    } finally {
      // release только своей эпохи: при смене поколения gate уже reset'нут
      // бампером (bump и reset идут без await между ними — вклиниться нельзя).
      // Без guard'а наш release обнулял inflight/pendingMhz у НОВОГО handoff
      // и мог вытащить его queued → параллельный TX поверх чужого (перепроверка).
      if (gen === gTxGen) {
        const queued = gGate.release();
        if (queued !== null) void runHandoffAsync(queued.mhz, queued.powerDbm);
      }
    }
  };

  const restoreHeldTx = async (mhz: number): Promise<boolean> => {
    // СТОП во время re-sense: не воскрешаем TX (аудит: restore не проверял
    // transmitArmed — тон возвращался в эфир после команды оператора).
    if (!get().transmitArmed) return false;
    // Зашитая волна (вкладка ТИП СИГНАЛА) идёт и в restore; иначе CW тон.
    const armed = get().txWaveKind;
    const tx = gLive
      ? armed
        ? await hostTxWave(mhz, armed, get().txWaveParams)
        : await hostTx(mhz)
      : armed
        ? gSdr.txWave(mhz, armed)
        : gSdr.txCue(mhz);
    if (!tx.ok) {
      pushLog("sys", tx.reason);
      return false;
    }
    return true;
  };

  /** Свой CW маскирует бин. Гасим тон, смотрим эфир, возвращаем если жива. */
  const resenseHeld = async (
    heldMhz: number,
    nBins: number,
  ): Promise<"alive" | "gone" | "error" | "switch"> => {
    const gen = gTxGen;
    gResense = true;
    try {
      const listenWhileTx =
        attackPaintOwnsTx(get().scanPattern, get().attackPaint, get().transmitArmed) &&
        (gLive ? catalogCaps(get().sdrId).fullDuplex : gSdr.fullDuplex());
      if (!listenWhileTx) {
        if (gLive) await hostTxOff();
        else gSdr.txOff();
      }
      let bins: ScanBin[] = [];
      // Атака слушает 61.44/56. hostScan = DIO 40 — после этого слайса LO/ADC
      // дёргались бы 61.44↔40 каждый RESENSE_MS. Чужие режимы этот путь не зовут.
      const analogMhz = gLive ? catalogCaps(get().sdrId).analogBwMhz : gSdr.analogBwMhz();
      const listen =
        get().scanPattern === "auto"
          ? attackListenPlan({ analogMhz, paintOwnsTx: false, paint: null })
          : null;
      if (gLive) {
        const win = listen
          ? await hostAttackScan(heldMhz, listen)
          : await hostScan(heldMhz, hostScanSpanMhz(catalogCaps(get().sdrId).analogBwMhz), nBins);
        if (!win.ok) {
          pushLog("sys", win.reason || "re-sense fail — возвращаем TX");
          await restoreHeldTx(heldMhz);
          return "error";
        }
        bins = win.bins;
      } else if (listen) {
        bins = cropPsdBins(
          gSdr.scanWindow(heldMhz, listen.fsHz / 1e6, Math.min(listen.fftN, 4096)),
          listen.cropFactor,
        );
      } else {
        bins = cropPsdBins(gSdr.scanWindow(heldMhz, hostScanSpanMhz(gSdr.analogBwMhz()), nBins));
      }
      // Стоп/сброс/закрытие, пока летал hostScan: ничего не восстанавливаем.
      if (gen !== gTxGen) return "gone";
      const dets = clipToAllowlist(detectFromBins(bins, get().scanThresholdDb), get().sdrBands);
      const nextHit = pickArmedAutoTarget({
        liveWindow: dets,
        archive: get().detections,
        heldMhz,
        heldPowerDbm: dets.find((d) => Math.abs(d.freqMhz - heldMhz) <= 0.2)?.powerDbm ?? null,
        skipMhz: gSkipMhz,
        dispatch: get().autoDispatch,
        holdMasked: false,
      });
      if (nextHit) {
        // Не dropHold до успеха: иначе тот же тик видит held=null и стомпит цель окном walker.
        const ok = await runHandoffAsync(nextHit.freqMhz, nextHit.powerDbm);
        if (ok) return "switch";
        const restored = await restoreHeldTx(heldMhz);
        return restored ? "alive" : "error";
      }
      if (heldHitAlive(dets, heldMhz)) {
        const ok = await restoreHeldTx(heldMhz);
        return ok ? "alive" : "error";
      }
      gGate.dropHold();
      set({
        lastForwardMhz: null,
        lastForwardPowerDbm: null,
        lastSdrTxUs: null,
        sdrHoldSince: null,
        lastCueReason: `засечка ${heldMhz.toFixed(3)} пропала — ждём живое окно`,
      });
      pushLog("sys", `засечка ${heldMhz.toFixed(3)} МГц пропала (RX без своего тона) — ждём следующий живой сигнал`);
      return "gone";
    } finally {
      gResense = false;
    }
  };

  const armAttackHoldTimer = (holdMs: number): void => {
    clearAttackHoldTimer();
    set({ attackTxUntil: Date.now() + holdMs });
    gAttackHoldTimer = setTimeout(() => {
      gAttackHoldTimer = null;
      gAttackLastTxEnd = Date.now();
      if (get().scanPattern !== "auto" || !get().transmitArmed) return;
      pushLog("sys", `атака: выдержка ${holdMs} мс истекла — TX гасим`);
      void get().stopTransmit();
    }, holdMs);
  };

  const thinkAttackLooks = async (
    tracks: readonly AttackTrack[],
    fsHz: number,
    centerMhz: number,
    residual: boolean,
  ): Promise<void> => {
    if (get().scanPattern !== "auto" || !gLive) return;
    if (gAttackThinkBusy) {
      if (residual) {
        gAttackThinkResidual = {
          tracks: tracks.map((t) => ({ ...t })),
          fsHz,
          centerMhz,
        };
      }
      return;
    }
    if (!residual && Date.now() - gAttackThinkAt < 450) return;
    const live = tracks.filter((t) => t.state !== "cooled").slice(0, 3);
    if (live.length === 0 && !residual) return;
    const thinkGen = gAttackThinkGen;
    gAttackThinkBusy = true;
    gAttackThinkAt = Date.now();
    try {
      const looks = live.map((t) => ({
        freqMhz: t.freqMhz,
        bwMhz: Math.max(0.4, Math.min(8, t.widthMhz * 1.4)),
      }));
      const paint = get().attackPaint;
      if (residual && paint) {
        looks.unshift({ freqMhz: paintCenterMhz(paint), bwMhz: Math.max(0.4, paintSpanMhz(paint)) });
      }
      const r = await hostAttackThink(centerMhz, fsHz, looks, residual);
      if (thinkGen !== gAttackThinkGen || get().scanPattern !== "auto") return;
      if (r.memoryCap) gAttackMemory.noteWorker(r.memorySamples ?? 0, r.memoryCap, r.memoryMs ?? 0);
      if (!r.ok) return;
      for (const row of r.looks) {
        const tr = live.find((t) => Math.abs(t.freqMhz - (row.freqMhz ?? 0)) < 0.35);
        if (tr) gAttackMemory.noteLook(tr.id, parseWorkerLook(row as unknown as Record<string, unknown>, row.freqMhz ?? 0));
      }
      if (residual) {
        const leftover = r.leftover;
        const clip = r.clip === true;
        let note = "остаток ещё считается";
        if (clip) note = "Вычет мёртв: приёмник в клипе. Снимите усиление, иначе края не видны.";
        else if (leftover != null && leftover <= 0.12) note = "В рамке после вычета тихо — на этот взгляд накрыто.";
        else if (leftover != null && leftover > 0.35) {
          note = `В рамке после вычета ещё ${Math.round(leftover * 100)}% энергии — края или другой слой живы.`;
        } else if (leftover != null) {
          note = `После вычета осталось ≈ ${Math.round(leftover * 100)}% энергии в вырезе.`;
        }
        gAttackMemory.noteResidual({
          ts: Date.now(),
          leftover: leftover ?? 1,
          clip,
          paintLow: paint?.f1Mhz ?? 0,
          paintHigh: paint?.f2Mhz ?? 0,
          note,
        });
      }
      const st = get();
      const analogNow = catalogCaps(st.sdrId).analogBwMhz;
      const listenNow = attackListenPlan({
        analogMhz: analogNow,
        paintOwnsTx: attackPaintOwnsTx(st.scanPattern, st.attackPaint, st.transmitArmed),
        paint: st.attackPaint,
      });
      set(attackBrainPatch(st, gAttackTracker.snapshot(), st.scanBins, listenNow.spanMhz));
    } finally {
      gAttackThinkBusy = false;
      const pend = gAttackThinkResidual;
      gAttackThinkResidual = null;
      if (pend && thinkGen === gAttackThinkGen && get().scanPattern === "auto" && gLive) {
        void thinkAttackLooks(pend.tracks, pend.fsHz, pend.centerMhz, true);
      }
    }
  };

  const refreshAttackBrain = (): void => {
    const st = get();
    if (st.scanPattern !== "auto") return;
    set(
      attackBrainPatch(
        st,
        gAttackTracker.snapshot(),
        st.scanBins,
        attackListenPlan({
          analogMhz: catalogCaps(st.sdrId).analogBwMhz,
          paintOwnsTx: attackPaintOwnsTx(st.scanPattern, st.attackPaint, st.transmitArmed),
          paint: st.attackPaint,
        }).spanMhz,
      ),
    );
  };

  /** Рамка оператора: заливка выбранной волной. Не pickArmedAutoTarget. */
  const fireAttackPaintTx = async (): Promise<boolean> => {
    if (get().scanPattern !== "auto") return false;
    const paint = get().attackPaint;
    if (!paint) return false;
    const clipped = clipPaintToAllowlist(paint, get().sdrBands);
    if (!clipped) {
      pushLog("sys", paintRefuseReason(paint, get().sdrBands, get().sdrLoadOk) ?? "ПЕРЕДАТЬ: рамка отказ");
      return false;
    }
    if (Date.now() - gAttackLastTxEnd < ATTACK_COOLDOWN_MS && get().lastForwardMhz == null) {
      pushLog("sys", `ПЕРЕДАТЬ: пауза ${ATTACK_COOLDOWN_MS} мс после прошлой заливки`);
      return false;
    }
    const waveKind = get().txWaveKind ?? "sine";
    const params = attackWaveParams(waveKind, clipped, get().txWaveParams);
    const mhz = paintCenterMhz(clipped);
    const listen = attackListenPlan({
      analogMhz: catalogCaps(get().sdrId).analogBwMhz,
      paintOwnsTx: true,
      paint: clipped,
    });
    let fsHz = listen.fsHz;
    const hold = clampAttackHoldMs(get().attackHoldMs);
    const caps = catalogCaps(get().sdrId);
    const plan = planHandoff({
      det: mhzAsDet(mhz, 0),
      bands: get().sdrBands,
      loadOk: get().sdrLoadOk,
      transmitArmed: get().transmitArmed,
      lastCuedMhz: gGate.lastCuedMhz,
      inflight: gGate.inflight,
      sdrCanTx: gLive ? caps.canTx : gSdr.canTx(),
    });
    if (plan.skip) {
      if (plan.reason.includes("уже на этой частоте")) {
        armAttackHoldTimer(hold);
        return true;
      }
      pushLog("sys", plan.reason);
      return false;
    }
    const gen = gTxGen;
    gGate.reserve(plan.freqMhz);
    try {
      // xA4 AD9361: один BBPLL. Сначала слух на часах рамки, потом TX — иначе
      // setSampleRate(TX) перетягивает RX с 61.44, пока кольцо думает старое fs
      // (Nuand forum, robert.ghilduta 2023-03-20).
      if (gLive) {
        const win = await hostAttackScan(mhz, listen);
        if (gen !== gTxGen) {
          gGate.abort();
          pushLog("sys", "атака рамка: отменена оператором в полёте — состояние не коммитим");
          return false;
        }
        if (!win.ok) {
          gGate.abort();
          pushLog("sys", win.reason || "ПЕРЕДАТЬ: слух не встал на часы рамки");
          return false;
        }
        if (win.fsHz && win.fsHz > 0) fsHz = win.fsHz;
      }
      const tx = gLive
        ? await hostTxWave(plan.freqMhz, waveKind, params, fsHz)
        : gSdr.txWave(plan.freqMhz, waveKind);
      pushLog("sys", tx.reason);
      if (!tx.ok) {
        gGate.abort();
        return false;
      }
      if (gen !== gTxGen) {
        gGate.abort();
        pushLog("sys", "атака рамка: отменена оператором в полёте — состояние не коммитим");
        return false;
      }
      gGate.commit(plan.freqMhz);
      gSkipMhz = null;
      executeHandoff(plan, tx.latencyUs, 0);
      gAttackTracker.markHeld(plan.freqMhz);
      const wave = waveKind ?? "cw";
      const after = get();
      set({
        ...attackBrainPatch(after, gAttackTracker.snapshot(), after.scanBins, attackListenPlan({
          analogMhz: catalogCaps(after.sdrId).analogBwMhz,
          paintOwnsTx: true,
          paint: clipped,
        }).spanMhz),
        lastCueReason: `атака рамка ${clipped.f1Mhz.toFixed(2)}…${clipped.f2Mhz.toFixed(2)} МГц · ${wave} · ${hold} мс · fs ${(fsHz / 1e6).toFixed(2)} МГц · ${paintWaveHint(waveKind, clipped, params)}`,
      });
      void thinkAttackLooks(gAttackTracker.snapshot(), fsHz, plan.freqMhz, true);
      armAttackHoldTimer(hold);
      return true;
    } finally {
      if (gen === gTxGen) gGate.release();
    }
  };

  const startOpenLoopTx = (): void => {
    stopTxWalk();
    const st = get();
    const caps = catalogCaps(st.sdrId);
    const analog = gLive ? caps.analogBwMhz : gSdr.analogBwMhz();
    const walkPat = st.scanPattern === "auto" ? "sweep" : st.scanPattern;
    const walker = new ScanWalker({
      bands: st.sdrBands,
      pattern: walkPat,
      windowMhz: clampWindowMhz(parseFloat(st.scanWindowMhz), analog),
      analogBwMhz: analog,
      dwellMs: parseFloat(st.scanDwellMs),
      seed: Date.now() & 0xffffffff,
    });
    gWalker = walker;
    let inflight = false;
    const stepTx = (): void => {
      if (inflight || !get().transmitArmed) return;
      const step = gWalker?.next();
      if (!step?.centerMhz) return;
      inflight = true;
      void runHandoffAsync(step.centerMhz, 0).finally(() => {
        inflight = false;
      });
    };
    stepTx();
    gTxWalk = setInterval(stepTx, walker.tickMs);
  };

  const bandsForFpgaAir = (): AllowBand[] => {
    const s = get();
    if (s.sdrBands.length > 0) return s.sdrBands;
    const band = parseSdrRxBand(s.sdrF1, s.sdrF2, s.sdrId);
    return band ? [band] : [];
  };

  const ensureSdrBand = (): boolean => {
    const s = get();
    const rx = catalogById(s.sdrId)?.rxMhz;
    if (s.sdrBands.length > 0) {
      if (rx && s.sdrBands.some((b) => b.f1Mhz < rx[0] || b.f2Mhz > rx[1])) {
        pushLog("sys", `SDR: полоса вне RX ${rx[0]}–${rx[1]} МГц`);
        return false;
      }
      return true;
    }
    const band = parseSdrRxBand(s.sdrF1, s.sdrF2, s.sdrId);
    if (!band) {
      pushLog("sys", "SDR: задайте начало и конец полосы (F1…F2)");
      return false;
    }
    set({ sdrBands: [band] });
    pushLog("sys", `SDR полоса ${band.f1Mhz}…${band.f2Mhz} (авто из F1/F2)`);
    return true;
  };

  const releaseSoapyForFpga = async (): Promise<void> => {
    if (gLive) {
      await hostTxOff();
      await hostClose();
    }
    gSdr.txOff();
    gSdr.close();
    gLive = false;
    set({ sdrOpened: null, sdrRemote: "", transmitArmed: false, signalTxActive: false });
  };

  const releaseCancelledFpgaUsb = async (target: { sdrGateway: string; fpgaToken: string }): Promise<void> => {
    // ARM ещё не отправляли. Повторяем только освобождение, пока шлюз
    // не подтвердит его; адрес остаётся адресом отменённого запуска.
    fpgaStopTarget ??= { gateway: target.sdrGateway, token: target.fpgaToken, phase: "release" };
    await get().fpgaDisarm();
  };

  const parkFpgaLo = async (opts: {
    midMhz: number;
    analogMhz: number;
    spanMhz: number;
    rx: boolean;
    fsHz: number;
    /** Эфир: явная полоса канала оператора. Без неё — min(analog, max(2, span)). */
    bwMhz?: number;
    gw: (cmd: Record<string, unknown>) => Promise<FpgaStatus>;
  }): Promise<{ ok: boolean; fsHz: number }> => {
    let fsHz = opts.fsHz;
    const rel = await opts.gw({ op: "usb", action: "release" });
    if (!rel.ok) {
      pushLog("sys", `FPGA USB release: ${rel.reason ?? "отказ"}`);
      return { ok: false, fsHz };
    }
    let parked = false;
    try {
      if (get().sdrEmulation || !hostSdrAvailable()) {
        pushLog("sys", "FPGA: Soapy нет — LO не паркуем, ARM без частоты нельзя");
        return { ok: false, fsHz };
      }
      await get().openSdr({ requireHw: requireHwForSdr(get().sdrId) || undefined });
      if (!gLive) {
        pushLog("sys", "FPGA: SDR не открылся — LO не поставлен");
        return { ok: false, fsHz };
      }
      const win = opts.bwMhz ?? Math.min(opts.analogMhz, Math.max(2, opts.spanMhz || opts.analogMhz));
      const pk = await hostPark(opts.midMhz, win, opts.fsHz, opts.rx, true);
      pushLog("sys", pk.reason || (pk.ok ? "FPGA: LO поставлен" : "FPGA: LO не поставился"));
      if (!pk.ok) return { ok: false, fsHz };
      if (pk.fake) {
        pushLog("sys", "FPGA: FAKE park — не эфир, ARM нельзя");
        return { ok: false, fsHz };
      }
      if (pk.fsHz && pk.fsHz > 0) fsHz = pk.fsHz;
      parked = true;
    } finally {
      await releaseSoapyForFpga();
      const acq = await opts.gw({ op: "usb", action: "acquire" });
      if (!acq.ok) {
        pushLog("sys", `FPGA USB acquire: ${acq.reason ?? "отказ"}`);
        parked = false;
      }
    }
    return { ok: parked, fsHz };
  };

  /** Старт онбордового перехвата: один хозяин — SDR. Ноутбук рубильник.
   *  USB не в круге «увидел → усилитель». x40: один park Soapy (Si5338 fs/BW
   *  хост ставит, NIOS LMS не трогает). micro: AIR_PREP без Soapy. */
  const startOnboardIntercept = async (): Promise<void> => {
    const s = get();
    if (s.fpgaArmed || s.fpgaBusy || s.fpgaStopPending || gFpgaHandoffBusy) return;
    const blocked = modeConflict("sdr", s.corridorRunning, false);
    if (blocked) {
      pushLog("sys", blocked);
      return;
    }
    if (s.rfOn || s.paOn) {
      pushLog("sys", "СТАРТ: сначала RF OFF / PA OFF на ESP32 — тракты не вместе");
      return;
    }
    if (s.signalTxActive) {
      pushLog("sys", "СТАРТ: идёт TX сигнала — сначала СТОП на вкладке ТИП СИГНАЛА");
      return;
    }
    if (s.flashBusy) {
      pushLog("sys", "СТАРТ: идёт прошивка — дождитесь конца записи");
      return;
    }
    if (!ensureSdrBand()) return;
    const board = fpgaBoardPlan(s.sdrId);
    if (!board.ok) {
      pushLog("sys", board.reason);
      return;
    }
    if (!s.sdrLoadOk) {
      pushLog("sys", `${FPGA_AIR_MODE_RU}: подтвердите нагрузку 50 Ом на выходе усилителя SDR`);
      return;
    }
    const analog = catalogCaps(s.sdrId).analogBwMhz;
    const detThr =
      Number.isFinite(s.fpgaDetThr) && s.fpgaDetThr > 0 ? s.fpgaDetThr : FPGA_DEFAULT_DET_THR;
    const lookRaw = parseLocaleNumber(s.fpgaAirBwMhz);
    const dwellRaw = parseLocaleNumber(s.fpgaTurnDwellMs);
    const periodRaw = parseLocaleNumber(s.fpgaSurveyPeriodMs);
    if (!Number.isFinite(lookRaw) || lookRaw <= 0) {
      pushLog("sys", `${FPGA_AIR_MODE_RU}: задайте ширину взгляда числом (например 10 или 0.2)`);
      return;
    }
    if (!Number.isFinite(dwellRaw) || dwellRaw <= 0) {
      pushLog("sys", `${FPGA_AIR_MODE_RU}: задайте выдержку числом (0,4 и 0.4 — 400 мкс)`);
      return;
    }
    if (!Number.isFinite(periodRaw) || periodRaw <= 0) {
      pushLog("sys", `${FPGA_AIR_MODE_RU}: задайте период сканирования числом (например 5)`);
      return;
    }
    const plan = planOnboardIntercept({
      sdrId: s.sdrId,
      analogBwMhz: analog,
      bands: get().sdrBands,
      loadOk: s.sdrLoadOk,
      detThr,
      detShift: s.fpgaDetShift,
      lookMhz: lookRaw,
      turn: fpgaInnerDispatch(s.autoDispatch) === "turn",
      park: true,
      dwellMs: dwellRaw,
      surveyPeriodMs: periodRaw,
      fftEnable: true,
    });
    if (!plan.ok) {
      pushLog("sys", plan.reason);
      return;
    }
    if (s.sdrEmulation) {
      pushLog(
        "sys",
        `${FPGA_AIR_MODE_RU}: эмуляция — платы нет, ARM нет. USB-IQ handoff убран: без железа эфир не смотрим.`,
      );
      return;
    }
    gLastScanEventSeq = 0;
    set({ fpgaMode: "lb_gated", fpgaBusy: true, fpgaStatus: null, fpgaAutoCycle: false });
    gFpgaAirGen += 1;
    const airGen = gFpgaAirGen;
    const gw = (cmd: Record<string, unknown>) =>
      hostFpga({ ...cmd, token: get().fpgaToken }, get().sdrGateway);
    try {
      // Хост-FFT и Soapy держат USB эксклюзивно (FX3). Пока тик скана жив —
      // шлюз не займёт кабель, плата не станет хозяином. Soapy закрываем
      // до acquire и на micro (там нет parkFpgaLo).
      get().stopScan();
      stopAirWalk();
      if (get().transmitArmed) await get().stopTransmit();
      if (gFpgaAirGen !== airGen) return;
      const ping = await gw({ op: "ping" });
      if (gFpgaAirGen !== airGen) return;
      if (ping.legion !== undefined) set({ fpgaLegion: ping.legion ?? null });
      const no = fpgaGatewayRefused(ping);
      if (no) {
        pushLog("sys", `${FPGA_AIR_MODE_RU}: ${no}`);
        return;
      }
      const noLegion = fpgaLegionMissing(ping);
      if (noLegion) {
        pushLog("sys", `${FPGA_AIR_MODE_RU}: ${noLegion}`);
        return;
      }
      const bands = get().sdrBands;
      const f1 = Math.min(...bands.map((b) => b.f1Mhz));
      const f2 = Math.max(...bands.map((b) => b.f2Mhz));
      let fsHz = plan.fsHz;
      if (s.sdrId === "bladerf-x40") {
        const pk = await parkFpgaLo({
          midMhz: plan.firstMhz,
          analogMhz: analog,
          spanMhz: plan.lookMhz,
          rx: true,
          fsHz: plan.fsHz,
          bwMhz: plan.lookMhz,
          gw,
        });
        if (gFpgaAirGen !== airGen) {
          await releaseCancelledFpgaUsb(s);
          return;
        }
        if (!pk.ok) {
          pushLog("sys", `${FPGA_AIR_MODE_RU}: x40 — Soapy не поставил fs/BW/первый LO, ARM нет`);
          return;
        }
        fsHz = pk.fsHz;
      } else {
        await releaseSoapyForFpga();
        const acq = await gw({ op: "usb", action: "acquire" });
        if (gFpgaAirGen !== airGen) {
          await releaseCancelledFpgaUsb(s);
          return;
        }
        if (!acq.ok) {
          pushLog("sys", `FPGA USB acquire: ${acq.reason ?? "отказ"}`);
          return;
        }
      }
      if (gFpgaAirGen !== airGen) return;
      const r = await gw(
        fpgaArmCmd("lb_gated", {
          detThr: plan.detThr,
          detShift: plan.detShift,
          token: get().fpgaToken,
          freqMhz: plan.firstMhz,
          fsHz,
          bwMhz: plan.lookMhz,
          scanEnable: true,
          scanF1Mhz: f1,
          scanF2Mhz: f2,
          scanTurn: plan.turn,
          scanPark: plan.park,
          scanSurvey: plan.survey,
          scanDwellMs: plan.dwellMs,
          scanSurveyMs: plan.surveyPeriodMs,
          fftEnable: true,
          fireBwMhz: plan.fireBwMhz,
          settleN: plan.settleN,
          scanBands: bands,
        }),
      );
      if (gFpgaAirGen !== airGen) {
        // ARM уже отправлен. Отрицательный ответ может означать потерю
        // связи после записи: отмена требует подтверждённого DISARM.
        if (!r.ok) pushLog("sys", `FPGA: ответ на отменённый ARM: ${r.reason ?? "отказ"} — требуется подтверждение отключения`);
        await get().fpgaDisarm();
        return;
      }
      if (!r.ok) {
        pushLog("sys", `${FPGA_AIR_MODE_RU} ARM: ${r.reason ?? "отказ"}`);
        await get().fpgaDisarm();
        return;
      }
      set({
        fpgaArmed: true,
        fpgaPath: "air",
        lastForwardMhz: plan.firstMhz,
        sdrHoldSince: Date.now(),
        lastCueReason: plan.reason,
      });
      beginFpgaKick();
      pushLog("sys", `${FPGA_AIR_MODE_RU}: ${plan.reason} · порог ${plan.detThr} (не полка USB-IQ)`);
    } finally {
      set({ fpgaBusy: false });
    }
  };

  /** Возврат в скан-фазу цикла FPGA+сканер: DISARM → USB хосту → скан.
   *  skipMhz — частота, которую сканер пропускает (энергия пропала: не
   *  цепляемся за мёртвую; refreshSkipMhz снимет skip, когда она замолчит
   *  окончательно и оживёт вновь). null — без skip (watchdog/оператор). */
  const fpgaReturnToScan = async (skipMhz: number | null, restart = true): Promise<void> => {
    if (gFpgaReturnBusy) return; // два опроса подряд — один возврат
    gFpgaReturnBusy = true;
    // Поколения на входе: отложенный startScan сверит их при срабатывании —
    // СТОП/closeSdr/интерлок за окном возврата (disarm+release — десятки мс
    // сети, живое окно для клика) отменяют рестарт скана (ревью 2026-08-28).
    const airGen = gFpgaAirGen;
    const txGen = gTxGen;
    try {
      stopFpgaKick();
      stopFpgaObserve();
      stopAirWalk();
      if (get().fpgaArmed || get().fpgaStopPending) {
        // На micro NIOS сам уводит RFIC в standby по CTRL=0 (legion_cmds.c).
        const d = await hostFpga({ op: "disarm", token: get().fpgaToken }, get().sdrGateway);
        // Отказ не прячем: состояние снимаем всё равно (цикл обязан жить),
        // а железо за это время гаснет своим watchdog — но в логе честно.
        if (!d.ok) pushLog("sys", `FPGA DISARM при возврате к скану: ${d.reason ?? "отказ"} — TX гаснет watchdog железа`);
      }
      set({ fpgaArmed: false, fpgaAutoCycle: false, fpgaPath: null, fpgaBusy: false, lastForwardMhz: null });
      gLastDetCount = null;
      gLastScanEventSeq = 0;
      gDetStagnantSinceMs = null;
      // USB обратно хосту; startScan ниже сам переоткроет SDR (openSdr).
      const relRet = await hostFpga({ op: "usb", action: "release", token: get().fpgaToken }, get().sdrGateway);
      if (!relRet.ok) pushLog("sys", `FPGA USB release: ${relRet.reason ?? "отказ"}`);
      gSkipMhz = skipMhz;
      // restart=false: оператор стопнул в полёте — чистимся, но скан не
      // рестартим (его решение, не таймаут).
      if (restart && isFpgaAirPattern(get().scanPattern)) {
        // Отложенно: из fpgaHandoff.fail мы ещё внутри handoff (gFpgaHandoffBusy),
        // и startScan честно отказал бы — пусть finally сначала снимет флаги.
        setTimeout(() => {
          if (gFpgaAirGen !== airGen || gTxGen !== txGen) return; // оператор успел
          if (isFpgaAirPattern(get().scanPattern) && !get().fpgaArmed && !get().fpgaBusy) {
            get().startScan();
          }
        }, 0);
      }
    } finally {
      gFpgaReturnBusy = false;
    }
  };

  /** USB-handoff скан→FPGA убран из продукта: USB не в круге увидел→усилитель.
   *  Имя остаётся — исходник читают тесты. Вызов не ARM'ит и не ставит auto-cycle. */
  const fpgaHandoff = async (mhz: number, _powerDbm: number): Promise<void> => {
    pushLog(
      "sys",
      `FPGA handoff ${mhz.toFixed(3)} МГц: путь убран — USB не в круге увидел→усилитель. Старт = ${FPGA_AIR_MODE_RU} (антенна RX1, усилитель TX1).`,
    );
  };

  // Старт перехвата tickScan fail-closed — USB-handoff не вызывается.
  void fpgaHandoff;

  return {
    transportKind: "mock",
    transportState: "disconnected",
    transportDetail: undefined,
    ports: [],
    selectedPort: "",
    // Если UI открыт с самого ESP32 (LittleFS) — WS на тот же хост, порт 81.
    // Иначе — дефолт AP-режима прошивки.
    wsUrl:
      typeof window !== "undefined" &&
      !["localhost", "127.0.0.1", ""].includes(window.location.hostname)
        ? `ws://${window.location.hostname}:81/ws`
        : "ws://192.168.4.1:81/ws",
    freqMhz: "2475.000",
    lock: null,
    powerDbm: 5,
    rfOn: false,
    attDb: 0,
    status: null,
    corrF1: "2400",
    corrF2: "2500",
    corrStepKhz: "1000",
    corrDwellMs: "10",
    corrSeed: "1337",
    corrMode: "SWEEP",
    corridorRunning: false,
    telemFreq: null,
    telemLock: null,
    workspace: "scan",
    allowBands: [],
    allowF1: "2400",
    allowF2: "2500",
    loadOk: true,
    sdrBands: [],
    sdrF1: "2400",
    sdrF2: "2500",
    sdrLoadOk: true,
    paMa: 0,
    paOn: false,
    autoCue: false,
    transmitArmed: false,
    lastForwardMhz: null,
    sdrHoldSince: null,
    sdrDevices: gSdr.probe(),
    sdrId: "bladerf-micro-xa4",
    // Пусто = локальный USB. Дефолт-IP шлюза — ловушка: после перезапуска
    // поле снова полное, и open уезжает в driver=remote → "no match" (стенд 2026-08-27).
    sdrGateway: "",
    sdrOpened: null,
    sdrRemote: "",
    sdrFlashName: "hostedxA4.rbf",
    sdrFlashAction: "load-fpga",
    sdrFlashConfirm: false,
    lastFlash: null,
    flashBusy: false,
    esp32FlashEnv: "esp32-s3",
    esp32FlashConfirm: false,
    esp32Chip: null,
    esp32ChipPort: null,
    esp32ChipRaw: "",
    lastEsp32Flash: null,
    sdrEmulation: !isTauriRuntime(),
    sdrHostReady: false,
    sdrHostDetail: "",
    sdrImagePath: "",
    sdrImageBytes: 0,
    legionBuildPhase: "idle",
    legionBuildLog: "",
    legionArtifactPath: "",
    legionArtifactSha256: "",
    legionEnvDetail: "",
    legionCanBuild: false,
    legionFlashTarget: "local",
    legionFlashAction: "load",
    legionFlashPath: "",
    legionFlashConfirm: false,
    lastLegionFlash: null,
    scanRunning: false,
    scanThresholdDb: 12,
    scanSensitivity: thresholdToSensitivity(12),
    scanPattern: "auto",
    autoDispatch: "park",
    scanWindowMhz: "20",
    scanDwellMs: "40",
    scanCenterMhz: null,
    scanBins: [],
    detections: [],
    lastInterceptMhz: null,
    lastCueReason: "",
    attackTracks: [],
    attackPaint: null,
    attackPaintDraft: null,
    attackHoldMs: ATTACK_HOLD_DEFAULT_MS,
    attackTxUntil: null,
    attackRows: [],
    attackAdvice: EMPTY_ATTACK_ADVICE,
    attackMemoryLine: "",
    attackSuggestPaint: null,
    lastSdrTxUs: null,
    lastForwardPowerDbm: null,
    labPsd: emptyLabPsd(),
    labEvents: [],
    labKnown: "",
    labIgnore: "",
    labKnownMhz: [],
    labIgnoreMhz: [],
    labMinDurationSec: LAB_MIN_DURATION_SEC,
    labMinWidthMhz: LAB_MIN_WIDTH_MHZ,
    labShowPeak: true,
    labShowMin: false,
    labShowBaseline: true,
    labSubtractBaseline: false,
    labShowPersistence: true,
    labShowRtsa: true,
    labShowAlloc: true,
    labSpurOn: true,
    labSpurReady: false,
    labIperfHost: "",
    labIperfPort: "5201",
    labIperfSec: "5",
    labIperfUdp: true,
    labIperfLoops: "1",
    labIperfBusy: false,
    labPlaylist: null,
    labPlaylistIdx: 0,
    labIperf: null,
    labBper: null,
    labJsr: null,
    labCoverage: null,
    signalKind: "qpsk",
    signalParams: defaultParams("qpsk"),
    signalFreqMhz: "2442.000",
    signalTxActive: false,
    txWaveKind: null,
    txWaveParams: {},
    fpgaMode: "player",
    fpgaArmed: false,
    fpgaAutoCycle: false,
    fpgaBusy: false,
    fpgaStopPending: false,
    fpgaStopPhase: null,
    fpgaStatus: null,
    fpgaLegion: null,
    fpgaToken: "",
    fpgaDetThr: FPGA_DEFAULT_DET_THR,
    fpgaDetShift: FPGA_US_DET_SHIFT,
    fpgaTurnDwellMs: String(FPGA_TURN_DWELL_DEFAULT_MS),
    fpgaSurveyPeriodMs: String(FPGA_SURVEY_PERIOD_DEFAULT_MS),
    fpgaAirBwMhz: String(FPGA_AIR_BW_DEFAULT_MHZ),
    fpgaAirDwellMs: String(FPGA_SOLO_DWELL_DEFAULT_MS),
    fpgaAirWalkPattern: "sweep",
    fpgaPath: null,
    fpgaSoloWindowMhz: "10",
    fpgaSoloDwellMs: "500",
    fpgaSoloPattern: "sweep",
    log: [],

    setTransportKind: (k) =>
      set(k === "htool-sl22" ? { transportKind: k, corrMode: "SWEEP" } : { transportKind: k }),
    setSelectedPort: (p) => set({ selectedPort: p }),
    setWsUrl: (u) => set({ wsUrl: u }),
    setFreqMhz: (f) => set({ freqMhz: f }),
    setCorrField: (field, v) => set({ [field]: v }),
    setCorrMode: (m) => set({ corrMode: m }),
    setWorkspace: (w) => {
      const prev = modeOf(get().workspace);
      const next = modeOf(w);
      if (prev !== next) {
        if (next === "esp32") {
          get().stopScan();
          // stopTransmit шлёт DISARM, если FPGA играет. Не дублировать fpgaDisarm —
          // два параллельных DISARM по одному USB/шлюзу.
          void get().stopTransmit();
        } else if (get().corridorRunning) {
          void get().corridorStop();
        }
      }
      set({ workspace: w });
    },
    setAllowField: (field, v) => set({ [field]: v }),
    setSdrAllowField: (field, v) => set({ [field]: v }),
    setPaMa: (ma) => set({ paMa: ma }),
    setAutoCue: (v) => set({ autoCue: v }),
    setSdrId: (id) => {
      if (id !== get().sdrId && fpgaConnectionLocked()) {
        pushLog("sys", "Смена устройства заблокирована до подтверждённой остановки FPGA");
        return;
      }
      set({
        sdrId: id,
        sdrFlashName: defaultFlashName(id) || get().sdrFlashName,
        // Не перезаполняем IP шлюза при смене устройства: пустое = локальный USB,
        // подсказка-IP видна в placeholder поля. Иначе молча уезжаем в remote.
        sdrGateway: get().sdrGateway,
        sdrFlashConfirm: false,
      });
    },
    setSdrGateway: (v) => {
      if (v === get().sdrGateway) return;
      if (fpgaConnectionLocked()) {
        pushLog("sys", "Смена шлюза заблокирована до подтверждённой остановки FPGA");
        return;
      }
      stopFpgaObserve();
      set({ sdrGateway: v, fpgaStatus: null, fpgaLegion: null });
    },
    setSdrFlashName: (v) =>
      set({
        sdrFlashName: v,
        sdrImagePath: usableImagePath(v) ? v.trim() : get().sdrImagePath,
        sdrImageBytes: usableImagePath(v) && get().sdrImageBytes <= 0 ? 1 : get().sdrImageBytes,
        sdrFlashConfirm: false,
      }),
    setSdrFlashAction: (a) => set({ sdrFlashAction: a, sdrFlashConfirm: false }),
    setSdrFlashConfirm: (v) => set({ sdrFlashConfirm: v }),
    setEsp32FlashEnv: (v) =>
      set({
        esp32FlashEnv: isEsp32FlashEnv(v) ? v : "esp32-s3",
        esp32FlashConfirm: false,
      }),
    setEsp32FlashConfirm: (v) => set({ esp32FlashConfirm: v }),
    setSdrEmulation: (v) => {
      if (get().fpgaBusy || get().fpgaStopPending) {
        pushLog("sys", "Смена бэкенда заблокирована до завершения операции FPGA — сначала СТОП");
        return;
      }
      // Смена бэкенда = новая эпоха. DISARM дожидаемся: иначе Soapy/мок
      // переключаются, а FPGA ещё держит TX до watchdog.
      void (async () => {
        gTxGen += 1;
        stopTxWatch();
        stopTxWalk();
        if (get().fpgaArmed || get().fpgaStopPending) await get().fpgaDisarm();
        else {
          stopFpgaKick();
          stopFpgaObserve();
          stopAirWalk();
          set({ fpgaArmed: false });
        }
        if (get().fpgaStopPending) return;
        get().stopScan();
        gGate.reset();
        if (gLive) {
          void hostTxOff();
          void hostClose();
        }
        gLive = false;
        gSdr.setEmulation(v);
        set({
          sdrEmulation: v,
          sdrDevices: gSdr.probe(),
          sdrOpened: gSdr.opened(),
          sdrRemote: gSdr.remoteArgs(),
          transmitArmed: false,
          signalTxActive: false,
          lastForwardMhz: null,
          lastSdrTxUs: null,
          lastForwardPowerDbm: null,
          sdrHoldSince: null,
        });
        pushLog("sys", v ? "SDR: эмуляция включена (не эфир)" : "SDR: эмуляция выкл — нужен Soapy/CLI на шлюзе");
      })();
    },
    setSdrImageFile: (name, byteLength, path) =>
      set({
        sdrFlashName: name,
        sdrImageBytes: byteLength,
        sdrImagePath: path ?? "",
        sdrFlashConfirm: false,
      }),
    setScanThreshold: (db) => {
      const thr = Number.isFinite(db) ? db : 12;
      set({ scanThresholdDb: thr, scanSensitivity: thresholdToSensitivity(thr) });
    },
    setScanSensitivity: (sens) => {
      const s = Math.min(100, Math.max(0, Number.isFinite(sens) ? sens : 0));
      const thr = sensitivityToThresholdDb(s);
      set({ scanSensitivity: s, scanThresholdDb: thr });
    },
    setScanPattern: (p) => {
      if (p === "auto") {
        set({ scanPattern: p });
        return;
      }
      clearAttackHoldTimer();
      gAttackTracker.reset();
      bumpAttackThinkGen();
      set({
        scanPattern: p,
        attackTracks: [],
        attackPaint: null,
        attackPaintDraft: null,
        attackTxUntil: null,
        attackRows: [],
        attackAdvice: EMPTY_ATTACK_ADVICE,
        attackMemoryLine: "",
        attackSuggestPaint: null,
      });
      if (p !== "auto") gAttackMemory.reset();
    },
    setAttackPaint: (p) => {
      if (get().scanPattern !== "auto") return;
      if (!p) {
        set({ attackPaint: null, attackPaintDraft: null });
        const st = get();
        set(attackBrainPatch(st, st.attackTracks, st.scanBins, attackListenPlan({
          analogMhz: catalogCaps(st.sdrId).analogBwMhz,
          paintOwnsTx: false,
          paint: null,
        }).spanMhz));
        return;
      }
      const paint = clampPaintToCaps(p);
      set({ attackPaint: paint, attackPaintDraft: null });
      const st = get();
      set(attackBrainPatch({ ...st, attackPaint: paint }, st.attackTracks, st.scanBins, attackListenPlan({
        analogMhz: catalogCaps(st.sdrId).analogBwMhz,
        paintOwnsTx: attackPaintOwnsTx(st.scanPattern, paint, st.transmitArmed),
        paint,
      }).spanMhz));
    },
    setAttackPaintDraft: (p) => {
      if (get().scanPattern !== "auto") return;
      set({ attackPaintDraft: p ? clampPaintToCaps(p) : null });
    },
    clearAttackPaint: () => {
      get().setAttackPaint(null);
    },
    setAttackHoldMs: (ms) => {
      if (get().scanPattern !== "auto") return;
      set({ attackHoldMs: clampAttackHoldMs(ms) });
      refreshAttackBrain();
    },
    applyAttackHint: (kind) => {
      if (get().scanPattern !== "auto") return;
      if (get().transmitArmed) {
        pushLog("sys", "подсказка: идёт передача — сначала Стоп, потом можно взять");
        return;
      }
      const hint = get().attackAdvice.hints.find((h) => h.kind === kind);
      if (!hint) return;
      if (kind === "paint" && hint.paint) {
        get().setAttackPaint(hint.paint);
        pushLog("sys", `подсказка: рамка ${hint.paint.f1Mhz.toFixed(2)}…${hint.paint.f2Mhz.toFixed(2)} МГц — взял оператор`);
      }
      if (kind === "wave" && hint.wave) {
        get().armTxWave(hint.wave);
        pushLog("sys", `подсказка: волна «${hint.wave}» — взял оператор, в эфир не уходит до ПЕРЕДАТЬ`);
      }
      if (kind === "hold" && hint.holdMs != null) {
        get().setAttackHoldMs(hint.holdMs);
        pushLog("sys", `подсказка: выдержка ${hint.holdMs} мс — взял оператор`);
      }
      refreshAttackBrain();
    },
    setAutoDispatch: (d) => set({ autoDispatch: d }),
    setScanWindowMhz: (v) => set({ scanWindowMhz: v }),
    setScanDwellMs: (v) => set({ scanDwellMs: v }),
    clearLog: () => set({ log: [] }),
    startLabBaseline: () => {
      const now = Date.now();
      set({ labPsd: beginLabBaseline(get().labPsd, now, get().labPsd.baselineTargetSec) });
      pushLog("sys", `полка спектра: сбор ${get().labPsd.baselineTargetSec} с (poc 120). Гейт FPGA не ждёт.`);
    },
    freezeLabBaseline: () => {
      set({ labPsd: freezeLabPsd(get().labPsd) });
      pushLog("sys", "полка спектра: заморожена оператором (не 120 с автоматически)");
    },
    resetLabHolds: () => {
      set({ labPsd: resetLabPsdHolds(get().labPsd) });
      pushLog("sys", "peak/min/persistence сброшены");
    },
    clearLabPsd: () => {
      const target = get().labPsd.baselineTargetSec;
      gLabSpur.recalibrate();
      set({ labPsd: resetLabPsd(target), labCoverage: null, labSpurReady: false });
      pushLog("sys", "композит коридора очищен");
    },
    setLabKnown: (v) => set({ labKnown: v, labKnownMhz: parseMhzList(v) }),
    setLabIgnore: (v) => set({ labIgnore: v, labIgnoreMhz: parseMhzList(v) }),
    setLabMinDurationSec: (v) => {
      const n = Number.isFinite(v) && v >= 0 ? v : LAB_MIN_DURATION_SEC;
      set({ labMinDurationSec: n });
    },
    setLabMinWidthMhz: (v) => {
      const n = Number.isFinite(v) && v >= 0 ? v : LAB_MIN_WIDTH_MHZ;
      set({ labMinWidthMhz: n });
    },
    setLabShowPeak: (v) => set({ labShowPeak: v }),
    setLabShowMin: (v) => set({ labShowMin: v }),
    setLabShowBaseline: (v) => set({ labShowBaseline: v }),
    setLabSubtractBaseline: (v) => set({ labSubtractBaseline: v }),
    setLabShowPersistence: (v) => set({ labShowPersistence: v }),
    setLabShowRtsa: (v) => set({ labShowRtsa: v }),
    setLabShowAlloc: (v) => set({ labShowAlloc: v }),
    setLabSpurOn: (v) => {
      if (!v) {
        gLabSpur.recalibrate();
        set({ labSpurOn: false, labSpurReady: false });
        return;
      }
      gLabSpur.recalibrate();
      set({ labSpurOn: true, labSpurReady: false });
    },
    setLabIperfHost: (v) => set({ labIperfHost: v }),
    setLabIperfPort: (v) => set({ labIperfPort: v }),
    setLabIperfSec: (v) => set({ labIperfSec: v }),
    setLabIperfUdp: (v) => set({ labIperfUdp: v }),
    setLabIperfLoops: (v) => set({ labIperfLoops: v }),
    runLabIperf: async () => {
      if (get().labIperfBusy) return false;
      const host = get().labIperfHost.trim();
      const port = Number(get().labIperfPort);
      const sec = Number(get().labIperfSec);
      const loops = Math.max(1, Math.min(20, Math.floor(Number(get().labIperfLoops) || 1)));
      if (!host) {
        pushLog("sys", "iperf3: задайте адрес сервера стенда — цифры не выдумываем");
        return false;
      }
      if (!Number.isFinite(port) || port < 1 || port > 65535) {
        pushLog("sys", "iperf3: порт 1…65535");
        return false;
      }
      if (!Number.isFinite(sec) || sec < 1 || sec > 30) {
        pushLog("sys", "iperf3: время 1…30 с (allowlist CLI)");
        return false;
      }
      set({ labIperfBusy: true });
      let okN = 0;
      let badN = 0;
      let lastRaw = "";
      try {
        for (let i = 0; i < loops; i++) {
          const r = await hostIperf3({
            host,
            port,
            timeSec: sec,
            udp: get().labIperfUdp,
          });
          if (!r.ok) {
            pushLog("sys", r.reason);
            return false;
          }
          lastRaw = r.json;
          const parsed = parseIperfJson(r.json);
          if (!parsed.ok) {
            pushLog("sys", parsed.reason);
            return false;
          }
          set({ labIperf: parsed.record });
          if (parsed.record.lostPercent === 0) okN += 1;
          else badN += 1;
          pushLog(
            "sys",
            `iperf3 ${i + 1}/${loops}: lost_percent=${parsed.record.lostPercent} · bytes=${parsed.record.bytes}`,
          );
        }
        if (okN + badN > 0) {
          const bper = recordBper(okN, badN);
          if (bper.ok) {
            set({ labBper: bper.record });
            pushLog("sys", `BPER из прогонов iperf3: ${badN}/${okN + badN} = ${bper.record.bper}`);
          }
        }
        return lastRaw.length > 0;
      } finally {
        set({ labIperfBusy: false });
      }
    },
    applyPlaylist: (data) => {
      const parsed = buildPlaylist(data);
      if (!parsed.ok) {
        pushLog("sys", parsed.reason);
        return false;
      }
      set({ labPlaylist: parsed.playlist, labPlaylistIdx: 0 });
      return get().applyPlaylistStep(0);
    },
    applyPlaylistJson: (raw) => {
      const parsed = parsePlaylistJson(raw);
      if (!parsed.ok) {
        pushLog("sys", parsed.reason);
        return false;
      }
      return get().applyPlaylist(parsed.playlist);
    },
    applyPlaylistStep: (index) => {
      const pl = get().labPlaylist;
      if (!pl || index < 0 || index >= pl.steps.length) {
        pushLog("sys", "playlist: нет такого шага");
        return false;
      }
      const patch = playlistStepPatch(pl.steps[index]);
      // parseBand — потолок ADF4351 4400 МГц. Плейлист xA4 до 6000 (пресет 5800).
      const f1 = parseFloat(patch.sdrF1);
      const f2 = parseFloat(patch.sdrF2);
      const xa4Band =
        Number.isFinite(f1) &&
        Number.isFinite(f2) &&
        f2 >= f1 &&
        f1 >= XA4_RX_MHZ[0] &&
        f2 <= XA4_RX_MHZ[1]
          ? { f1Mhz: f1, f2Mhz: f2 }
          : null;
      set({
        sdrF1: patch.sdrF1,
        sdrF2: patch.sdrF2,
        sdrBands: xa4Band ? [xa4Band] : get().sdrBands,
        fpgaAirBwMhz: patch.fpgaAirBwMhz,
        fpgaTurnDwellMs: patch.fpgaTurnDwellMs,
        scanWindowMhz: patch.scanWindowMhz,
        scanDwellMs: patch.scanDwellMs,
        signalFreqMhz: patch.signalFreqMhz,
        txWaveKind: patch.txWaveKind,
        txWaveParams: patch.txWaveKind ? get().txWaveParams : {},
        labPlaylistIdx: index,
      });
      pushLog("sys", patch.reason);
      if (get().scanRunning && !isFpgaAirPattern(get().scanPattern)) {
        get().stopScan();
        get().startScan();
        pushLog("sys", "playlist: хост-скан перезапущен на новый коридор (старый walker не пишет в чужую ось)");
      }
      return true;
    },
    setLabIperfJson: (raw) => {
      const parsed = parseIperfJson(raw);
      if (!parsed.ok) {
        pushLog("sys", parsed.reason);
        return false;
      }
      set({ labIperf: parsed.record });
      pushLog("sys", `iperf3: lost_percent=${parsed.record.lostPercent} · bytes=${parsed.record.bytes}`);
      return true;
    },
    setLabBper: (ok, bad) => {
      const parsed = recordBper(ok, bad);
      if (!parsed.ok) {
        pushLog("sys", parsed.reason);
        return false;
      }
      set({ labBper: parsed.record });
      pushLog("sys", `BPER: ${parsed.record.batchesBad}/${parsed.record.batchesOk + parsed.record.batchesBad} = ${parsed.record.bper}`);
      return true;
    },
    setLabJsr: (opts) => {
      const parsed = recordJsr(opts);
      if (!parsed.ok) {
        pushLog("sys", parsed.reason);
        return false;
      }
      set({ labJsr: parsed.record });
      pushLog("sys", `JSR: ${parsed.record.jsr} (${parsed.record.jsrDb.toFixed(2)} дБ) · Pj=${parsed.record.pJ} · Esig=${parsed.record.eSig}`);
      return true;
    },
    clearLabJournal: () => {
      gLabHost.reset();
      gLabFpga.reset();
      gLabSpur.recalibrate();
      set({
        labEvents: [],
        labIperf: null,
        labBper: null,
        labJsr: null,
        labPlaylist: null,
        labPlaylistIdx: 0,
        labCoverage: null,
        labSpurReady: false,
        labKnown: "",
        labIgnore: "",
        labKnownMhz: [],
        labIgnoreMhz: [],
        labPsd: emptyLabPsd(get().labPsd.baselineTargetSec),
      });
    },
    exportLabJournal: () => {
      const s = get();
      const { f1, f2 } = labCorridor(s);
      return buildLabJournal({
        f1,
        f2,
        baselineTargetSec: s.labPsd.baselineTargetSec,
        baselineFrozen: s.labPsd.baselineFrozen,
        coverage: s.labCoverage,
        events: s.labEvents,
        iperf: s.labIperf,
        bper: s.labBper,
        jsr: s.labJsr,
        playlist: s.labPlaylist,
        knownMhz: s.labKnownMhz,
        ignoreMhz: s.labIgnoreMhz,
      });
    },

    refreshPorts: async () => {
      const kind = get().transportKind;
      if (kind !== "tauri-serial" && kind !== "htool-sl22") return;
      try {
        const ports = await TauriSerialTransport.listPorts();
        set({ ports });
        if (ports.length > 0 && !get().selectedPort) {
          set({ selectedPort: ports[0].path });
        }
      } catch (e) {
        pushLog("sys", `не удалось получить список портов: ${String(e)}`);
      }
    },

    connect: async () => {
      const { transportKind, selectedPort, wsUrl } = get();
      await get().disconnect();

      switch (transportKind) {
        case "tauri-serial":
          if (!selectedPort) {
            pushLog("sys", "не выбран serial-порт");
            return;
          }
          gTransport = new TauriSerialTransport(selectedPort);
          break;
        case "htool-sl22":
          if (!selectedPort) {
            pushLog("sys", "не выбран serial-порт");
            return;
          }
          set({ corrMode: "SWEEP" });
          gTransport = new Sl22Transport(selectedPort);
          pushLog("sys", "HTOOL SL22: мост SCPI (без ESP32/ADF4351)");
          break;
        case "web-serial":
          gTransport = new WebSerialTransport();
          break;
        case "websocket":
          gTransport = new WebSocketTransport(wsUrl);
          break;
        case "mock":
          gTransport = new MockTransport();
          break;
      }

      gClient = new LegionClient(gTransport);
      gClient.onRawLine = (line) => {
        pushLog("rx", line);
        const lock = parseLockFrom(line);
        if (lock !== null) set({ lock });
      };
      gClient.onTelemetry = (t) => {
        const now = performance.now();
        if (now - telemLastMs < 66) return;
        telemLastMs = now;
        // Телеметрия НЕ включает флаг коридора: строка, ушедшая в буфер до
        // STOP, приходит после него и воскрешала «КОРИДОР TX» в UI (гонка).
        // Поднятие флага — через corridorStart (OK) и pollStatus (mode).
        if (get().corridorRunning) {
          set({ telemFreq: t.freq, telemLock: t.lock === 1 });
        }
      };
      gClient.onEngineEvent = (e) => {
        pushLog("sys", `событие движка: ${e.event}`);
        if (e.event === "GLIDE DONE") {
          // GLIDE — одноразовый: по завершении движок сам останавливается
          set({ corridorRunning: false, telemFreq: null });
        }
      };
      gClient.onStateChange = (st, detail) => {
        set({ transportState: st, transportDetail: detail });
        pushLog("sys", `транспорт: ${st}${detail ? ` (${detail})` : ""}`);
      };

      try {
        await gTransport.connect();
        // Рукопожатие
        const hello = await gClient.cmd("HELLO");
        pushLog("tx", "HELLO");
        if (hello.ok) {
          await get().pollStatus();
          const bands = get().allowBands;
          for (const b of bands) {
            pushLog("tx", `ALLOW ADD ${b.f1Mhz} ${b.f2Mhz}`);
            await gClient.allowAdd(b.f1Mhz, b.f2Mhz);
          }
        }
      } catch (e) {
        pushLog("sys", `подключение не удалось: ${String(e)}`);
        set({ transportState: "error", transportDetail: String(e) });
      }
    },

    disconnect: async () => {
      // Отключение ESP32 не трогает режим SDR (скан / TX на Ethernet).
      if (get().corridorRunning && gClient) {
        await gClient.stop();
        set({ corridorRunning: false, telemFreq: null, telemLock: null });
      }
      if (gTransport) {
        try {
          await gTransport.disconnect();
        } catch {
          /* ignore */
        }
        gTransport = null;
        gClient = null;
      }
      set({
        transportState: "disconnected",
        lock: null,
        rfOn: false,
        corridorRunning: false,
        telemFreq: null,
        telemLock: null,
        status: null,
      });
    },

    send: async (cmd) => {
      if (!gClient) return;
      pushLog("tx", cmd);
      const r = await gClient.cmd(cmd);
      if (!r.ok) pushLog("sys", `command failed: ${r.statusLine}`);
    },

    setFrequency: async () => {
      const blocked = modeConflict("esp32", false, get().transmitArmed, get().fpgaArmed || get().fpgaStopPending);
      if (blocked) {
        pushLog("sys", blocked);
        return;
      }
      if (!gClient) return;
      const mhz = parseFloat(get().freqMhz);
      if (!Number.isFinite(mhz)) {
        pushLog("sys", "bad frequency input");
        return;
      }
      const cmd = `SET FREQ ${mhz.toFixed(6)}`;
      pushLog("tx", cmd);
      const r = await gClient.setFreq(mhz);
      const lock = parseLockFrom(r.statusLine);
      if (lock !== null) set({ lock });
      // Прошивка: ручная установка останавливает коридор (политика)
      if (r.ok) set({ corridorRunning: false, telemFreq: null });
    },

    setPower: async (dbm) => {
      const blocked = modeConflict("esp32", false, get().transmitArmed, get().fpgaArmed || get().fpgaStopPending);
      if (blocked) {
        pushLog("sys", blocked);
        return;
      }
      if (!gClient) return;
      pushLog("tx", `SET POWER ${dbm}`);
      const r = await gClient.setPower(dbm);
      if (r.ok) set({ powerDbm: dbm });
    },

    setAtt: async (db) => {
      const blocked = modeConflict("esp32", false, get().transmitArmed, get().fpgaArmed || get().fpgaStopPending);
      if (blocked) {
        pushLog("sys", blocked);
        return;
      }
      if (!gClient) return;
      pushLog("tx", `SET ATT ${db.toFixed(2)}`);
      const r = await gClient.setAtt(db);
      if (r.ok) set({ attDb: db });
    },

    setRf: async (on) => {
      const blocked = modeConflict("esp32", false, get().transmitArmed, get().fpgaArmed || (on && get().fpgaStopPending));
      if (blocked) {
        pushLog("sys", blocked);
        return;
      }
      if (!gClient) return;
      pushLog("tx", on ? "RF ON" : "RF OFF");
      const r = await gClient.rf(on);
      if (r.ok) set({ rfOn: on });
    },

    pollStatus: async () => {
      if (!gClient) return;
      const r = await gClient.status();
      if (r.ok && r.statusLine.startsWith("{")) {
        try {
          const st = JSON.parse(r.statusLine) as StatusJson;
          // mode синхронизирует флаг коридора (в т.ч. NVS-рестарт на железе и
          // авто-стоп GLIDE) — вместо воскрешения по строчной телеметрии.
          set({
            status: st,
            lock: st.lock === 1,
            rfOn: st.rf === 1,
            corridorRunning: st.mode !== "MANUAL",
            telemFreq: st.mode !== "MANUAL" ? get().telemFreq : null,
          });
        } catch {
          /* повреждённый JSON — игнор */
        }
      }
    },

    runSelftest: async () => {
      if (!gClient) return;
      pushLog("tx", "SELFTEST");
      const r = await gClient.selftest();
      if (r.ok && r.statusLine.startsWith("{")) {
        try {
          const j = JSON.parse(r.statusLine);
          pushLog("sys", `selftest pass=${j?.selftest?.pass ?? "?"}`);
        } catch {
          /* ignore */
        }
      }
    },

    corridorStart: async () => {
      if (!gClient) return;
      const blocked = modeConflict("esp32", false, get().transmitArmed, get().fpgaArmed || get().fpgaStopPending);
      if (blocked) {
        pushLog("sys", blocked);
        return;
      }
      const s = get();
      const mode = s.transportKind === "htool-sl22" ? "SWEEP" : s.corrMode;
      const f1 = parseFloat(s.corrF1);
      const f2 = parseFloat(s.corrF2);
      const step = parseInt(s.corrStepKhz, 10);
      const dwell = parseInt(s.corrDwellMs, 10);
      const seed = parseInt(s.corrSeed, 10) || 1;
      if (![f1, f2, step, dwell].every(Number.isFinite)) {
        pushLog("sys", "bad corridor params");
        return;
      }
      if (s.allowBands.length > 0 && !s.allowBands.some((b) => f1 >= b.f1Mhz && f2 <= b.f2Mhz)) {
        pushLog("sys", "коридор TX вне allowlist ESP32 — полоса на вкладке УСИЛИТЕЛЬ ESP32, не скан SDR");
        return;
      }
      const cmd =
        mode === "SWEEP"
          ? `SWEEP START ${f1} ${f2} STEP ${step} DWELL ${dwell}`
          : mode === "CHIRP"
            ? `CHIRP START ${f1} ${f2} STEP ${step} DWELL ${dwell}`
            : `HOP START ${f1} ${f2} RATE ${dwell} SEED ${seed} STEP ${step}`;
      pushLog("tx", cmd);
      const r =
        mode === "SWEEP"
          ? await gClient.sweepStart(f1, f2, step, dwell)
          : mode === "CHIRP"
            ? await gClient.chirpStart(f1, f2, step, dwell)  // CHIRP: шаг в Гц
            : await gClient.hopStart(f1, f2, dwell, seed, step);
      if (r.ok) {
        set({ corridorRunning: true });
      } else {
        pushLog("sys", `corridor rejected: ${r.statusLine}`);
      }
    },

    corridorStop: async () => {
      if (!gClient) return;
      pushLog("tx", "STOP");
      const r = await gClient.stop();
      if (r.ok) {
        set({ corridorRunning: false, telemFreq: null, telemLock: null });
      }
    },

    addAllowBand: async () => {
      // Режим ESP32: ALLOW на UART. Скан SDR вызывает addSdrBand, не это.
      const s = get();
      const band = parseBand(s.allowF1, s.allowF2);
      if (!band) {
        pushLog("sys", "allowlist: неверная полоса (34.375–4400 МГц, f1≤f2)");
        return;
      }
      if (s.allowBands.some((b) => b.f1Mhz === band.f1Mhz && b.f2Mhz === band.f2Mhz)) {
        pushLog("sys", "allowlist: такая полоса уже есть — дубль не добавляем");
        return;
      }
      if (s.allowBands.length >= 8) {
        pushLog("sys", "allowlist: максимум 8 полос");
        return;
      }
      set({ allowBands: [...s.allowBands, band] });
      if (gClient) {
        const cmd = `ALLOW ADD ${band.f1Mhz} ${band.f2Mhz}`;
        pushLog("tx", cmd);
        await gClient.allowAdd(band.f1Mhz, band.f2Mhz);
      }
    },

    clearAllowBands: async () => {
      set({ allowBands: [] });
      if (gClient) {
        pushLog("tx", "ALLOW CLEAR");
        await gClient.allowClear();
      }
    },

    setLoad: async (ok) => {
      // Режим ESP32: LOAD на UART. Скан SDR сюда не вызывает.
      set({ loadOk: ok, paOn: ok ? get().paOn : false });
      if (!gClient) return;
      pushLog("tx", ok ? "LOAD OK" : "LOAD FAULT");
      const r = ok ? await gClient.loadOk() : await gClient.loadFault();
      if (r.ok && !ok) set({ rfOn: false, paOn: false });
    },

    addSdrBand: () => {
      const s = get();
      const band = parseSdrRxBand(s.sdrF1, s.sdrF2, s.sdrId);
      if (!band) {
        const rx = catalogById(s.sdrId)?.rxMhz;
        const lo = rx?.[0] ?? 34.375;
        const hi = rx?.[1] ?? 4400;
        pushLog("sys", `SDR allowlist: неверная полоса (${lo}–${hi} МГц, f1≤f2)`);
        return;
      }
      if (s.sdrBands.some((b) => b.f1Mhz === band.f1Mhz && b.f2Mhz === band.f2Mhz)) {
        pushLog("sys", "SDR allowlist: такая полоса уже есть — дубль не добавляем");
        return;
      }
      if (s.sdrBands.length >= 8) {
        pushLog("sys", "SDR allowlist: максимум 8 полос");
        return;
      }
      set({ sdrBands: [...s.sdrBands, band] });
      pushLog("sys", `SDR полоса ${band.f1Mhz}…${band.f2Mhz} (хост, не UART ESP32)`);
    },

    clearSdrBands: () => {
      set({ sdrBands: [] });
      pushLog("sys", "SDR allowlist очищен (ESP32 не тронут)");
    },

    setSdrLoad: (ok) => {
      set({ sdrLoadOk: ok });
      if (!ok) {
        // Интерлок как на ESP32 (LOAD FAULT гасит RF/PA): снятие нагрузки
        // гасит ЖИВОЙ TX. Раньше флаг менялся, а тон оставался в эфире
        // (open-loop вообще замирал на последней частоте навсегда).
        // reset(), не dropHold(): in-flight handoff этой эпохи по gen-guard'у
        // не сделает release — inflight обязан сбросить бампер, иначе все
        // будущие handoff застрянут на «предыдущий SDR TX ещё идёт».
        gTxGen += 1;
        gGate.reset();
        clearAttackHoldTimer();
        gAttackLastTxEnd = Date.now();
        gAttackTracker.markHeld(null);
        if (gLive) void hostTxOff();
        else gSdr.txOff();
        // stopFpgaAir = disarm + USB хосту: после интерлока система в чистом
        // состоянии хоста (fpgaDisarm один оставлял бы USB у агента).
        if (get().fpgaArmed || get().fpgaStopPending) void get().stopFpgaAir();
        set({
          lastForwardMhz: null,
          lastForwardPowerDbm: null,
          lastSdrTxUs: null,
          sdrHoldSince: null,
          attackTxUntil: null,
          attackTracks: gAttackTracker.snapshot(),
          lastCueReason: "нагрузка снята — SDR TX погашен",
        });
      }
      pushLog(
        "sys",
        ok ? "SDR: нагрузка 50 Ом на выходе усилителя SDR" : "SDR: нагрузка снята — TX погашен",
      );
    },

    applyPaCurrent: async () => {
      const blocked = modeConflict("esp32", false, get().transmitArmed, get().fpgaArmed || get().fpgaStopPending);
      if (blocked) {
        pushLog("sys", blocked);
        return;
      }
      const ma = get().paMa;
      if (!gClient) return;
      pushLog("tx", `PA SET I ${Math.round(ma)}`);
      const r = await gClient.paSetI(ma);
      if (!r.ok) pushLog("sys", r.statusLine);
    },

    setPaEnabled: async (on) => {
      if (on) {
        const blocked = modeConflict("esp32", false, get().transmitArmed, get().fpgaArmed || get().fpgaStopPending);
        if (blocked) {
          pushLog("sys", blocked);
          return;
        }
      }
      if (!gClient) return;
      if (on && !get().loadOk) {
        pushLog("sys", "PA ON запрещён: нет нагрузки 50 Ом");
        return;
      }
      pushLog("tx", on ? "PA ON" : "PA OFF");
      const r = on ? await gClient.paOn() : await gClient.paOff();
      if (r.ok) set({ paOn: on });
      else pushLog("sys", r.statusLine);
    },

    cueTo: async (mhz) => {
      const blocked = modeConflict("esp32", false, get().transmitArmed, get().fpgaArmed || get().fpgaStopPending);
      if (blocked) {
        pushLog("sys", blocked);
        return;
      }
      const s = get();
      if (!cueFreqAllowed(mhz, s.allowBands)) {
        set({ lastCueReason: "частота вне allowlist" });
        pushLog("sys", "CUE отклонён: вне allowlist");
        return;
      }
      set({ freqMhz: mhz.toFixed(6), lastCueReason: `наведение ${mhz.toFixed(6)} МГц` });
      if (!gClient) {
        pushLog("sys", "CUE: актуатор не подключён — частота только в UI");
        return;
      }
      const cmd = `CUE ${mhz.toFixed(6)}`;
      pushLog("tx", cmd);
      const r = await gClient.cue(mhz);
      if (r.ok) set({ corridorRunning: false, telemFreq: null });
      else {
        pushLog("sys", r.statusLine);
        set({ lastCueReason: r.statusLine });
      }
    },

    forwardTo: async (mhz) => {
      await runHandoff(mhz);
    },

    setSignalKind: (k) => set({ signalKind: k, signalParams: defaultParams(k) }),

    armTxWave: (kind) => {
      if (get().signalTxActive) {
        pushLog("sys", "ВОЛНА: идёт TX зашитого сигнала — сначала СТОП");
        return;
      }
      const params = defaultParams(kind);
      set({
        signalKind: kind,
        signalParams: params,
        txWaveKind: kind,
        txWaveParams: params,
      });
      pushLog("sys", `TX-волна выбрана: ${kind} (в эфир не уходит до ПЕРЕДАТЬ)`);
    },

    setSignalParam: (key, v) =>
      set((s) => ({ signalParams: { ...s.signalParams, [key]: v } })),

    setSignalFreqMhz: (v) => set({ signalFreqMhz: v }),

    signalFlash: async () => {
      const s = get();
      if (gSignalBusy) return;
      if (s.flashBusy) {
        pushLog("sys", "ЗАШИТЬ: идёт прошивка — сначала дождитесь");
        return;
      }
      const blocked = modeConflict("sdr", s.corridorRunning, false);
      if (blocked) {
        pushLog("sys", blocked);
        return;
      }
      if (s.rfOn || s.paOn) {
        pushLog("sys", "ЗАШИТЬ: сначала RF OFF / PA OFF на ESP32 — тракты не вместе");
        return;
      }
      if (s.fpgaArmed || s.fpgaStopPending) {
        pushLog("sys", "ЗАШИТЬ: FPGA ARM занял USB — сначала ОСТАНОВИТЬ FPGA");
        return;
      }
      if (s.scanRunning) {
        pushLog("sys", "ЗАШИТЬ: сканер работает — сначала СТОП на вкладке СКАН + TX SDR");
        return;
      }
      if (s.transmitArmed) {
        pushLog("sys", "ЗАШИТЬ: TX уже активен — сначала СТОП ПЕРЕДАЧУ");
        return;
      }
      if (!s.sdrLoadOk) {
        pushLog("sys", "ЗАШИТЬ: подтвердите нагрузку 50 Ом на выходе усилителя SDR");
        return;
      }
      if (!ensureSdrBand()) return;
      const mhz = parseFloat(s.signalFreqMhz);
      if (!Number.isFinite(mhz)) {
        pushLog("sys", "ЗАШИТЬ: неверная частота");
        return;
      }
      if (!hzInAllowlist(mhz, get().sdrBands)) {
        pushLog("sys", `ЗАШИТЬ: ${mhz.toFixed(3)} МГц вне полосы SDR allowlist`);
        return;
      }
      if (!s.sdrOpened) {
        gSignalBusy = true;
        try {
          await get().openSdr();
        } finally {
          gSignalBusy = false;
        }
        if (!get().sdrOpened) return;
      }
      const canTx = gLive ? catalogCaps(get().sdrId).canTx : gSdr.canTx();
      if (!canTx) {
        pushLog("sys", "ЗАШИТЬ: у этого SDR нет TX — усилитель подключать некуда");
        return;
      }
      const kind = get().signalKind;
      gSignalBusy = true;
      let tx;
      try {
        tx = gLive
          ? await hostTxWave(mhz, kind, get().signalParams)
          : gSdr.txWave(mhz, kind);
      } finally {
        gSignalBusy = false;
      }
      pushLog("sys", tx.reason);
      if (!tx.ok) return;
      set({
        transmitArmed: true,
        signalTxActive: true,
        // Волна зашита: теперь её используют и Атака/приоритет, и open-loop TX.
        txWaveKind: kind,
        txWaveParams: { ...get().signalParams },
        lastForwardMhz: mhz,
        lastSdrTxUs: tx.latencyUs || null,
        sdrHoldSince: Date.now(),
        lastCueReason: `сигнал ${kind} → SDR ${mhz.toFixed(3)} МГц · нагрузка 50Ω · зашит для всех TX-режимов`,
      });
    },

    disarmTxWave: () => {
      if (get().transmitArmed) {
        pushLog("sys", "СБРОС НА CW: TX активен — сначала СТОП");
        return;
      }
      if (get().txWaveKind === null) {
        pushLog("sys", "СБРОС НА CW: волна не зашита (уже CW тон)");
        return;
      }
      set({ txWaveKind: null, txWaveParams: {} });
      pushLog("sys", "TX-контент снят: Атака/приоритет и open-loop снова на CW тоне");
    },

    setFpgaMode: (m) => set({ fpgaMode: m }),

    setFpgaToken: (v) => {
      if (v === get().fpgaToken) return;
      if (fpgaConnectionLocked()) {
        pushLog("sys", "Смена токена заблокирована до подтверждённой остановки FPGA");
        return;
      }
      stopFpgaObserve();
      set({ fpgaToken: v, fpgaStatus: null });
    },

    setFpgaDetThr: (v) => set({ fpgaDetThr: Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0 }),

    setFpgaDetShift: (v) => set({ fpgaDetShift: clampDetShift(v) }),

    setFpgaTurnDwellMs: (v) => set({ fpgaTurnDwellMs: v }),
    setFpgaSurveyPeriodMs: (v) => set({ fpgaSurveyPeriodMs: v }),
    setFpgaAirBwMhz: (v) => set({ fpgaAirBwMhz: v }),
    setFpgaAirDwellMs: (v) => set({ fpgaAirDwellMs: v }),
    setFpgaAirWalkPattern: (p) => set({ fpgaAirWalkPattern: p === "hop" ? "hop" : "sweep" }),
    setFpgaSoloWindowMhz: (v) => set({ fpgaSoloWindowMhz: v }),
    setFpgaSoloDwellMs: (v) => set({ fpgaSoloDwellMs: v }),
    setFpgaSoloPattern: (p) => set({ fpgaSoloPattern: p === "hop" ? "hop" : "sweep" }),

    fpgaArm: async () => {
      const s = get();
      if (s.fpgaBusy || s.fpgaStopPending) return;
      if (s.fpgaArmed) {
        pushLog("sys", "FPGA ARM: уже играет — сначала ОСТАНОВИТЬ FPGA");
        return;
      }
      if (s.rfOn || s.paOn) {
        pushLog("sys", "FPGA ARM: сначала RF OFF / PA OFF на ESP32 — тракты не вместе");
        return;
      }
      if (!s.sdrLoadOk) {
        pushLog("sys", "FPGA ARM: подтвердите нагрузку 50 Ом на выходе усилителя SDR");
        return;
      }
      const board = fpgaBoardPlan(s.sdrId);
      if (!board.ok) {
        pushLog("sys", board.reason);
        return;
      }
      const blocked = modeConflict("sdr", s.corridorRunning, false);
      if (blocked) {
        pushLog("sys", blocked);
        return;
      }
      if (get().fpgaMode === "lb_gated") {
        const airPlan = planFpgaAir({
          sdrId: get().sdrId,
          analogBwMhz: catalogCaps(get().sdrId).analogBwMhz,
          bands: bandsForFpgaAir(),
          loadOk: get().sdrLoadOk,
          detThr: get().fpgaDetThr,
          detShift: get().fpgaDetShift,
          bwMhz: parseFloat(get().fpgaAirBwMhz),
        });
        if (!airPlan.ok) {
          pushLog("sys", airPlan.reason);
          return;
        }
      }
      /* busy до первого await: иначе кино-старт (startFpgaPath смотрит
       * fpgaBusy) пошёл бы параллельно с этим ARM. Поколение — отзыв
       * кино-Стопом / DISARM в полёте. */
      gFpgaArmGen += 1;
      const armGen = gFpgaArmGen;
      const armRevoked = (): boolean => gFpgaArmGen !== armGen;
      set({ fpgaBusy: true, fpgaStatus: null });
      try {
        get().stopScan();
        if (get().transmitArmed || get().signalTxActive) await get().stopTransmit();
        if (armRevoked()) {
          pushLog("sys", "FPGA ARM: отменён оператором в полёте");
          return;
        }
        if (!ensureSdrBand()) return;
        const bands = get().sdrBands;
        const f1 = bands.length ? Math.min(...bands.map((b) => b.f1Mhz)) : parseFloat(get().sdrF1);
        const f2 = bands.length ? Math.max(...bands.map((b) => b.f2Mhz)) : parseFloat(get().sdrF2);
        const mid = (f1 + f2) / 2;
        const analog = catalogCaps(get().sdrId).analogBwMhz;
        const span = Math.max(f2 - f1, 0);
        const mode = get().fpgaMode;
        const air = mode === "lb_gated" || mode === "lb_always";
        const gw = (cmd: Record<string, unknown>) =>
          hostFpga({ ...cmd, token: get().fpgaToken }, get().sdrGateway);
        const ping = await gw({ op: "ping" });
        if (armRevoked()) {
          pushLog("sys", "FPGA ARM: отменён оператором в полёте");
          return;
        }
        if (ping.legion !== undefined) set({ fpgaLegion: ping.legion ?? null });
        const pingNo = fpgaGatewayRefused(ping);
        if (pingNo) {
          pushLog("sys", pingNo);
          return;
        }
        const noLegionArm = fpgaLegionMissing(ping);
        if (noLegionArm) {
          pushLog("sys", noLegionArm);
          return;
        }
        if (mode === "player") {
          const st = await gw({ op: "status" });
          if (armRevoked()) {
            pushLog("sys", "FPGA ARM: отменён оператором в полёте");
            return;
          }
          const noWave = fpgaPlayerReady(st);
          if (noWave) {
            pushLog("sys", noWave);
            return;
          }
        }
        const tract = air
          ? airTractParams(parseFloat(get().fpgaAirBwMhz), analog, get().fpgaDetShift)
          : null;
        const pk = await parkFpgaLo({
          midMhz: mid,
          analogMhz: analog,
          spanMhz: span,
          rx: air,
          fsHz: tract ? tract.fsHz : FPGA_FS_HZ,
          bwMhz: tract?.bwMhz,
          gw,
        });
        if (armRevoked()) {
          await releaseCancelledFpgaUsb(s);
          pushLog("sys", "FPGA ARM: отменён оператором в полёте");
          return;
        }
        if (!pk.ok) {
          pushLog("sys", "FPGA ARM: без park LO не включаем — иначе IQ уйдёт на чужую частоту");
          return;
        }
        const cmd = fpgaArmCmd(mode, {
          detThr: get().fpgaDetThr,
          detShift: get().fpgaDetShift,
          token: get().fpgaToken,
          ncoFtw: ncoFtwFromFrac(Number(get().signalParams.fj)),
          freqMhz: mid,
          ...(tract ? { fsHz: tract.fsHz, bwMhz: tract.bwMhz } : {}),
        });
        const r = await gw(cmd);
        pushLog("sys", `FPGA ARM (${mode}): ${r.reason ?? (r.ok ? "ок" : "отказ")}`);
        if (armRevoked()) {
          // После отправки ARM потерянный ответ не доказывает отказ железа.
          await get().fpgaDisarm();
          pushLog("sys", "FPGA ARM: отменён оператором в полёте");
          return;
        }
        if (!r.ok) {
          await get().fpgaDisarm();
          return;
        }
        if (r.ok) {
          const cue =
            mode === "lb_gated"
              ? planFpgaAir({
                  sdrId: get().sdrId,
                  analogBwMhz: analog,
                  bands: bandsForFpgaAir(),
                  loadOk: get().sdrLoadOk,
                  detThr: get().fpgaDetThr,
                  detShift: get().fpgaDetShift,
                  bwMhz: parseFloat(get().fpgaAirBwMhz),
                }).reason
              : air
                ? `FPGA · ${fpgaRunModeRu(mode)} · антенна→усилитель · ${mid.toFixed(3)} МГц · ${formatDetWindow(pk.fsHz)}`
                : `FPGA · ${fpgaRunModeRu(mode)} · ${mid.toFixed(3)} МГц`;
          set({
            fpgaArmed: true,
            fpgaAutoCycle: false,
            fpgaPath: air ? "air" : "solo",
            lastForwardMhz: mid,
            lastCueReason: cue,
          });
          beginFpgaKick();
        }
      } finally {
        set({ fpgaBusy: false });
      }
    },

    startFpgaPath: async (path) => {
      const s0 = get();
      if (s0.fpgaBusy || s0.fpgaStopPending) return false;
      // Как у ручного fpgaArm: поверх живого ARM кино-старт не идёт —
      // иначе park/ARM кино перекрыл бы тракт под током.
      if (s0.fpgaArmed) {
        pushLog("sys", "FPGA: уже ARM — сначала ОСТАНОВИТЬ FPGA");
        return false;
      }
      stopSoloWalk();
      stopAirWalk();
      let soloGen = 0;
      let airGen = 0;
      if (path === "solo") {
        gFpgaSoloGen += 1;
        soloGen = gFpgaSoloGen;
      }
      const soloRevoked = (): boolean => path === "solo" && gFpgaSoloGen !== soloGen;
      const airRevoked = (): boolean => path === "air" && airGen !== 0 && gFpgaAirGen !== airGen;
      if (s0.rfOn || s0.paOn) {
        pushLog("sys", "FPGA: сначала RF OFF / PA OFF на ESP32 — тракты не вместе");
        return false;
      }
      const blocked = modeConflict("sdr", s0.corridorRunning, false);
      if (blocked) {
        pushLog("sys", blocked);
        return false;
      }
      if (!s0.sdrLoadOk) {
        pushLog("sys", "FPGA: подтвердите нагрузку 50 Ом на выходе усилителя");
        return false;
      }
      const board = fpgaBoardPlan(s0.sdrId);
      if (!board.ok) {
        pushLog("sys", board.reason);
        return false;
      }
      // Solo: любой конечный F1…F2. parseSdrRxBand — RX каталога (xA4 70–6000).
      // parseBand — только синтезатор ESP32 34.375–4400,
      // его сюда не мешаем. Эфир+FPGA по-прежнему через allowlist.
      if (path === "air" && !ensureSdrBand()) return false;
      /* Поколение эфира — только после валидации. Бамп до parseBand/нагрузки
       * срывал отложенный startScan FPGA+сканер (fpgaReturnToScan сверяет
       * gFpgaAirGen), хотя cinema-эфир даже не дошёл до ping. */
      if (path === "air") {
        gFpgaAirGen += 1;
        airGen = gFpgaAirGen;
      }

      // Блокировка охватывает всю подготовку, включая первый ping.
      // Иначе поздний ответ продолжит запуск уже после смены подключения.
      let usbTouched = false;
      let usbOut = false;
      set({ fpgaBusy: true, fpgaStatus: null });
      try {
        get().stopScan();
        if (get().transmitArmed || get().signalTxActive) await get().stopTransmit();
        if (soloRevoked()) {
          pushLog("sys", "FPGA solo: отменён оператором в полёте");
          return false;
        }
        if (airRevoked()) {
          pushLog("sys", "FPGA эфир: отменён оператором в полёте");
          return false;
        }

        const bands = get().sdrBands;
        const f1 =
          path === "solo"
            ? parseFloat(get().sdrF1)
            : bands.length
              ? Math.min(...bands.map((b) => b.f1Mhz))
              : parseFloat(get().sdrF1);
        const f2 =
          path === "solo"
            ? parseFloat(get().sdrF2)
            : bands.length
              ? Math.max(...bands.map((b) => b.f2Mhz))
              : parseFloat(get().sdrF2);
        const mid = (f1 + f2) / 2;
        const analog = catalogCaps(get().sdrId).analogBwMhz;
        const span = Math.max(f2 - f1, 0);
        // Предупреждения «чип видит центр, не обход» больше нет: с air-обходом
        // коридор шире канала либо ходится по стоянкам (micro), либо честно
        // отказывает (x40, airHopBlockedReason) — оба текста в air-ветке.

        const gw = (cmd: Record<string, unknown>) => {
          if (cmd.op === "usb") usbTouched = true;
          return hostFpga({ ...cmd, token: get().fpgaToken }, get().sdrGateway);
        };
        const abortSoloIfRevoked = async (armAttempted = false): Promise<boolean> => {
          if (!soloRevoked()) return false;
          pushLog("sys", "FPGA solo: отменён оператором в полёте");
          stopSoloWalk();
          // Kick и observe живут и умирают вместе (beginFpgaKick заводит оба) —
          // иначе осиротевший опрос статуса тикал бы до следующей сессии.
          stopFpgaKick();
          stopFpgaObserve();
          if (armAttempted || get().fpgaArmed) {
            await get().fpgaDisarm();
            usbTouched = false; // DISARM-путь сам завершает или повторяет release.
            usbOut = false;
            if (get().fpgaStopPending) return true;
          }
          if (usbOut) {
            await releaseSoapyForFpga();
            usbOut = false;
          }
          if (usbTouched) {
            await releaseCancelledFpgaUsb(s0);
            usbTouched = false;
          }
          set({ fpgaPath: null });
          return true;
        };
        const abortAirIfRevoked = async (armAttempted = false): Promise<boolean> => {
          if (!airRevoked()) return false;
          pushLog("sys", "FPGA эфир: отменён оператором в полёте");
          // Kick и observe неразрывны (см. abortSoloIfRevoked).
          stopFpgaKick();
          stopFpgaObserve();
          stopAirWalk();
          if (armAttempted || get().fpgaArmed) {
            await get().fpgaDisarm();
            usbTouched = false;
            if (get().fpgaStopPending) return true;
          }
          if (usbTouched) {
            await releaseCancelledFpgaUsb(s0);
            usbTouched = false;
          }
          set({ fpgaPath: null });
          return true;
        };

        const ping = await gw({ op: "ping" });
        if (await abortSoloIfRevoked()) return false;
        if (await abortAirIfRevoked()) return false;
        if (ping.legion !== undefined) set({ fpgaLegion: ping.legion ?? null });
        const pingNo = fpgaGatewayRefused(ping);
        if (pingNo) {
          pushLog("sys", pingNo);
          return false;
        }
        const noLegionPath = fpgaLegionMissing(ping);
        if (noLegionPath) {
          pushLog("sys", noLegionPath);
          return false;
        }

        set({ fpgaPath: path });
        if (path === "air") {
          set({ fpgaMode: "lb_gated" });
          const tract = airTractParams(parseFloat(get().fpgaAirBwMhz), analog, get().fpgaDetShift);
          const airPlan = planFpgaAir({
            sdrId: get().sdrId,
            analogBwMhz: analog,
            bands: bandsForFpgaAir(),
            loadOk: get().sdrLoadOk,
            detThr: get().fpgaDetThr,
            detShift: get().fpgaDetShift,
            bwMhz: parseFloat(get().fpgaAirBwMhz),
          });
          if (!airPlan.ok) {
            pushLog("sys", airPlan.reason);
            set({ fpgaPath: null });
            return false;
          }
          // Сетка стоянок: коридор ÷ канал. Одна стоянка — прежний путь
          // (парк в центр, ручной порог); обход — калибровочная таблица.
          const walk = planFpgaSoloWalk({
            f1Mhz: f1,
            f2Mhz: f2,
            windowMhz: tract.bwMhz,
            analogMaxMhz: analog,
            dwellMs: parseFloat(get().fpgaAirDwellMs),
            pattern: get().fpgaAirWalkPattern,
            wave: get().signalKind,
          });
          if (!walk.ok) {
            pushLog("sys", walk.reason);
            set({ fpgaPath: null });
            return false;
          }
          const hopNo = airHopBlockedReason(get().sdrId, walk.hop);
          if (hopNo) {
            pushLog("sys", hopNo);
            set({ fpgaPath: null });
            return false;
          }
          const walker = makeSoloWalker(walk);
          const first = walker.next().centerMhz;
          // hop: первая стоянка — СЛУЧАЙНАЯ из сетки, не centers[0] (SoloWalker
          // hop берёт centres[floor(rng·len)]). Порог ARM — по её индексу,
          // иначе на стартовой частоте до первого шага стоит чужой порог.
          const firstIdx = Math.max(0, walk.centers.indexOf(first));

          if (!walk.hop) {
            const pk = await parkFpgaLo({
              midMhz: mid,
              analogMhz: analog,
              spanMhz: span,
              rx: true,
              fsHz: tract.fsHz,
              bwMhz: tract.bwMhz,
              gw,
            });
            if (!pk.ok) {
              set({ fpgaPath: null });
              return false;
            }
            if (await abortAirIfRevoked()) return false;
            const r = await gw({
              op: "arm",
              mode: "lb_gated",
              wd: true,
              det_thr: get().fpgaDetThr,
              det_shift: tract.detShift,
              freq_mhz: mid,
              fs_hz: tract.fsHz,
              bw_mhz: tract.bwMhz,
            });
            pushLog("sys", `FPGA ARM (ретрансляция): ${r.reason ?? (r.ok ? "ок" : "отказ")}`);
            if (await abortAirIfRevoked(true)) return false;
            if (!r.ok) {
              await get().fpgaDisarm();
              usbTouched = false;
              set({ fpgaPath: null });
              return false;
            }
            set({
              fpgaArmed: true,
              fpgaAutoCycle: false,
              lastForwardMhz: mid,
              lastSdrTxUs: null,
              lastCueReason: `${airPlan.reason} · ${mid.toFixed(3)} МГц · ${formatDetWindow(pk.fsHz)}`,
            });
            beginFpgaKick();
            if (await abortAirIfRevoked()) return false;
            return true;
          }

          // Обход с ретрансляцией: калибровочный проход ДО ARM, пока USB у
          // хоста. На каждой стоянке полка → det_thr (медиана нижних 60% × K);
          // на шаге обхода порог едет внутри tune — без лишнего round-trip.
          // Цена — разовая: ~десятки мс на стоянку (park+settle+capture),
          // логируется; в цикле обхода калибровки нет.
          if (get().sdrEmulation || !hostSdrAvailable()) {
            pushLog("sys", "FPGA эфир-обход: нужен Soapy на шлюзе — калибровка полок невозможна, ARM нельзя");
            set({ fpgaPath: null });
            return false;
          }
          const t0 = Date.now();
          // Прогресс в полёте: при тысячах стоянок проход — минуты; оператор
          // видит оценку заранее, отмена — СТОП (airRevoked на каждой стоянке).
          pushLog(
            "sys",
            `FPGA эфир-обход: калибровочный проход ${walk.centers.length} стоянок ` +
              "(~0.1–0.3 с/стоянка по LAN) — отмена кнопкой СТОП",
          );
          const medians: (number | null)[] = [];
          let gainDb: number | undefined;
          let calibWhy = "";
          const rel = await gw({ op: "usb", action: "release" });
          if (!rel.ok) calibWhy = `FPGA USB release: ${rel.reason ?? "отказ"}`;
          try {
            if (!calibWhy) {
              await get().openSdr({ requireHw: requireHwForSdr(get().sdrId) || undefined });
              if (!gLive) calibWhy = "FPGA эфир-обход: SDR не открылся — калибровка невозможна";
            }
            for (let i = 0; i < walk.centers.length && !calibWhy; i++) {
              if (airRevoked()) {
                calibWhy = "FPGA эфир: отменён оператором в полёте";
                break;
              }
              const c = walk.centers[i];
              const pkc = await hostPark(c, tract.bwMhz, tract.fsHz, true, false);
              if (!pkc.ok || pkc.fake) {
                medians.push(null);
                continue;
              }
              // MGC пиннится первым park'ом и держится между перестройками —
              // все полки и ARM на одном усилении (gain_db уходит в ARM).
              if (pkc.rxGainDb !== undefined && Number.isFinite(pkc.rxGainDb)) gainDb = pkc.rxGainDb;
              const cap = await hostDetCapture(1 << tract.detShift, detCaptureWindows(tract.detShift));
              medians.push(cap.ok ? cap.medianEnergy ?? null : null);
            }
          } finally {
            await releaseSoapyForFpga();
          }
          const acq = await gw({ op: "usb", action: "acquire" });
          if (calibWhy) {
            // Первопричина — калибровка: её логируем первой, сбой acquire
            // вторичен (но не прячем — USB так и остался у хоста).
            pushLog("sys", calibWhy);
            if (!acq.ok) pushLog("sys", `FPGA USB acquire: ${acq.reason ?? "отказ"}`);
            set({ fpgaPath: null });
            return false;
          }
          // Без USB у агента ARM ушёл бы в мёртвый транспорт и упал с
          // криптичной причиной — отказываем здесь, как handoff (и с тем же
          // чистым состоянием: USB свободен, ARM не было).
          if (!acq.ok) {
            pushLog("sys", `FPGA эфир-обход: USB обратно не занят (${acq.reason ?? "отказ"}) — ARM отменён`);
            set({ fpgaPath: null });
            return false;
          }
          pushLog(
            "sys",
            `FPGA эфир-обход: калибровка ${walk.centers.length} стоянок за ${Date.now() - t0} мс ` +
              `(~${Math.round((Date.now() - t0) / walk.centers.length)} мс/стоянка)`,
          );
          if (await abortAirIfRevoked()) return false;
          const thrTable = airThrTable(medians);
          if (!thrTable) {
            pushLog("sys", "FPGA эфир-обход: калибровка не дала ни одной живой полки — ARM отменён");
            set({ fpgaPath: null });
            return false;
          }
          const armCmd = fpgaArmCmd("lb_gated", {
            detThr: thrTable[firstIdx],
            detShift: tract.detShift,
            token: get().fpgaToken,
            freqMhz: first,
            fsHz: tract.fsHz,
            bwMhz: tract.bwMhz,
          });
          if (gainDb !== undefined && Number.isFinite(gainDb)) {
            armCmd.gain_db = Math.round(gainDb);
          }
          const r = await gw(armCmd);
          pushLog("sys", `FPGA ARM (ретрансляция): ${r.reason ?? (r.ok ? "ок" : "отказ")}`);
          if (await abortAirIfRevoked(true)) return false;
          if (!r.ok) {
            await get().fpgaDisarm();
            usbTouched = false;
            set({ fpgaPath: null });
            return false;
          }
          set({
            fpgaArmed: true,
            fpgaAutoCycle: false,
            lastForwardMhz: first,
            lastSdrTxUs: null,
            lastCueReason:
              `FPGA ретрансляция · обход ${walk.centers.length} стоянок · канал ${tract.bwMhz} МГц · ` +
              `выдержка ${walk.dwellMs} мс · ${formatDetWindow(tract.fsHz)}`,
          });
          beginFpgaKick();
          if (await abortAirIfRevoked()) return false;
          beginAirWalk(walker, walk, tract, thrTable, walk.centers, gw);
          return true;
        }

        const kind = get().txWaveKind ?? get().signalKind;
        const walk = planFpgaSoloWalk({
          f1Mhz: f1,
          f2Mhz: f2,
          windowMhz: parseFloat(get().fpgaSoloWindowMhz),
          analogMaxMhz: analog,
          dwellMs: parseFloat(get().fpgaSoloDwellMs),
          pattern: get().fpgaSoloPattern,
          wave: kind,
        });
        if (!walk.ok) {
          pushLog("sys", walk.reason);
          set({ fpgaPath: null });
          return false;
        }
        const hopNo = soloHopBlockedReason(get().sdrId, walk.hop);
        if (hopNo) {
          pushLog("sys", hopNo);
          set({ fpgaPath: null });
          return false;
        }
        const walker = makeSoloWalker(walk);
        const first = walker.next();
        const mhz = first.centerMhz;
        const park = soloParkOpts(walk);
        pushLog("sys", walk.reason);
        if (await abortSoloIfRevoked()) return false;
        const useNco = kind === "sine" || kind === "tone";
        if (useNco) {
          set({ fpgaMode: "nco" });
          const pk = await parkFpgaLo({
            midMhz: mhz,
            analogMhz: park.analogMhz,
            spanMhz: park.spanMhz,
            rx: false,
            fsHz: park.fsHz,
            gw,
          });
          if (await abortSoloIfRevoked()) return false;
          if (!pk.ok) {
            stopSoloWalk();
            set({ fpgaPath: null });
            return false;
          }
          const ftw = ncoFtwFromFrac(Number(get().signalParams.fj));
          const cmd = fpgaArmCmd("nco", {
            detThr: get().fpgaDetThr,
            detShift: get().fpgaDetShift,
            token: get().fpgaToken,
            ncoFtw: ftw,
            freqMhz: mhz,
            fsHz: walk.fsHz,
            bwMhz: walk.analogMhz,
          });
          const r = await gw(cmd);
          pushLog("sys", `FPGA ARM (nco): ${r.reason ?? (r.ok ? "ок" : "отказ")}`);
          if (await abortSoloIfRevoked(true)) return false;
          if (!r.ok) {
            await get().fpgaDisarm();
            usbTouched = false;
            stopSoloWalk();
            set({ fpgaPath: null });
            return false;
          }
          set({
            fpgaArmed: true,
            lastForwardMhz: mhz,
            lastSdrTxUs: null,
            lastCueReason: `FPGA · тон ${kind} · ${mhz.toFixed(3)} МГц · окно ${walk.analogMhz} МГц · без эфира`,
          });
          beginFpgaKick();
          if (await abortSoloIfRevoked()) return false;
          beginSoloWalk(walker, walk, gw);
          return true;
        }

        set({ fpgaMode: "player" });
        const setLen = await gw({ op: "set", reg: "player_len", value: 4095 });
        if (!setLen.ok) pushLog("sys", `FPGA set player_len: ${setLen.reason ?? "отказ"}`);
        if (await abortSoloIfRevoked()) return false;
        const setCtl = await gw({ op: "set", reg: "player_ctl", value: 1 });
        // Сбой capture_arm всплыл бы позже («capture_done=0») — причину
        // честнее логировать здесь, у записи.
        if (!setCtl.ok) pushLog("sys", `FPGA set player_ctl: ${setCtl.reason ?? "отказ"}`);
        if (await abortSoloIfRevoked()) return false;
        const relSolo = await gw({ op: "usb", action: "release" });
        if (!relSolo.ok) {
          // USB остался у агента: openSdr ниже честно упадёт, а usbOut не
          // врём — abort-путь не перезанимает то, что не отпускали.
          pushLog("sys", `FPGA USB release: ${relSolo.reason ?? "отказ"}`);
        } else {
          usbOut = true;
        }
        if (await abortSoloIfRevoked()) return false;
        if (!get().sdrEmulation && hostSdrAvailable()) {
          await get().openSdr({ requireHw: requireHwForSdr(get().sdrId) || undefined });
          if (await abortSoloIfRevoked()) return false;
          if (!gLive) {
            pushLog("sys", "FPGA player: SDR не открылся — capture отменён");
            stopSoloWalk();
            set({ fpgaPath: null });
            const acq0 = await gw({ op: "usb", action: "acquire" });
            if (!acq0.ok) pushLog("sys", `FPGA USB acquire: ${acq0.reason ?? "отказ"}`);
            usbOut = false;
            return false;
          }
          const tx = await hostTxWave(mhz, kind, get().signalParams, walk.fsHz);
          pushLog("sys", tx.reason);
          if (await abortSoloIfRevoked()) return false;
          if (tx.fake) {
            await releaseSoapyForFpga();
            const acq0 = await gw({ op: "usb", action: "acquire" });
            if (!acq0.ok) pushLog("sys", `FPGA USB acquire: ${acq0.reason ?? "отказ"}`);
            usbOut = false;
            stopSoloWalk();
            set({ fpgaPath: null });
            pushLog("sys", "FPGA player: FAKE TX — волна не в эфире, ARM отменён");
            return false;
          }
          if (!tx.ok) {
            await releaseSoapyForFpga();
            const acq0 = await gw({ op: "usb", action: "acquire" });
            if (!acq0.ok) pushLog("sys", `FPGA USB acquire: ${acq0.reason ?? "отказ"}`);
            usbOut = false;
            stopSoloWalk();
            set({ fpgaPath: null });
            return false;
          }
          // 4096 сэмплов @ fs окна. sleep только даёт стриму дойти,
          // доказательство — capture_done после acquire (HDL / E3).
          await waitMs(50);
          if (await abortSoloIfRevoked()) return false;
          await releaseSoapyForFpga();
          if (await abortSoloIfRevoked()) return false;
        } else {
          pushLog("sys", "FPGA player: нет Soapy — волну в RAM не загрузить, ARM отменён");
          stopSoloWalk();
          set({ fpgaPath: null });
          const acq = await gw({ op: "usb", action: "acquire" });
          if (!acq.ok) pushLog("sys", `FPGA USB acquire: ${acq.reason ?? "отказ"}`);
          usbOut = false;
          return false;
        }
        const acq = await gw({ op: "usb", action: "acquire" });
        if (acq.ok) usbOut = false;
        if (await abortSoloIfRevoked()) return false;
        if (!acq.ok) {
          pushLog("sys", `FPGA USB acquire: ${acq.reason ?? "отказ"}`);
          stopSoloWalk();
          set({ fpgaPath: null });
          return false;
        }
        const cap = await gw({ op: "status" });
        if (await abortSoloIfRevoked()) return false;
        const noWave = fpgaPlayerReady(cap);
        if (noWave) {
          pushLog("sys", noWave);
          stopSoloWalk();
          set({ fpgaPath: null });
          return false;
        }
        const r = await gw(
          fpgaArmCmd("player", {
            detThr: get().fpgaDetThr,
            detShift: get().fpgaDetShift,
            token: get().fpgaToken,
            freqMhz: mhz,
            fsHz: walk.fsHz,
            bwMhz: walk.analogMhz,
          }),
        );
        pushLog("sys", `FPGA ARM (player): ${r.reason ?? (r.ok ? "ок" : "отказ")}`);
        if (await abortSoloIfRevoked(true)) return false;
        if (!r.ok) {
          await get().fpgaDisarm();
          usbTouched = false;
          stopSoloWalk();
          set({ fpgaPath: null });
          return false;
        }
        set({
          fpgaArmed: true,
          lastForwardMhz: mhz,
          lastSdrTxUs: null,
          lastCueReason: `FPGA · волна «${kind}» из памяти · ${mhz.toFixed(3)} МГц · окно ${walk.analogMhz} МГц · без эфира`,
        });
        beginFpgaKick();
        if (await abortSoloIfRevoked()) return false;
        beginSoloWalk(walker, walk, gw);
        return true;
      } finally {
        // Отмена может завершить подготовку через ранний return (например,
        // calibWhy), не дойдя до abort-хелпера. Ресурс всё равно освобождаем.
        if ((soloRevoked() || airRevoked()) && usbTouched && !get().fpgaStopPending) {
          if (usbOut) await releaseSoapyForFpga();
          await releaseCancelledFpgaUsb(s0);
        }
        set({ fpgaBusy: false });
        if (!get().fpgaArmed && get().fpgaPath) set({ fpgaPath: null });
      }
    },

    abortFpgaSolo: () => {
      gFpgaSoloGen += 1;
      stopSoloWalk();
    },

    abortFpgaAir: () => {
      gFpgaAirGen += 1;
      // Как abortFpgaSolo: отзыв гасит и сам интервал обхода, не только
      // поколение — иначе до fpgaDisarm тики продолжали бы слать tune.
      stopAirWalk();
    },

    abortFpgaArm: () => {
      gFpgaArmGen += 1;
    },

    fpgaDisarm: async () => {
      if (fpgaDisarmFlight) return fpgaDisarmFlight;
      if (fpgaDisarmRetry !== null) {
        clearTimeout(fpgaDisarmRetry);
        fpgaDisarmRetry = null;
      }
      const target = fpgaStopTarget ?? { gateway: get().sdrGateway, token: get().fpgaToken, phase: "disarm" as const };
      fpgaStopTarget = target;
      // DISARM сильнее любого ARM в полёте: кино-solo, кино-эфир и ручной
      // ARM сверяют поколения после await и не коммитят.
      gFpgaSoloGen += 1;
      gFpgaAirGen += 1;
      gFpgaArmGen += 1;
      stopSoloWalk();
      stopAirWalk();
      stopFpgaKick();
      stopFpgaObserve();
      // Операторский/эпохальный стоп: очередь ОБЫЧНОГО начинается заново.
      // Автовозврат (fpgaReturnToScan) сюда не приходит — порядок держится.
      gFpgaTurnLastMhz = null;
      set({ fpgaBusy: true, fpgaStopPending: true, fpgaStopPhase: target.phase, fpgaAutoCycle: false, fpgaStatus: null });
      fpgaDisarmFlight = (async () => {
        if (target.phase === "disarm") {
          const r = await hostFpga({ op: "disarm", token: target.token }, target.gateway);
          pushLog("sys", `FPGA DISARM: ${r.reason ?? (r.ok ? "ок" : "отказ")}`);
          if (!r.ok) {
            // Ни старый STATUS, ни прошедшее время не доказывают отключение.
            set({ fpgaStatus: { ok: false, reason: r.reason ?? "нет подтверждения DISARM" } });
            return;
          }
          target.phase = "release";
          set({ fpgaArmed: false, fpgaPath: null, lastForwardMhz: null, fpgaStopPhase: "release", fpgaStatus: null });
        }
        const rel = await hostFpga({ op: "usb", action: "release", token: target.token }, target.gateway);
        if (!rel.ok) {
          const reason = `FPGA USB release: ${rel.reason ?? "отказ"}`;
          pushLog("sys", reason);
          set({ fpgaStatus: { ok: false, reason } });
          return;
        }
        fpgaStopTarget = null;
        set({ fpgaStopPending: false, fpgaStopPhase: null, fpgaStatus: null, lastCueReason: "FPGA: остановка завершена, соединение освобождено" });
      })().finally(() => {
        fpgaDisarmFlight = null;
        set({ fpgaBusy: false });
        if (get().fpgaStopPending) {
          // Повторяем только неподтверждённый этап: DISARM либо release.
          // Не возобновляем kick, tune, ARM или авто-цикл.
          fpgaDisarmRetry = setTimeout(() => {
            fpgaDisarmRetry = null;
            void get().fpgaDisarm();
          }, 1000);
        }
      });
      return fpgaDisarmFlight;
    },

    stopFpgaAir: async () => {
      // Операторский СТОП режима FPGA+сканер: скан стоп, DISARM, USB хосту.
      // Авто-рестарта скана нет — решение оператора, не таймаут.
      gFpgaAirGen += 1; // handoff в полёте увидит смену поколения и откачет ARM
      get().stopScan();
      // Только ARM-фаза: disarm/release/reopen. Handoff в полёте (fpgaBusy
      // без armed) дожимать не надо — уборка за его abortIfRevoked, а reopen
      // под ним открыл бы второй Soapy-device на занятом USB.
      if (get().fpgaArmed || get().fpgaStopPending) {
        await get().fpgaDisarm();
        if (get().fpgaStopPending) return;
        set({ lastForwardMhz: null });
        if (!get().sdrOpened && !get().sdrEmulation) await get().openSdr();
      }
      gLastDetCount = null;
      gDetStagnantSinceMs = null;
    },

    fpgaPollStatus: async () => {
      if (get().fpgaStopPending) return;
      if (gFpgaObserveInflight) return;
      gFpgaObserveInflight = true;
      const obsGen = gFpgaObserveGen;
      try {
      const r = await hostFpga({ op: "status", token: get().fpgaToken }, get().sdrGateway);
      if (obsGen !== gFpgaObserveGen) return;
      set({ fpgaStatus: r });
      if (r.legion !== undefined) set({ fpgaLegion: r.legion });
      if (r.ok && r.freq_mhz && r.freq_mhz > 0 && get().fpgaArmed) {
        set({ lastForwardMhz: r.freq_mhz });
      }
      if (
        r.ok &&
        isFpgaAirPattern(get().scanPattern) &&
        get().fpgaArmed &&
        typeof r.scan_event_seq === "number" &&
        r.scan_event_seq > 0 &&
        r.scan_event_seq !== gLastScanEventSeq
      ) {
        gLastScanEventSeq = r.scan_event_seq;
        const ts = Date.now();
        const d = new Date(ts);
        const pad = (n: number, w = 2) => String(n).padStart(w, "0");
        const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
        const code = r.scan_event_code ?? (typeof r.scan_event === "number" ? r.scan_event & 0xff : 0);
        const hz = r.peak_mhz && r.peak_mhz > 0 ? r.peak_mhz : r.freq_mhz;
        const at = hz && hz > 0 ? ` ${hz.toFixed(3)} МГц` : "";
        const what =
          code === 1 ? "сканирование" :
          code === 2 ? `окно ${FPGA_AI_LABEL_RU} на всплеск${at}` :
          code === 3 ? `захват${at} (выдержка)` :
          code === 4 ? `перескок${at} (выдержка заново)` :
          code === 5 ? "повторное сканирование" :
          `событие ${code}${at}`;
        pushLog("sys", `${FPGA_AIR_MODE_RU} ${clock}: ${what}`);
      }
      if (get().fpgaArmed && get().fpgaMode === "lb_gated") {
        ingestFpgaLab(r.ok ? r.freq_mhz ?? null : null, r.ok && r.det_active === true, Date.now());
      }
      // Длительная непрерывная работа (шлюз считает armed_s): лог один раз
      // на смену текста, не каждый опрос.
      if (r.ok && r.warn && r.warn !== gArmWarnLast) {
        gArmWarnLast = r.warn;
        pushLog("sys", `FPGA: ${r.warn}`);
      }
      if (!r.warn) gArmWarnLast = "";
      // Watchdog сработал в FPGA → TX уже погашен железом; синхронизируем UI
      if (r.ok && get().fpgaArmed && get().fpgaMode === "lb_gated") {
        set({ lastCueReason: fpgaObserveLine(r) });
      }
      const autoAir =
        isFpgaAirPattern(get().scanPattern) &&
        get().fpgaArmed &&
        get().fpgaMode === "lb_gated" &&
        get().fpgaAutoCycle;
      if (r.ok && r.wd_fired && get().fpgaArmed) {
        pushLog("sys", "FPGA: watchdog погасил TX (heartbeat пропадал) — UI снял ARM");
        // CTRL.ARM в FPGA после wd_fired всё ещё взведён, а expired липкий —
        // без DISARM (CTRL=0) следующий ARM молчал бы навсегда.
        if (autoAir) {
          // Авария транспорта, не эфир: возврат к скану без skip частоты.
          pushLog("sys", `${FPGA_AIR_MODE_RU}: сторожевой таймер — стоп, возврат к поиску`);
          await fpgaReturnToScan(null);
        } else {
          // Solo: stopSoloWalk сразу — иначе tune до следующего dwell
          // снова поднимает AIR_PREP (TX) после deadman.
          await get().fpgaDisarm();
        }
        return;
      }
      // Автовозврат «энергия пропала»: det_count не растёт FPGA_AIR_GONE_MS.
      // Уровень det_active семплировался бы с пропусками коротких гейтов —
      // счётчик монотонен и от фазы опроса не зависит. Не «N опросов»:
      // тик 80 мс иначе сжёг бы 1.2 с до 240 мс.
      if (autoAir && r.ok && !gFpgaHandoffBusy) {
        /* Выдержку TURN делает NIOS. Хост не снимает onboard ARM по 0.4 мс. */
        const dc = r.det_count ?? 0;
        const stagnant = detCountStagnant(gLastDetCount, dc, gDetStagnantSinceMs, Date.now());
        gLastDetCount = dc;
        gDetStagnantSinceMs = stagnant.stagnantSinceMs;
        if (stagnant.gone) {
          const mhz = get().lastForwardMhz;
          pushLog(
            "sys",
            `${FPGA_AIR_MODE_RU}: сигнал пропал (${FPGA_AIR_GONE_MS} мс без роста det_count) — ` +
              `DISARM, возврат к скану${mhz != null ? `, skip ${mhz.toFixed(3)} МГц` : ""}`,
          );
          await fpgaReturnToScan(mhz);
        }
      }
      } finally {
        if (obsGen === gFpgaObserveGen) gFpgaObserveInflight = false;
      }
    },

    probeSdr: async () => {
      if (get().flashBusy) {
        pushLog("sys", "PROBE: идёт прошивка — дождитесь конца записи");
        return;
      }
      if (!get().sdrEmulation && hostSdrAvailable()) {
        const st = get();
        const p = await hostPing(sdrOpenArgs(st.sdrId, st.sdrGateway));
        const base = gSdr.probe().map((d) => ({ ...d, present: false, serial: "" }));
        const list = markCatalogPresent(base, p.devices ?? []);
        set({
          sdrDevices: list,
          sdrHostReady: !!(p.ok && p.soapy),
          sdrHostDetail: p.reason ?? "",
        });
        pushLog("sys", p.reason || `SDR probe Soapy: ${(p.devices ?? []).length} устройств`);
        return;
      }
      const list = gSdr.probe();
      set({ sdrDevices: list, sdrHostReady: false, sdrHostDetail: "эмуляция каталога" });
      pushLog("sys", `SDR probe: ${list.length} типов в каталоге (эмуляция)`);
    },

    openSdr: async (opts) => {
      const s = get();
      if (s.fpgaArmed || s.fpgaStopPending) {
        pushLog("sys", "ОТКРЫТЬ SDR: FPGA ARM занял USB — сначала ОСТАНОВИТЬ FPGA");
        return;
      }
      if (s.flashBusy) {
        // Иначе Soapy откроет USB-устройство посередине записи bladeRF-cli.
        pushLog("sys", "ОТКРЫТЬ SDR: идёт прошивка — дождитесь конца записи");
        return;
      }
      const plan = planEthernet(s.sdrId, s.sdrGateway);
      const remote = sdrOpenArgs(s.sdrId, s.sdrGateway);
      if (s.sdrEmulation) {
        gLive = false;
        gSdr.setEmulation(true);
        const r = gSdr.open(s.sdrId, remote);
        set({ sdrOpened: gSdr.opened(), sdrRemote: gSdr.remoteArgs() });
        pushLog("sys", r.reason);
        pushLog("sys", plan.cableText);
        return;
      }
      const ping = hostSdrAvailable()
        ? await hostPing(sdrOpenArgs(s.sdrId, s.sdrGateway))
        : { ok: false, soapy: false, reason: "нет Tauri" };
      const pre = hostOpenAllowed({
        emulation: false,
        hasSoapyOrCli: !!(ping.ok && ping.soapy),
        imageBytes: s.sdrImageBytes,
      });
      if (!pre.ok) {
        pushLog("sys", pre.reason);
        set({ sdrHostReady: false, sdrHostDetail: pre.reason });
        return;
      }
      const caps = catalogCaps(s.sdrId);
      const r = await hostOpen(remote, caps.analogBwMhz, caps.canTx, caps.fullDuplex, opts?.requireHw);
      if (!r.ok) {
        pushLog("sys", r.reason);
        return;
      }
      if (opts?.requireHw && r.fake) {
        pushLog("sys", "FPGA: FAKE Soapy — не эфир, ARM нельзя");
        await hostClose();
        return;
      }
      gLive = true;
      const row = catalogById(s.sdrId);
      set({
        sdrOpened: row
          ? { ...row, serial: remote || "soapy", present: true }
          : null,
        sdrRemote: remote,
        sdrHostReady: true,
        sdrHostDetail: r.reason,
      });
      pushLog("sys", r.reason);
      pushLog("sys", plan.cableText);
    },

    closeSdr: async () => {
      // Новая эпоха ДО awaits: in-flight handoff/re-sense по старому устройству
      // после await не коммитятся и не восстанавливают TX.
      gTxGen += 1;
      get().abortFpgaSolo();
      get().abortFpgaAir();
      get().abortFpgaArm();
      stopTxWatch();
      stopTxWalk();
      stopFpgaKick();
      stopFpgaObserve();
      stopAirWalk();
      if (get().fpgaArmed || get().fpgaStopPending) {
        await get().fpgaDisarm();
      }
      get().stopScan();
      gGate.reset();
      clearAttackHoldTimer();
      gAttackLastTxEnd = Date.now();
      gAttackTracker.markHeld(null);
      if (gLive) {
        await hostTxOff();
        await hostClose();
      }
      gSdr.txOff();
      gSdr.close();
      gLive = false;
      gResense = false;
      gSkipMhz = null;
      // transmitArmed сбрасываем: раньше после закрытия кнопка ложно
      // показывала «СТОП ПЕРЕДАЧУ», а тики молча churn'ились в planHandoff.
      set({
        sdrOpened: null,
        sdrRemote: "",
        transmitArmed: false,
        signalTxActive: false,
        lastForwardMhz: null,
        lastSdrTxUs: null,
        lastForwardPowerDbm: null,
        sdrHoldSince: null,
        attackTxUntil: null,
        attackTracks: get().scanPattern === "auto" ? gAttackTracker.snapshot() : get().attackTracks,
      });
      pushLog("sys", "SDR закрыт");
    },

    flashSdr: async (action) => {
      if (get().flashBusy) {
        pushLog("sys", "прошивка уже идёт — ждите");
        return;
      }
      if (get().fpgaArmed || get().fpgaStopPending) {
        pushLog("sys", "прошивка SDR: сначала ОСТАНОВИТЬ FPGA — CLI и шлюз не делят USB");
        return;
      }
      const s = get();
      const act = action ?? s.sdrFlashAction;
      const imagePath = (s.sdrImagePath || s.sdrFlashName).trim();
      const job = {
        deviceId: s.sdrOpened?.id ?? s.sdrId,
        filename: imagePath || s.sdrFlashName,
        byteLength: s.sdrImageBytes,
        action: act,
      };
      const plan = planSdrWrite({
        job,
        imagePath,
        confirmed: s.sdrFlashConfirm,
        gateway: s.sdrGateway,
      });
      if (!plan.ok) {
        const r: FlashResult = { ok: false, kind: "unknown", reason: plan.reason, written: false };
        set({ lastFlash: r });
        pushLog("sys", r.reason);
        return;
      }
      if (!hostSdrAvailable()) {
        const r: FlashResult = {
          ok: false,
          kind: "unknown",
          reason: `команда не запущена (нет desktop LEGION): ${plan.argv.join(" ")}`,
          written: false,
        };
        set({ lastFlash: r, sdrFlashConfirm: false });
        pushLog("sys", r.reason);
        return;
      }
      set({ flashBusy: true });
      try {
        if (get().sdrOpened || get().scanRunning || get().transmitArmed) {
          await get().closeSdr();
        }
        const r = await hostFlash(plan.argv, plan.file);
        set({
          lastFlash: { ok: r.ok, kind: "unknown", reason: r.reason, written: r.written },
          sdrFlashConfirm: false,
        });
        pushLog("sys", r.written ? `записано в SDR: ${r.reason}` : `не записано: ${r.reason}`);
      } finally {
        set({ flashBusy: false });
      }
    },

    setLegionFlashTarget: (v) => set({ legionFlashTarget: v, legionFlashConfirm: false }),
    setLegionFlashAction: (a) => set({ legionFlashAction: a, legionFlashConfirm: false }),
    setLegionFlashPath: (v) => set({ legionFlashPath: v, legionFlashConfirm: false }),
    setLegionFlashConfirm: (v) => set({ legionFlashConfirm: v }),

    legionEnvRefresh: async () => {
      const r = await hostLegionEnvInfo();
      if (!r.ok || !r.info) {
        set({ legionEnvDetail: r.reason, legionCanBuild: false });
        return;
      }
      set({ legionEnvDetail: r.info.reason, legionCanBuild: r.info.canBuild });
    },

    legionToolchainRun: async () => {
      const r = await hostLegionToolchain();
      set({ legionBuildLog: r.text });
      const lastLine = r.text.trim().split("\n").filter(Boolean).pop() ?? "";
      pushLog("sys", r.ok ? `toolchain legion: ${lastLine || "OK"}` : `toolchain legion: ${lastLine || "FAIL"}`);
    },

    legionBuildStart: async () => {
      // Сборка не трогает USB и не пишет в железо — flashBusy тут не нужен
      // (иначе часовой синтез глушил бы скан: tickScan стоит на flashBusy).
      if (get().legionBuildPhase === "building") {
        pushLog("sys", "сборка уже идёт — ждите или ОТМЕНА");
        return;
      }
      const plan = planLegionBuild(get().sdrId);
      if (!plan.ok || !plan.board || !plan.size) {
        pushLog("sys", plan.reason);
        return;
      }
      const gen = ++gLegionBuildGen;
      set({ legionBuildPhase: "building", legionBuildLog: "", lastLegionFlash: null });
      const start = await hostLegionBuildStart(plan.board, plan.size);
      if (!start.ok) {
        set({ legionBuildPhase: "failed", legionBuildLog: start.reason });
        pushLog("sys", `сборка legion: ${start.reason}`);
        return;
      }
      pushLog("sys", `сборка legion: ${plan.reason} · лог ${start.logPath ?? ""}`);
      // Синтез Quartus долгий (ориентир — десятки минут): опрос статуса раз
      // в 2 с, лог хвостом. Поколение режет дубли и опрос после отмены.
      while (gen === gLegionBuildGen) {
        await waitMs(2000);
        if (gen !== gLegionBuildGen) return;
        const st = await hostLegionBuildStatus();
        if (st.tail !== undefined) set({ legionBuildLog: st.tail });
        if (st.running) continue;
        const art = st.artifact;
        // Успех = артефакт .rbf на диске: build_bladerf.sh без set -e
        // возвращает 0 и при упавшем Quartus — exit коду не верим.
        if (art?.path) {
          set({
            legionBuildPhase: "done",
            legionArtifactPath: art.path,
            legionArtifactSha256: art.sha256 ?? "",
            legionFlashPath: art.path,
            // Новый артефакт = новый вход: галочка от старого файла не
            // переносится (тот же паттерн, что setSdrFlashName → confirm false).
            legionFlashConfirm: false,
          });
          pushLog(
            "sys",
            `сборка legion: готово ${art.path}${art.sha256 ? ` · sha256 ${art.sha256.slice(0, 16)}…` : ""}`,
          );
        } else {
          set({ legionBuildPhase: "failed" });
          // st.reason — сбой самого опроса (invoke/lock), st.exit — код процесса.
          pushLog(
            "sys",
            `сборка legion: ${st.reason ?? `exit ${st.exit ?? "?"}`} — артефакт не найден, хвост лога на вкладке`,
          );
        }
        return;
      }
    },

    legionBuildCancel: async () => {
      gLegionBuildGen += 1;
      const r = await hostLegionBuildCancel();
      set({ legionBuildPhase: "idle" });
      pushLog("sys", r.reason);
    },

    legionFlash: async () => {
      if (get().flashBusy) {
        pushLog("sys", "прошивка уже идёт — ждите");
        return;
      }
      if (get().fpgaArmed || get().fpgaStopPending) {
        pushLog("sys", "прошивка legion: сначала ОСТАНОВИТЬ FPGA — CLI и шлюз не делят USB");
        return;
      }
      const s = get();
      const target = s.legionFlashTarget;
      const path = (s.legionFlashPath || (target === "local" ? s.legionArtifactPath : "")).trim();
      const action = s.legionFlashAction;
      const plan =
        target === "local"
          ? planLegionFlashLocal({ sdrId: s.sdrId, path, action, confirmed: s.legionFlashConfirm })
          : planLegionFlashGateway({ sdrId: s.sdrId, path, action, confirmed: s.legionFlashConfirm });
      if (!plan.ok) {
        set({ lastLegionFlash: { ok: false, reason: plan.reason } });
        pushLog("sys", plan.reason);
        return;
      }
      if (target === "gateway" && !s.sdrGateway.trim()) {
        // Иначе closeSdr уже закрыл бы сессию, а flash упал бы на «нет IP шлюза».
        const reason = "прошивка через шлюз: укажите IP шлюза (вкладка SDR) или выберите «локальный USB»";
        set({ lastLegionFlash: { ok: false, reason } });
        pushLog("sys", reason);
        return;
      }
      if (!hostSdrAvailable()) {
        const reason = `команда не запущена (нет desktop LEGION): ${plan.reason}`;
        set({ lastLegionFlash: { ok: false, reason }, legionFlashConfirm: false });
        pushLog("sys", reason);
        return;
      }
      set({ flashBusy: true });
      try {
        if (get().sdrOpened || get().scanRunning || get().transmitArmed) {
          await get().closeSdr();
        }
        // USB у агента даже без ARM (он держит его со старта) — release
        // лучшее-усилие: шлюз выключен → локальный USB и так свободен.
        const rel = await hostFpga({ op: "usb", action: "release", token: get().fpgaToken }, get().sdrGateway);
        if (!rel.ok) {
          pushLog(
            "sys",
            `USB release перед прошивкой: ${rel.reason ?? "шлюз молчит"} — если USB на шлюзе, CLI плату не откроет`,
          );
        }
        if (target === "local") {
          const r = await hostFlash(plan.argv, plan.file);
          const hint = !r.ok
            ? ""
            : action === "load"
              ? " · дальше: legion_gateway с LEGION_FPGA_RBF=<этот .rbf>"
              : " · autoload после цикла питания; откат — hostedx*.rbf (вкладка ПРОШИВКА SDR)";
          set({ lastLegionFlash: { ok: r.ok, reason: r.reason + hint }, legionFlashConfirm: false });
          pushLog("sys", r.ok ? `записано (legion): ${r.reason}${hint}` : `не записано: ${r.reason}`);
          return;
        }
        // Шлюз: flash async + опрос flash_status. Релей воркера 12 с режет
        // синхронный вызов (bladeRF-cli -L дольше) — старт/статус мгновенные.
        const start = await hostFpga(
          { op: "flash", path, action, token: get().fpgaToken },
          get().sdrGateway,
        );
        if (!start.ok || !start.started) {
          const reason = start.reason ?? "шлюз flash не начал";
          set({ lastLegionFlash: { ok: false, reason }, legionFlashConfirm: false });
          pushLog("sys", `не записано: ${reason}`);
          return;
        }
        pushLog("sys", `шлюз: прошивка пошла (${action}) — опрос flash_status`);
        const deadline = Date.now() + 240_000;
        let finalSt: FpgaStatus | null = null;
        while (Date.now() < deadline) {
          await waitMs(1500);
          const st = await hostFpga({ op: "flash_status", token: get().fpgaToken }, get().sdrGateway);
          if (st.running) continue;
          finalSt = st;
          break;
        }
        const st = finalSt ?? ({ ok: false, reason: "таймаут опроса flash_status (240 с)" } as FpgaStatus);
        const reason = st.reason ?? st.log ?? (st.ok ? "готово" : "отказ");
        // Подсказка «перезанял USB» — только без предупреждения шлюза
        // (warn = CLI записал, но USB обратно не занялся — это не успех тракта).
        const hint = !st.ok || st.warn
          ? ""
          : action === "load"
            ? " · шлюз перезанял USB, ревизия в RAM"
            : " · autoload после цикла питания";
        set({ lastLegionFlash: { ok: !!st.ok, reason: reason + hint }, legionFlashConfirm: false });
        pushLog("sys", st.ok ? `записано (legion, шлюз): ${reason}` : `не записано (шлюз): ${reason}`);
      } finally {
        set({ flashBusy: false });
      }
    },

    probeEsp32Chip: async () => {
      if (get().flashBusy) {
        pushLog("sys", "прошивка уже идёт — ждите");
        return;
      }
      const port = get().selectedPort;
      set({ flashBusy: true, esp32FlashConfirm: false });
      try {
        const r = await hostEsp32ChipId(port);
        const chip = r.ok ? parseEsp32Chip(r.text) : null;
        set({
          esp32Chip: chip,
          esp32ChipPort: chip ? port.trim() : null,
          esp32ChipRaw: r.text,
        });
        if (!r.ok) pushLog("sys", `ESP32 chip_id: ${r.text}`);
        else if (!chip) pushLog("sys", `ESP32: не разобрали чип — не шьём. ${r.text}`);
        else pushLog("sys", `ESP32 чип ${chip} на ${port}`);
      } finally {
        set({ flashBusy: false });
      }
    },

    flashEsp32: async () => {
      if (get().flashBusy) {
        pushLog("sys", "прошивка уже идёт — ждите");
        return;
      }
      const s = get();
      const plan = planEsp32Flash({
        env: s.esp32FlashEnv,
        port: s.selectedPort,
        confirmed: s.esp32FlashConfirm,
        chip: s.esp32Chip,
        chipPort: s.esp32ChipPort,
      });
      if (!plan.ok || !plan.env || !plan.port) {
        const r: Esp32FlashResult = { ok: false, reason: plan.reason, written: false };
        set({ lastEsp32Flash: r });
        pushLog("sys", r.reason);
        return;
      }
      if (!hostSdrAvailable()) {
        const r: Esp32FlashResult = {
          ok: false,
          reason: `команда не запущена (нет desktop LEGION): ${plan.reason}`,
          written: false,
        };
        set({ lastEsp32Flash: r, esp32FlashConfirm: false });
        pushLog("sys", r.reason);
        return;
      }
      set({ flashBusy: true });
      try {
        if (get().corridorRunning) await get().corridorStop();
        if (get().transportState === "connected") await get().disconnect();
        const r = await hostEsp32Flash(plan.env, plan.port);
        set({ lastEsp32Flash: r, esp32FlashConfirm: false });
        pushLog("sys", r.written ? `записано в ESP32: ${r.reason}` : `не записано: ${r.reason}`);
      } finally {
        set({ flashBusy: false });
      }
    },

    injectDemoTone: () => {
      const s = get();
      const f = s.sdrBands[0] ? (s.sdrBands[0].f1Mhz + s.sdrBands[0].f2Mhz) / 2 : 2442;
      gSdr.injectTone(f, -40);
      pushLog("sys", `демо-несущая ${f.toFixed(3)} МГц @ −40 дБм (мок, не эфир)`);
    },

    startScan: () => {
      void (async () => {
        const s = get();
        if (isFpgaAirPattern(s.scanPattern)) {
          await startOnboardIntercept();
          return;
        }
        const blocked = modeConflict("sdr", s.corridorRunning, false);
        if (blocked) {
          pushLog("sys", blocked);
          return;
        }
        if (s.rfOn || s.paOn) {
          pushLog("sys", "СКАНИРОВАТЬ: сначала RF OFF / PA OFF на ESP32 — тракты не вместе");
          return;
        }
        if (s.fpgaArmed || s.fpgaStopPending) {
          pushLog("sys", "СКАНИРОВАТЬ: FPGA ARM занял USB — сначала ОСТАНОВИТЬ FPGA. Хост-скан = мс, не µs");
          return;
        }
        if (s.signalTxActive) {
          pushLog("sys", "СКАНИРОВАТЬ: идёт TX сигнала — сначала СТОП на вкладке ТИП СИГНАЛА");
          return;
        }
        if (s.flashBusy) {
          // Иначе openSdr ниже открыл бы устройство посередине записи CLI.
          pushLog("sys", "СКАНИРОВАТЬ: идёт прошивка — дождитесь конца записи");
          return;
        }
        if (!ensureSdrBand()) return;
        const refused = scanRefusedReason(s.scanPattern);
        if (refused) {
          pushLog("sys", refused);
          return;
        }
        if (!s.sdrEmulation) {
          if (!get().sdrOpened) {
            await get().openSdr();
            if (!get().sdrOpened) return;
          }
        } else if (!gSdr.opened()) {
          gSdr.setEmulation(true);
          const opened = gSdr.open(s.sdrId, sdrOpenArgs(s.sdrId, s.sdrGateway));
          set({ sdrOpened: gSdr.opened(), sdrRemote: gSdr.remoteArgs() });
          pushLog("sys", opened.reason);
          if (!opened.ok) return;
        }
        if (gScanTimer) {
          clearInterval(gScanTimer);
          gScanTimer = null;
        }
        gScanGen += 1;
        const scanGen = gScanGen;
        const st = get();
        const caps = catalogCaps(st.sdrId);
        const analog = gLive ? caps.analogBwMhz : gSdr.analogBwMhz();
        const userWin = clampWindowMhz(parseFloat(st.scanWindowMhz), analog);
        const attackLive = st.scanPattern === "auto";
        const listen0 = attackLive
          ? attackListenPlan({
              analogMhz: analog,
              paintOwnsTx: attackPaintOwnsTx(st.scanPattern, st.attackPaint, st.transmitArmed),
              paint: st.attackPaint,
            })
          : null;
        const windowMhz = listen0 ? listen0.spanMhz : Math.min(userWin, hostPaintSpanMhz(analog));
        const walker = new ScanWalker({
          bands: st.sdrBands,
          pattern: "sweep",
          windowMhz,
          analogBwMhz: analog,
          dwellMs: parseFloat(st.scanDwellMs),
          seed: Date.now() & 0xffffffff,
        });
        gWalker = walker;
        const nBins = listen0 ? listen0.fftN : 1024;
        gLabSpur.recalibrate();
        if (st.scanPattern === "auto" && !(st.transmitArmed && st.attackPaint)) {
          gAttackTracker.reset();
          gAttackMemory.forgetLooks();
          bumpAttackThinkGen();
          set({
            scanRunning: true,
            scanCenterMhz: null,
            labSpurReady: false,
            attackTracks: [],
            attackRows: [],
            attackAdvice: EMPTY_ATTACK_ADVICE,
            attackSuggestPaint: null,
          });
        } else {
          set({ scanRunning: true, scanCenterMhz: null, labSpurReady: false });
        }
        pushLog(
          "sys",
          attackLive && listen0
            ? gLive
              ? `АТАКА слух: Thomson DPSS×3 · FFT ${listen0.fftN} · fs ${(listen0.fsHz / 1e6).toFixed(2)} · фильтр ${listen0.filterMhz.toFixed(1)} · crop ${listen0.cropFactor.toFixed(3)} · окно ${listen0.spanMhz.toFixed(1)} МГц · память IQ 2^24`
              : `АТАКА эмуляция: спектр эмулятора · FFT ${Math.min(listen0.fftN, 4096)} · окно ${listen0.spanMhz.toFixed(1)} МГц · разбор по бинам (IQ платы нет)`
            : `${gLive ? "SDR SCAN DIO-sys" : "SDR SCAN эмуляция"}: Hann+Welch-8 overlap 0.5 · crop 0.5 · ADC 40 MSPS · hop ${walker.windowMhz} МГц (soapy_power)`,
        );
        let inflight = false;
        let lastResenseAt = 0;
        const tickScan = async (): Promise<void> => {
          if (scanGen !== gScanGen || !get().scanRunning || get().flashBusy) return;
          let bins: ScanBin[] = [];
          let centerMhz = 0;
          let detections: Detection[] = [];
          const starePaint = attackPaintOwnsTx(get().scanPattern, get().attackPaint, get().transmitArmed)
            ? get().attackPaint
            : null;
          if (starePaint) {
            centerMhz = paintCenterMhz(starePaint);
          } else {
            const step = gWalker?.next();
            if (!step?.centerMhz) return;
            centerMhz = step.centerMhz;
          }
          const listen =
            get().scanPattern === "auto"
              ? attackListenPlan({
                  analogMhz: analog,
                  paintOwnsTx: attackPaintOwnsTx(get().scanPattern, get().attackPaint, get().transmitArmed),
                  paint: get().attackPaint,
                })
              : null;
          const spanMhz = listen ? listen.spanMhz : hostScanSpanMhz(analog);
          if (gLive) {
            const win = listen
              ? await hostAttackScan(centerMhz, listen)
              : await hostScan(centerMhz, spanMhz, nBins);
            if (scanGen !== gScanGen || !get().scanRunning || get().flashBusy) return;
            if (win.txError) {
              pushLog("sys", win.txError);
              await get().stopTransmit();
              if (scanGen !== gScanGen) return;
            }
            if (!win.ok) {
              pushLog("sys", win.reason || "scan fail");
              return;
            }
            bins = win.bins;
            if (listen && win.memoryCap) {
              gAttackMemory.noteWorker(win.memorySamples ?? 0, win.memoryCap, win.memoryMs ?? 0);
            }
          } else if (listen) {
            bins = cropPsdBins(
              gSdr.scanWindow(centerMhz, listen.fsHz / 1e6, Math.min(listen.fftN, 4096)),
              listen.cropFactor,
            );
          } else {
            bins = cropPsdBins(gSdr.scanWindow(centerMhz, spanMhz, nBins));
          }
          const now = Date.now();
          const raw = clipToAllowlist(detectFromBins(bins, get().scanThresholdDb), get().sdrBands).map((d) => ({
            ...d,
            ts: now,
          }));
          detections = withoutOwnTx(raw, get().lastForwardMhz, ownTxGuardMhz(get().txWaveKind !== null));
          if (centerMhz) set({ scanCenterMhz: centerMhz });
          if (detections.length > 0) {
            const dets = mergeDetections(get().detections, detections);
            const hit = pickStrongest(detections);
            set({
              detections: dets,
              lastInterceptMhz: hit?.freqMhz ?? get().lastInterceptMhz,
            });
          }
          if (bins.length > 0) {
            set({ scanBins: bins });
            ingestHostLab(bins, now);
          }
          const cur = get();
          if (isFpgaAirPattern(cur.scanPattern)) {
            // Fail-closed: Старт перехвата не ставит scanRunning и не отдаёт
            // пик хост-FFT на USB-handoff. Живой таймер (остаток USB-цикла)
            // не должен снова вставить ноутбук в круг «увидел → усилитель».
            get().stopScan();
            return;
          }
          if (cur.scanPattern === "auto" && bins.length > 0) {
            const hits = detectAttackHits(bins, cur.scanThresholdDb, listen?.spanMhz).filter((h) =>
              cur.sdrBands.length === 0 ? true : cueFreqAllowed(h.freqMhz, cur.sdrBands),
            );
            const paint = cur.attackPaint;
            const paintTx = attackPaintOwnsTx(cur.scanPattern, paint, cur.transmitArmed);
            const guard = ownTxGuardMhz(cur.txWaveKind !== null);
            const fwd = cur.lastForwardMhz;
            const feed = hits.filter((h) => {
              if (paintTx && paint && h.freqMhz >= paint.f1Mhz && h.freqMhz <= paint.f2Mhz) return false;
              if (fwd != null && Math.abs(h.freqMhz - fwd) <= guard) return false;
              return true;
            });
            gAttackTracker.update(feed, now);
            if (paintTx && paint) gAttackTracker.markHeld(paintCenterMhz(paint));
            const snap = gAttackTracker.snapshot();
            set(attackBrainPatch(cur, snap, bins, listen?.spanMhz ?? spanMhz));
            void thinkAttackLooks(snap, listen?.fsHz ?? 61_440_000, centerMhz, paintTx);
          }
          if (!cur.transmitArmed || !scannerParticipates(cur.scanPattern)) return;
          if (attackPaintOwnsTx(cur.scanPattern, cur.attackPaint, cur.transmitArmed)) return;
          gSkipMhz = refreshSkipMhz(gSkipMhz, detections, centerMhz, spanMhz, bins.length > 0);
          const held = gGate.lastCuedMhz;
          if (
            cur.autoDispatch === "priority" &&
            held != null &&
            !gGate.inflight &&
            !cur.flashBusy &&
            Date.now() - lastResenseAt >= RESENSE_MS
          ) {
            lastResenseAt = Date.now();
            const rs = await resenseHeld(held, nBins);
            if (scanGen !== gScanGen || !shouldContinuePriorityTick(rs)) return;
          }
          if (!get().scanRunning || get().flashBusy || !get().transmitArmed) return;
          const after = get();
          const heldNow = gGate.lastCuedMhz;
          const dispatch = after.autoDispatch;
          const target = pickArmedAutoTarget({
            liveWindow: dispatch === "priority" ? detections : raw,
            archive: after.detections,
            heldMhz: heldNow,
            heldPowerDbm: after.lastForwardPowerDbm,
            skipMhz: gSkipMhz,
            dispatch,
            holdMasked: dispatch === "priority",
          });
          if (!target) return;
          if (gGate.queueIfBusy(target.freqMhz, target.powerDbm)) return;
          runHandoff(target.freqMhz, target.powerDbm);
        };
        const armTick = (): void => {
          if (inflight) return;
          inflight = true;
          void tickScan().finally(() => {
            inflight = false;
          });
        };
        armTick();
        gScanTimer = setInterval(armTick, walker.tickMs);
      })();
    },

    stopScan: () => {
      gScanGen += 1;
      if (gScanTimer) {
        clearInterval(gScanTimer);
        gScanTimer = null;
      }
      gWalker = null;
      if (get().scanRunning) set({ scanRunning: false });
      // СТОП СКАН гасит только хост-FFT. FPGA+сканер стопается с вкладки СКАН
      // (fpgaDisarm) или СТОП ПЕРЕДАЧУ. Нельзя гасить PLAYER/NCO только потому,
      // что в меню выбран пункт «Умная атака».
      if (get().transmitArmed) {
        // Re-sense живёт внутри tickScan: без скана удержание слепое —
        // жива ли частота, больше никто не проверяет (только watch потока).
        pushLog("sys", "СТОП СКАН: TX-удержание продолжается вслепую, без перепроверки эфира");
      }
    },

    startTransmit: async () => {
      const s = get();
      if (isFpgaAirPattern(s.scanPattern)) {
        // В режиме FPGA+СКАНЕР передача — автоматический цикл (СТАРТ/СТОП):
        // ARM идёт из детекта сканера с парком на пик и порогом из полки,
        // а не ручной ARM на середину полосы с порогом «на глаз».
        pushLog(
          "sys",
          `ПЕРЕДАТЬ в режиме «${FPGA_AIR_MODE_RU}» не участвует: после Старта хозяин — плата; ноутбук только Стоп`,
        );
        return;
      }
      if (s.flashBusy) {
        pushLog("sys", "ПЕРЕДАТЬ: идёт прошивка — сначала дождитесь");
        return;
      }
      const blocked = modeConflict("sdr", s.corridorRunning, false);
      if (blocked) {
        pushLog("sys", blocked);
        return;
      }
      if (s.rfOn || s.paOn) {
        pushLog("sys", "ПЕРЕДАТЬ: сначала RF OFF / PA OFF на ESP32 — тракты не вместе");
        return;
      }
      if (s.fpgaArmed || s.fpgaStopPending) {
        pushLog("sys", "ПЕРЕДАТЬ: FPGA ARM занял USB — сначала ОСТАНОВИТЬ FPGA. Это хост-путь (мс), не µs");
        return;
      }
      if (s.signalTxActive) {
        pushLog("sys", "ПЕРЕДАТЬ: идёт TX зашитого сигнала — сначала СТОП на вкладке ТИП СИГНАЛА");
        return;
      }
      if (!ensureSdrBand()) {
        pushLog("sys", "ПЕРЕДАТЬ: нет полосы F1…F2");
        return;
      }
      if (!s.sdrLoadOk) {
        pushLog("sys", "ПЕРЕДАТЬ: подтвердите нагрузку 50 Ом на выходе усилителя SDR");
        return;
      }
      if (s.scanPattern === "auto" && s.attackPaint) {
        const refuse = paintRefuseReason(s.attackPaint, s.sdrBands, s.sdrLoadOk);
        if (refuse) {
          pushLog("sys", refuse);
          return;
        }
      }
      if (!s.sdrOpened) {
        await get().openSdr();
        if (!get().sdrOpened) return;
      }
      const canTx = gLive ? catalogCaps(get().sdrId).canTx : gSdr.canTx();
      if (!canTx) {
        pushLog("sys", "ПЕРЕДАТЬ: у этого SDR нет TX — усилитель подключать некуда");
        return;
      }
      set({ transmitArmed: true });
      const work = planSdrWork(get().scanPattern, get().autoDispatch);
      pushLog("sys", `ПЕРЕДАТЬ: ${work.reason}`);
      stopTxWatch();
      if (gLive) {
        gTxWatch = setInterval(() => {
          void (async () => {
            if (!get().transmitArmed || !gLive || gResense) return;
            const h = await hostHealth();
            if (gResense) return;
            const armedOnAir = get().lastForwardMhz != null;
            if (h.txError || (armedOnAir && h.txLive === false)) {
              pushLog("sys", h.txError || "SDR TX поток мёртв — HUD снят");
              await get().stopTransmit();
            }
          })();
        }, 1000);
      }
      if (work.openLoopTx) {
        get().stopScan();
        startOpenLoopTx();
        return;
      }
      if (get().scanPattern === "auto" && get().attackPaint) {
        const ok = await fireAttackPaintTx();
        if (!ok) {
          set({ transmitArmed: false, attackTxUntil: null });
          stopTxWatch();
          gGate.reset();
          return;
        }
        if (!get().scanRunning) get().startScan();
        return;
      }
      const alreadyScanning = get().scanRunning;
      if (!alreadyScanning) {
        get().startScan();
        return;
      }
      const raw = clipToAllowlist(detectFromBins(get().scanBins, get().scanThresholdDb), get().sdrBands);
      const dispatch = get().autoDispatch;
      const live =
        dispatch === "priority"
          ? withoutOwnTx(raw, get().lastForwardMhz, ownTxGuardMhz(get().txWaveKind !== null))
          : raw;
      const target = pickArmedAutoTarget({
        liveWindow: live,
        archive: get().detections,
        heldMhz: gGate.lastCuedMhz,
        heldPowerDbm: get().lastForwardPowerDbm,
        skipMhz: gSkipMhz,
        dispatch,
        holdMasked: dispatch === "priority" && gGate.lastCuedMhz != null,
      });
      if (target) runHandoff(target.freqMhz, target.powerDbm);
    },

    stopTransmit: async () => {
      gTxGen += 1;  // in-flight handoff/re-sense после этого не коммитятся
      stopTxWatch();
      stopTxWalk();
      clearAttackHoldTimer();
      gAttackLastTxEnd = Date.now();
      gAttackTracker.markHeld(null);
      gResense = false;
      gSkipMhz = null;
      set({ transmitArmed: false, signalTxActive: false, attackTxUntil: null });
      gGate.reset();
      if (get().fpgaArmed || get().fpgaStopPending) await get().fpgaDisarm();
      if (gLive) await hostTxOff();
      gSdr.txOff();
      set({
        lastSdrTxUs: null,
        lastForwardMhz: null,
        lastForwardPowerDbm: null,
        sdrHoldSince: null,
        lastCueReason: "SDR TX остановлен",
        attackTracks: get().scanPattern === "auto" ? gAttackTracker.snapshot() : get().attackTracks,
      });
      pushLog("sys", "SDR TX остановлен (ESP32 не тронут)");
    },

    resetSdrLock: async () => {
      const skip = gGate.lastCuedMhz ?? get().lastForwardMhz;
      if (skip == null && !get().transmitArmed) {
        pushLog("sys", "СБРОСИТЬ: замка нет");
        return;
      }
      gSkipMhz = skip;
      gTxGen += 1;
      gGate.reset();
      set({
        lastForwardMhz: null,
        lastForwardPowerDbm: null,
        lastSdrTxUs: null,
        sdrHoldSince: null,
        lastCueReason: "оператор сбросил частоту — ждём следующий живой сигнал",
      });
      if (gLive) await hostTxOff();
      gSdr.txOff();
      pushLog(
        "sys",
        skip != null
          ? `СБРОСИТЬ: оператор снял ${skip.toFixed(3)} МГц — систему не переключаем`
          : "СБРОСИТЬ: замок снят оператором",
      );
    },
  };
});

function mhzAsDet(mhz: number, powerDbm = 0): import("../sdr/types").Detection {
  return { freqMhz: mhz, powerDbm, noiseDbm: 0, snrDb: 0, ts: 0, forwarded: false };
}
