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
import { defaultFlashName, planEthernet, sdrOpenArgs } from "../sdr/official";
import { catalogById } from "../sdr/catalog";
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
  hostScan,
  hostTx,
  hostTxOff,
  hostTxWave,
  hostFpga,
  markCatalogPresent,
  requireHwForSdr,
  type FpgaStatus,
} from "../sdr/hostClient";
import { detectFromBins, hostScanSpanMhz } from "../sdr/backend";
import type { Detection, FlashResult, ScanBin, SdrDeviceInfo } from "../sdr/types";
import { defaultParams, type WaveKind } from "../sdr/waveforms";
import { isTauriRuntime } from "../transport/types";
import { HandoffGate, planHandoff, type HandoffPlan } from "../sense/fastpath";
import {
  FPGA_AIR_GONE_POLLS,
  FPGA_DEFAULT_DET_THR,
  FPGA_DET_THR_K,
  FPGA_DET_WIN_SAMPLES,
  FPGA_DET_WINDOWS,
  FPGA_US_DET_SHIFT,
  clampDetShift,
  captureParkMhz,
  detThrFromMedian,
  fpgaAirSupported,
  fpgaArmCmd,
  fpgaObserveLine,
  ncoFtwFromFrac,
  planFpgaAir,
} from "../sense/fpgaFastpath";
import {
  heldHitAlive,
  pickArmedAutoTarget,
  refreshSkipMhz,
  RESENSE_MS,
  shouldContinuePriorityTick,
} from "../sense/hold";
import {
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
  sameBin,
  withoutOwnTx,
} from "../sense/orchestrator";
import { clampWindowMhz, clipToAllowlist, ScanWalker, type ScanPattern } from "../sense/scan";
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
  // SCAN RX
  scanRunning: boolean;
  scanThresholdDb: number;
  /** 0 = все подряд, 100 = только сильные. */
  scanSensitivity: number;
  scanPattern: ScanPattern;
  /** АВТО: приоритет = сильнейшая живая (сильнее перехватывает); обычный = очередь. */
  autoDispatch: AutoDispatch;
  scanWindowMhz: string;
  scanDwellMs: string;
  sdrHoldSince: number | null;
  scanCenterMhz: number | null;
  scanBins: ScanBin[];
  detections: Detection[];
  lastInterceptMhz: number | null;
  lastCueReason: string;
  lastSdrTxUs: number | null;
  lastForwardPowerDbm: number | null;
  // ТИП СИГНАЛА (baseband → SDR, нагрузка 50 Ом)
  signalKind: WaveKind;
  signalParams: Record<string, number>;
  signalFreqMhz: string;
  /** TX именно сигнальной волны — взаимоисключение со сканером-оркестратором. */
  signalTxActive: boolean;
  /** Зашитая волна для ВСЕХ TX-путей SDR (АВТО/ПРИОРИТЕТ, open-loop). null = CW тон. */
  txWaveKind: WaveKind | null;
  txWaveParams: Record<string, number>;
  // FPGA-ревизия legion (bladeRF 1 x40): автономный тракт в FPGA
  fpgaMode: "player" | "nco" | "lb_gated" | "lb_always";
  fpgaArmed: boolean;
  fpgaBusy: boolean;
  fpgaStatus: FpgaStatus | null;
  /** Токен шлюза (LEGION_FPGA_TOKEN на агенте); пустой = открытая LAN стенда. */
  fpgaToken: string;
  /** Порог средней энергии I²+Q² для lb_gated. 0 шлюз отвергает. */
  fpgaDetThr: number;
  /** win_shift 4..12. По умолчанию 4 → 16 сэмплов @ 2 МГц = 8 µs. */
  fpgaDetShift: number;
  /** Главный старт: только FPGA или эфир+FPGA. null — не с главного кадра. */
  fpgaPath: "solo" | "air" | null;
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
  fpgaArm(): Promise<void>;
  /** Главный кадр: ARM ревизии legion. air = lb_gated, solo = nco/player. */
  startFpgaPath(path: "solo" | "air"): Promise<boolean>;
  fpgaDisarm(): Promise<void>;
  /** Операторский СТОП режима FPGA+сканер: скан стоп + DISARM + USB хосту. */
  stopFpgaAir(): Promise<void>;
  fpgaPollStatus(): Promise<void>;
  clearLog(): void;
}

const MAX_LOG = 500;

let gTransport: Transport | null = null;
let gClient: LegionClient | null = null;
const gSdr = new MockSdrBackend();
let gLive = false;
let gWalker: ScanWalker | null = null;
let gScanTimer: ReturnType<typeof setInterval> | null = null;
let gTxWalk: ReturnType<typeof setInterval> | null = null;

function stopTxWalk(): void {
  if (gTxWalk) {
    clearInterval(gTxWalk);
    gTxWalk = null;
  }
}
let gTxWatch: ReturnType<typeof setInterval> | null = null;
/** Heartbeat ноутбука → FPGA watchdog (deadman end-to-end, 2 Гц). */
let gFpgaKick: ReturnType<typeof setInterval> | null = null;
/** Телеметрия наблюдения (не тракт): ноутбук читает статус, конвейер на SDR. */
let gFpgaObserve: ReturnType<typeof setInterval> | null = null;
/** Двойной клик ЗАШИТЬ в async-окне между кликом и set(transmitArmed). */
let gSignalBusy = false;
const gGate = new HandoffGate();

function stopFpgaKick(): void {
  if (gFpgaKick) {
    clearInterval(gFpgaKick);
    gFpgaKick = null;
  }
}

function stopFpgaObserve(): void {
  if (gFpgaObserve) {
    clearInterval(gFpgaObserve);
    gFpgaObserve = null;
  }
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

/** HDL: без capture_done плеер гонит нули (legion_player.vhd).
 *  acceptance_bench E3 проверяет флаг до ARM. sleep — не доказательство. */
export function fpgaPlayerReady(st: {
  ok?: boolean;
  capture_done?: boolean;
  reason?: string;
}): string | null {
  if (!st.ok) return st.reason ?? "FPGA: статус недоступен — capture не подтверждён";
  if (!st.capture_done) return "FPGA player: capture_done=0 — в RAM нет волны, ARM нельзя";
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
/** FPGA+сканер: handoff в полёте (один за раз — USB и LO общие). */
let gFpgaHandoffBusy = false;
/** Частота, на которой handoff упал, и когда — ретрай через паузу, не вплотную. */
let gHandoffFailMhz: number | null = null;
let gHandoffFailAt = 0;
/** Автовозврат из ARM: det_count не растёт N опросов подряд = энергия пропала. */
let gLastDetCount: number | null = null;
let gDetStagnantPolls = 0;
/** Пауза перед повторным handoff на частоту, где он упал (мс). */
const FPGA_HANDOFF_RETRY_MS = 10_000;
/** Поколение авто-цикла FPGA+сканер: инкрементит операторский СТОП.
 *  Handoff сверяет поколение после await ARM — сменилось, значит оператор
 *  стопнул в полёте: не коммитим ARM, откатываемся (паттерн gTxGen). */
let gFpgaAirGen = 0;
/** Реентерабельность возврата: два опроса подряд не должны звать её вместе. */
let gFpgaReturnBusy = false;
/** Поколение TX-эпохи. Инкрементируют stopTransmit/closeSdr/resetSdrLock/
 *  setSdrEmulation/setSdrLoad(false). In-flight handoff/re-sense сверяют
 *  поколение после await: сменилось — не коммитим и не восстанавливаем TX
 *  (найдено аудитом гонок: TX оживал после СТОП). */
let gTxGen = 0;

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

  const beginFpgaKick = (): void => {
    stopFpgaKick();
    stopFpgaObserve();
    gFpgaKick = setInterval(() => {
      void hostFpga({ op: "kick", token: get().fpgaToken }, get().sdrGateway).then((kr) => {
        if (!kr.ok) {
          pushLog("sys", `FPGA heartbeat не дошёл: ${kr.reason ?? "?"} — шлём DISARM, watchdog гасит TX если шлюз мёртв`);
          if (isFpgaAirPattern(get().scanPattern) && get().fpgaMode === "lb_gated") {
            // Авто-цикл: канал мёртв → возврат к скану (TX уже гаснет железом).
            void fpgaReturnToScan(null);
          } else {
            void get().fpgaDisarm();
          }
        }
      });
    }, 500);
    gFpgaObserve = setInterval(() => {
      void get().fpgaPollStatus();
    }, 400);
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
      lastCueReason: `авто → ${plan.freqMhz.toFixed(3)} МГц на усилитель · ${wave} · ${sdrUs} µs host`,
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
      if (gLive) await hostTxOff();
      else gSdr.txOff();
      let bins: ScanBin[] = [];
      if (gLive) {
        const win = await hostScan(heldMhz, hostScanSpanMhz(catalogCaps(get().sdrId).analogBwMhz), nBins);
        if (!win.ok) {
          pushLog("sys", win.reason || "re-sense fail — возвращаем TX");
          await restoreHeldTx(heldMhz);
          return "error";
        }
        bins = win.bins;
      } else {
        bins = gSdr.scanWindow(heldMhz, hostScanSpanMhz(gSdr.analogBwMhz()), nBins);
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
    const band = parseBand(s.sdrF1, s.sdrF2);
    return band ? [band] : [];
  };

  const ensureSdrBand = (): boolean => {
    const s = get();
    if (s.sdrBands.length > 0) return true;
    const band = parseBand(s.sdrF1, s.sdrF2);
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

  const parkFpgaLo = async (opts: {
    midMhz: number;
    analogMhz: number;
    spanMhz: number;
    rx: boolean;
    fsHz: number;
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
      const win = Math.min(opts.analogMhz, Math.max(2, opts.spanMhz || opts.analogMhz));
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

  /** Возврат в скан-фазу цикла FPGA+сканер: DISARM → USB хосту → скан.
   *  skipMhz — частота, которую сканер пропускает (энергия пропала: не
   *  цепляемся за мёртвую; refreshSkipMhz снимет skip, когда она замолчит
   *  окончательно и оживёт вновь). null — без skip (watchdog/оператор). */
  const fpgaReturnToScan = async (skipMhz: number | null, restart = true): Promise<void> => {
    if (gFpgaReturnBusy) return; // два опроса подряд — один возврат
    gFpgaReturnBusy = true;
    try {
      stopFpgaKick();
      stopFpgaObserve();
      if (get().fpgaArmed) {
        // На micro NIOS сам уводит RFIC в standby по CTRL=0 (legion_cmds.c).
        await hostFpga({ op: "disarm", token: get().fpgaToken }, get().sdrGateway);
      }
      set({ fpgaArmed: false, fpgaPath: null, fpgaBusy: false, lastForwardMhz: null });
      gLastDetCount = null;
      gDetStagnantPolls = 0;
      // USB обратно хосту; startScan ниже сам переоткроет SDR (openSdr).
      await hostFpga({ op: "usb", action: "release", token: get().fpgaToken }, get().sdrGateway);
      gSkipMhz = skipMhz;
      // restart=false: оператор стопнул в полёте — чистимся, но скан не
      // рестартим (его решение, не таймаут).
      if (restart && isFpgaAirPattern(get().scanPattern)) {
        // Отложенно: из fpgaHandoff.fail мы ещё внутри handoff (gFpgaHandoffBusy),
        // и startScan честно отказал бы — пусть finally сначала снимет флаги.
        setTimeout(() => {
          if (isFpgaAirPattern(get().scanPattern) && !get().fpgaArmed && !get().fpgaBusy) {
            get().startScan();
          }
        }, 0);
      }
    } finally {
      gFpgaReturnBusy = false;
    }
  };

  /** Handoff скан→FPGA: парковка LO на пик (2 MSPS, BW 2 МГц) → порог из
   *  шумовой полки (медиана нижних 60% окон × K) → USB агенту → ARM lb_gated.
   *  Отказ на любом шаге → возврат к скану (частота помечается для ретрая
   *  через FPGA_HANDOFF_RETRY_MS, не вплотную). */
  const fpgaHandoff = async (mhz: number, powerDbm: number): Promise<void> => {
    if (gFpgaHandoffBusy) return;
    gFpgaHandoffBusy = true;
    const airGen = gFpgaAirGen;
    const txGen = gTxGen;
    set({ fpgaBusy: true });
    const gw = (cmd: Record<string, unknown>) =>
      hostFpga({ ...cmd, token: get().fpgaToken }, get().sdrGateway);
    const fail = async (why: string): Promise<void> => {
      pushLog("sys", `FPGA handoff ${mhz.toFixed(3)} МГц: ${why} — возврат к скану`);
      gHandoffFailMhz = mhz;
      gHandoffFailAt = Date.now();
      // Отозванный в полёте handoff (СТОП/closeSdr/…): чистимся, но скан
      // не рестартим — оператор уже решил (ревью 2026-08-28).
      await fpgaReturnToScan(null, !revoked());
    };
    // Отзыв намерения в полёте (паттерн gTxGen из runHandoffAsync): СТОП
    // (gFpgaAirGen) или closeSdr/stopTransmit/снятие нагрузки (gTxGen).
    // Скан не рестартим — бампер уже решил, что дальше.
    const revoked = (): boolean => gTxGen !== txGen || gFpgaAirGen !== airGen;
    const abortIfRevoked = async (stage: "pre" | "acquired" | "armed"): Promise<boolean> => {
      if (!revoked()) return false;
      pushLog("sys", `FPGA handoff ${mhz.toFixed(3)} МГц: отменён оператором в полёте (${stage})`);
      if (stage === "armed") await gw({ op: "disarm" });
      if (stage !== "pre") await gw({ op: "usb", action: "release" });
      set({ fpgaArmed: false, fpgaPath: null, lastForwardMhz: null });
      return true;
    };
    try {
      if (!gLive) {
        await fail("SDR не открыт");
        return;
      }
      // Тики скана стоп: in-flight tick увидит scanRunning=false и выйдет.
      get().stopScan();
      // Шумовая полка меряется с ОТСТРОЙКОЙ от пика: на самом пике
      // непрерывный сигнал живёт в каждом окне, и медиана стала бы энергией
      // сигнала — порог выше сигнала, гейт глухой навсегда. Тот же fs/BW и
      // то же (пиннованое) усиление — полка переносима.
      const row = catalogById(get().sdrId);
      const capMhz = captureParkMhz(mhz, row?.rxMhz?.[1] ?? 6000, row?.rxMhz?.[0] ?? 70);
      const pkCap = await hostPark(capMhz, 2, FPGA_FS_HZ, true, false);
      if (!pkCap.ok || pkCap.fake) {
        await fail(pkCap.fake ? "FAKE park — не эфир, ARM нельзя" : `park захвата: ${pkCap.reason}`);
        return;
      }
      if (await abortIfRevoked("pre")) return;
      const cap = await hostDetCapture(FPGA_DET_WIN_SAMPLES, FPGA_DET_WINDOWS);
      const detThr = cap.ok ? detThrFromMedian(cap.medianEnergy ?? 0) : 0;
      if (!cap.ok || !(detThr > 0)) {
        await fail(cap.ok ? `порог 0 (медиана полки ${cap.medianEnergy})` : cap.reason);
        return;
      }
      // Операционная парковка на пик (на x40 это и есть рабочий LO; на micro
      // LO при ARM выставит NIOS по freq_mhz — парк тут для readback-честности).
      const pk = await hostPark(mhz, 2, FPGA_FS_HZ, true, true);
      if (!pk.ok || pk.fake) {
        await fail(pk.fake ? "FAKE park — не эфир, ARM нельзя" : pk.reason || "park не удался");
        return;
      }
      if (await abortIfRevoked("pre")) return;
      await releaseSoapyForFpga();
      const acq = await gw({ op: "usb", action: "acquire" });
      if (!acq.ok) {
        await fail(`USB acquire: ${acq.reason ?? "отказ"}`);
        return;
      }
      if (await abortIfRevoked("acquired")) return;
      const armCmd = fpgaArmCmd("lb_gated", {
        detThr,
        detShift: FPGA_US_DET_SHIFT,
        token: get().fpgaToken,
        freqMhz: mhz,
      });
      // Усиление, при котором мерилась полка, — NIOS поставит ровно его.
      if (pk.rxGainDb !== undefined && Number.isFinite(pk.rxGainDb)) {
        armCmd.gain_db = Math.round(pk.rxGainDb);
      }
      const r = await gw(armCmd);
      if (!r.ok) {
        await gw({ op: "usb", action: "release" });
        await fail(r.reason ?? "ARM отказ");
        return;
      }
      if (await abortIfRevoked("armed")) return;
      gSkipMhz = null;
      gHandoffFailMhz = null;
      gLastDetCount = null;
      gDetStagnantPolls = 0;
      set({
        fpgaArmed: true,
        fpgaPath: "air",
        lastForwardMhz: mhz,
        lastForwardPowerDbm: powerDbm,
        sdrHoldSince: Date.now(),
        lastCueReason: `FPGA lb_gated · ${mhz.toFixed(3)} МГц · окно 8 мкс · порог ${detThr} (полка ×${FPGA_DET_THR_K})`,
      });
      pushLog(
        "sys",
        `FPGA+сканер: ARM lb_gated ${mhz.toFixed(3)} МГц · det_thr=${detThr} · конвейер на SDR, ноутбук наблюдает`,
      );
      beginFpgaKick();
    } finally {
      set({ fpgaBusy: false });
      gFpgaHandoffBusy = false;
    }
  };

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
    scanRunning: false,
    scanThresholdDb: 12,
    scanSensitivity: thresholdToSensitivity(12),
    scanPattern: "auto",
    autoDispatch: "turn",
    scanWindowMhz: "20",
    scanDwellMs: "40",
    scanCenterMhz: null,
    scanBins: [],
    detections: [],
    lastInterceptMhz: null,
    lastCueReason: "",
    lastSdrTxUs: null,
    lastForwardPowerDbm: null,
    signalKind: "qpsk",
    signalParams: defaultParams("qpsk"),
    signalFreqMhz: "2442.000",
    signalTxActive: false,
    txWaveKind: null,
    txWaveParams: {},
    fpgaMode: "player",
    fpgaArmed: false,
    fpgaBusy: false,
    fpgaStatus: null,
    fpgaToken: "",
    fpgaDetThr: FPGA_DEFAULT_DET_THR,
    fpgaDetShift: FPGA_US_DET_SHIFT,
    fpgaPath: null,
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
    setSdrId: (id) =>
      set({
        sdrId: id,
        sdrFlashName: defaultFlashName(id) || get().sdrFlashName,
        // Не перезаполняем IP шлюза при смене устройства: пустое = локальный USB,
        // подсказка-IP видна в placeholder поля. Иначе молча уезжаем в remote.
        sdrGateway: get().sdrGateway,
        sdrFlashConfirm: false,
      }),
    setSdrGateway: (v) => set({ sdrGateway: v }),
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
      // Смена бэкенда = новая эпоха. DISARM дожидаемся: иначе Soapy/мок
      // переключаются, а FPGA ещё держит TX до watchdog.
      void (async () => {
        gTxGen += 1;
        stopTxWatch();
        stopTxWalk();
        if (get().fpgaArmed) await get().fpgaDisarm();
        else {
          stopFpgaKick();
          stopFpgaObserve();
          set({ fpgaArmed: false });
        }
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
    setScanPattern: (p) => set({ scanPattern: p }),
    setAutoDispatch: (d) => set({ autoDispatch: d }),
    setScanWindowMhz: (v) => set({ scanWindowMhz: v }),
    setScanDwellMs: (v) => set({ scanDwellMs: v }),
    clearLog: () => set({ log: [] }),

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
        pushLog("sys", `ports list failed: ${String(e)}`);
      }
    },

    connect: async () => {
      const { transportKind, selectedPort, wsUrl } = get();
      await get().disconnect();

      switch (transportKind) {
        case "tauri-serial":
          if (!selectedPort) {
            pushLog("sys", "no serial port selected");
            return;
          }
          gTransport = new TauriSerialTransport(selectedPort);
          break;
        case "htool-sl22":
          if (!selectedPort) {
            pushLog("sys", "no serial port selected");
            return;
          }
          set({ corrMode: "SWEEP" });
          gTransport = new Sl22Transport(selectedPort);
          pushLog("sys", "HTOOL SL22: SCPI bridge (no ESP32/ADF4351)");
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
        pushLog("sys", `engine event: ${e.event}`);
        if (e.event === "GLIDE DONE") {
          // GLIDE — одноразовый: по завершении движок сам останавливается
          set({ corridorRunning: false, telemFreq: null });
        }
      };
      gClient.onStateChange = (st, detail) => {
        set({ transportState: st, transportDetail: detail });
        pushLog("sys", `transport: ${st}${detail ? ` (${detail})` : ""}`);
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
        pushLog("sys", `connect failed: ${String(e)}`);
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
      const blocked = modeConflict("esp32", false, get().transmitArmed, get().fpgaArmed);
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
      const blocked = modeConflict("esp32", false, get().transmitArmed, get().fpgaArmed);
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
      const blocked = modeConflict("esp32", false, get().transmitArmed, get().fpgaArmed);
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
      const blocked = modeConflict("esp32", false, get().transmitArmed, get().fpgaArmed);
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
      const blocked = modeConflict("esp32", false, get().transmitArmed, get().fpgaArmed);
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
      const band = parseBand(s.sdrF1, s.sdrF2);
      if (!band) {
        pushLog("sys", "SDR allowlist: неверная полоса (34.375–4400 МГц, f1≤f2)");
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
        if (gLive) void hostTxOff();
        else gSdr.txOff();
        // stopFpgaAir = disarm + USB хосту: после интерлока система в чистом
        // состоянии хоста (fpgaDisarm один оставлял бы USB у агента).
        if (get().fpgaArmed) void get().stopFpgaAir();
        set({
          lastForwardMhz: null,
          lastForwardPowerDbm: null,
          lastSdrTxUs: null,
          sdrHoldSince: null,
          lastCueReason: "нагрузка снята — SDR TX погашен",
        });
      }
      pushLog(
        "sys",
        ok ? "SDR: нагрузка 50 Ом на выходе усилителя SDR" : "SDR: нагрузка снята — TX погашен",
      );
    },

    applyPaCurrent: async () => {
      const blocked = modeConflict("esp32", false, get().transmitArmed, get().fpgaArmed);
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
        const blocked = modeConflict("esp32", false, get().transmitArmed, get().fpgaArmed);
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
      const blocked = modeConflict("esp32", false, get().transmitArmed, get().fpgaArmed);
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
      if (s.fpgaArmed) {
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
        // Волна зашита: теперь её используют и АВТО/ПРИОРИТЕТ, и open-loop TX.
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
      pushLog("sys", "TX-контент снят: АВТО/ПРИОРИТЕТ и open-loop снова на CW тоне");
    },

    setFpgaMode: (m) => set({ fpgaMode: m }),

    setFpgaToken: (v) => set({ fpgaToken: v }),

    setFpgaDetThr: (v) => set({ fpgaDetThr: Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0 }),

    setFpgaDetShift: (v) => set({ fpgaDetShift: clampDetShift(v) }),

    fpgaArm: async () => {
      const s = get();
      if (s.fpgaBusy) return;
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
      if (board.switched) {
        get().setSdrId(board.sdrId);
        pushLog("sys", board.reason);
      }
      if (get().fpgaMode === "lb_gated") {
        const airPlan = planFpgaAir({
          sdrId: get().sdrId,
          analogBwMhz: catalogCaps(get().sdrId).analogBwMhz,
          bands: bandsForFpgaAir(),
          loadOk: get().sdrLoadOk,
          detThr: get().fpgaDetThr,
          detShift: get().fpgaDetShift,
        });
        if (!airPlan.ok) {
          pushLog("sys", airPlan.reason);
          return;
        }
      }
      get().stopScan();
      if (get().transmitArmed || get().signalTxActive) await get().stopTransmit();
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
      const pingNo = fpgaGatewayRefused(ping);
      if (pingNo) {
        pushLog("sys", pingNo);
        return;
      }
      if (mode === "player") {
        const st = await gw({ op: "status" });
        const noWave = fpgaPlayerReady(st);
        if (noWave) {
          pushLog("sys", noWave);
          return;
        }
      }
      set({ fpgaBusy: true });
      try {
        const pk = await parkFpgaLo({
          midMhz: mid,
          analogMhz: analog,
          spanMhz: span,
          rx: air,
          fsHz: FPGA_FS_HZ,
          gw,
        });
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
        });
        const r = await gw(cmd);
        pushLog("sys", `FPGA ARM (${mode}): ${r.reason ?? (r.ok ? "ок" : "отказ")}`);
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
                }).reason
              : air
                ? `FPGA · ${mode} · антенна→усилитель · ${mid.toFixed(3)} МГц · ${formatDetWindow(pk.fsHz)}`
                : `FPGA · ${mode} · ${mid.toFixed(3)} МГц`;
          set({
            fpgaArmed: true,
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
      if (s0.fpgaBusy) return false;
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
      if (board.switched) {
        get().setSdrId(board.sdrId);
        pushLog("sys", board.reason);
      }
      if (!ensureSdrBand()) return false;

      get().stopScan();
      if (get().transmitArmed || get().signalTxActive) await get().stopTransmit();

      const bands = get().sdrBands;
      const f1 = bands.length ? Math.min(...bands.map((b) => b.f1Mhz)) : parseFloat(get().sdrF1);
      const f2 = bands.length ? Math.max(...bands.map((b) => b.f2Mhz)) : parseFloat(get().sdrF2);
      const mid = (f1 + f2) / 2;
      const analog = catalogCaps(get().sdrId).analogBwMhz;
      const span = Math.max(f2 - f1, 0);
      if (span > analog) {
        pushLog(
          "sys",
          `FPGA: коридор ${span.toFixed(1)} МГц шире окна ${analog} МГц — чип видит центр ${mid.toFixed(3)}, не обход F1–F2`,
        );
      }

      const gw = (cmd: Record<string, unknown>) =>
        hostFpga({ ...cmd, token: get().fpgaToken }, get().sdrGateway);

      const ping = await gw({ op: "ping" });
      const pingNo = fpgaGatewayRefused(ping);
      if (pingNo) {
        pushLog("sys", pingNo);
        return false;
      }

      set({ fpgaBusy: true, fpgaPath: path });
      try {
        if (path === "air") {
          set({ fpgaMode: "lb_gated" });
          const airPlan = planFpgaAir({
            sdrId: get().sdrId,
            analogBwMhz: analog,
            bands: bandsForFpgaAir(),
            loadOk: get().sdrLoadOk,
            detThr: get().fpgaDetThr,
            detShift: get().fpgaDetShift,
          });
          if (!airPlan.ok) {
            pushLog("sys", airPlan.reason);
            set({ fpgaPath: null });
            return false;
          }
          const pk = await parkFpgaLo({
            midMhz: mid,
            analogMhz: analog,
            spanMhz: span,
            rx: true,
            fsHz: FPGA_FS_HZ,
            gw,
          });
          if (!pk.ok) {
            set({ fpgaPath: null });
            return false;
          }
          const r = await gw({
            op: "arm",
            mode: "lb_gated",
            wd: true,
            det_thr: get().fpgaDetThr,
            det_shift: get().fpgaDetShift,
            freq_mhz: mid,
          });
          pushLog("sys", `FPGA ARM (lb_gated): ${r.reason ?? (r.ok ? "ок" : "отказ")}`);
          if (!r.ok) {
            set({ fpgaPath: null });
            return false;
          }
          set({
            fpgaArmed: true,
            lastForwardMhz: mid,
            lastSdrTxUs: null,
            lastCueReason: `${airPlan.reason} · ${mid.toFixed(3)} МГц · ${formatDetWindow(pk.fsHz)}`,
          });
          beginFpgaKick();
          return true;
        }

        const kind = get().txWaveKind ?? get().signalKind;
        const useNco = kind === "sine" || kind === "tone";
        if (useNco) {
          set({ fpgaMode: "nco" });
          const pk = await parkFpgaLo({
            midMhz: mid,
            analogMhz: analog,
            spanMhz: span,
            rx: false,
            fsHz: FPGA_FS_HZ,
            gw,
          });
          if (!pk.ok) {
            set({ fpgaPath: null });
            return false;
          }
          const ftw = ncoFtwFromFrac(Number(get().signalParams.fj));
          await gw({ op: "set", reg: "nco_ftw", value: ftw });
          const r = await gw({ op: "arm", mode: "nco", wd: true, nco_ftw: ftw, freq_mhz: mid });
          pushLog("sys", `FPGA ARM (nco): ${r.reason ?? (r.ok ? "ок" : "отказ")}`);
          if (!r.ok) {
            set({ fpgaPath: null });
            return false;
          }
          set({
            fpgaArmed: true,
            lastForwardMhz: mid,
            lastSdrTxUs: null,
            lastCueReason: `FPGA · NCO ${kind} · ${mid.toFixed(3)} МГц · без эфира`,
          });
          beginFpgaKick();
          return true;
        }

        set({ fpgaMode: "player" });
        await gw({ op: "set", reg: "player_len", value: 4095 });
        await gw({ op: "set", reg: "player_ctl", value: 1 });
        await gw({ op: "usb", action: "release" });
        if (!get().sdrEmulation && hostSdrAvailable()) {
          await get().openSdr({ requireHw: requireHwForSdr(get().sdrId) || undefined });
          if (!gLive) {
            pushLog("sys", "FPGA player: SDR не открылся — capture отменён");
            set({ fpgaPath: null });
            const acq0 = await gw({ op: "usb", action: "acquire" });
            if (!acq0.ok) pushLog("sys", `FPGA USB acquire: ${acq0.reason ?? "отказ"}`);
            return false;
          }
          const tx = await hostTxWave(mid, kind, get().signalParams);
          pushLog("sys", tx.reason);
          if (tx.fake) {
            await releaseSoapyForFpga();
            const acq0 = await gw({ op: "usb", action: "acquire" });
            if (!acq0.ok) pushLog("sys", `FPGA USB acquire: ${acq0.reason ?? "отказ"}`);
            set({ fpgaPath: null });
            pushLog("sys", "FPGA player: FAKE TX — волна не в эфире, ARM отменён");
            return false;
          }
          if (!tx.ok) {
            await releaseSoapyForFpga();
            const acq0 = await gw({ op: "usb", action: "acquire" });
            if (!acq0.ok) pushLog("sys", `FPGA USB acquire: ${acq0.reason ?? "отказ"}`);
            set({ fpgaPath: null });
            return false;
          }
          // 4096 сэмплов @ 2 MSPS ≈ 2 мс. sleep только даёт стриму дойти,
          // доказательство — capture_done после acquire (HDL / E3).
          await waitMs(50);
          await releaseSoapyForFpga();
        } else {
          pushLog("sys", "FPGA player: нет Soapy — волну в RAM не загрузить, ARM отменён");
          set({ fpgaPath: null });
          const acq = await gw({ op: "usb", action: "acquire" });
          if (!acq.ok) pushLog("sys", `FPGA USB acquire: ${acq.reason ?? "отказ"}`);
          return false;
        }
        const acq = await gw({ op: "usb", action: "acquire" });
        if (!acq.ok) {
          pushLog("sys", `FPGA USB acquire: ${acq.reason ?? "отказ"}`);
          set({ fpgaPath: null });
          return false;
        }
        const cap = await gw({ op: "status" });
        const noWave = fpgaPlayerReady(cap);
        if (noWave) {
          pushLog("sys", noWave);
          set({ fpgaPath: null });
          return false;
        }
        const r = await gw({ op: "arm", mode: "player", wd: true, freq_mhz: mid });
        pushLog("sys", `FPGA ARM (player): ${r.reason ?? (r.ok ? "ок" : "отказ")}`);
        if (!r.ok) {
          set({ fpgaPath: null });
          return false;
        }
        set({
          fpgaArmed: true,
          lastForwardMhz: mid,
          lastSdrTxUs: null,
          lastCueReason: `FPGA · player «${kind}» · ${mid.toFixed(3)} МГц · без эфира`,
        });
        beginFpgaKick();
        return true;
      } finally {
        set({ fpgaBusy: false });
        if (!get().fpgaArmed && get().fpgaPath) set({ fpgaPath: null });
      }
    },

    fpgaDisarm: async () => {
      stopFpgaKick();
      stopFpgaObserve();
      set({ fpgaBusy: true });
      try {
        const r = await hostFpga({ op: "disarm", token: get().fpgaToken }, get().sdrGateway);
        pushLog("sys", `FPGA DISARM: ${r.reason ?? (r.ok ? "ок" : "отказ")}`);
        if (r.ok) set({ fpgaArmed: false, fpgaPath: null });
      } finally {
        set({ fpgaBusy: false });
      }
    },

    stopFpgaAir: async () => {
      // Операторский СТОП режима FPGA+сканер: скан стоп, DISARM, USB хосту.
      // Авто-рестарта скана нет — решение оператора, не таймаут.
      gFpgaAirGen += 1; // handoff в полёте увидит смену поколения и откачет ARM
      get().stopScan();
      if (get().fpgaArmed || get().fpgaBusy) {
        await get().fpgaDisarm();
        await hostFpga({ op: "usb", action: "release", token: get().fpgaToken }, get().sdrGateway);
        set({ lastForwardMhz: null });
        if (!get().sdrOpened && !get().sdrEmulation) await get().openSdr();
      }
      gLastDetCount = null;
      gDetStagnantPolls = 0;
      gHandoffFailMhz = null;
    },

    fpgaPollStatus: async () => {
      const r = await hostFpga({ op: "status", token: get().fpgaToken }, get().sdrGateway);
      set({ fpgaStatus: r });
      // Watchdog сработал в FPGA → TX уже погашен железом; синхронизируем UI
      if (r.ok && get().fpgaArmed && get().fpgaMode === "lb_gated") {
        set({ lastCueReason: fpgaObserveLine(r) });
      }
      const autoAir =
        isFpgaAirPattern(get().scanPattern) && get().fpgaArmed && get().fpgaMode === "lb_gated";
      if (r.ok && r.wd_fired && get().fpgaArmed) {
        pushLog("sys", "FPGA: watchdog погасил TX (heartbeat пропадал) — UI снял ARM");
        // CTRL.ARM в FPGA после wd_fired всё ещё взведён, а expired липкий —
        // без DISARM (CTRL=0) следующий ARM молчал бы навсегда.
        if (autoAir) {
          // Авария транспорта, не эфир: возврат к скану без skip частоты.
          pushLog("sys", "FPGA+сканер: watchdog — DISARM, возврат к скану");
          await fpgaReturnToScan(null);
        } else {
          stopFpgaKick();
          stopFpgaObserve();
          await hostFpga({ op: "disarm", token: get().fpgaToken }, get().sdrGateway);
          set({ fpgaArmed: false, fpgaPath: null });
        }
        return;
      }
      // Автовозврат «энергия пропала»: det_count не растёт N опросов подряд.
      // Уровень det_active семплировался бы с пропусками коротких гейтов —
      // счётчик монотонен и от фазы опроса не зависит.
      if (autoAir && r.ok && !gFpgaHandoffBusy) {
        const dc = r.det_count ?? 0;
        if (gLastDetCount !== null && dc === gLastDetCount) {
          gDetStagnantPolls += 1;
        } else {
          gDetStagnantPolls = 0;
        }
        gLastDetCount = dc;
        if (gDetStagnantPolls >= FPGA_AIR_GONE_POLLS) {
          const mhz = get().lastForwardMhz;
          pushLog(
            "sys",
            `FPGA+сканер: энергия пропала (${FPGA_AIR_GONE_POLLS} опросов без детекта) — ` +
              `DISARM, возврат к скану${mhz != null ? `, skip ${mhz.toFixed(3)} МГц` : ""}`,
          );
          await fpgaReturnToScan(mhz);
        }
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
      if (s.fpgaArmed) {
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
      stopTxWatch();
      stopTxWalk();
      stopFpgaKick();
      stopFpgaObserve();
      if (get().fpgaArmed) {
        await get().fpgaDisarm();
        // USB остаётся у агента после disarm — отдаём хосту, иначе следующий
        // openSdr словит занятое устройство.
        await hostFpga({ op: "usb", action: "release", token: get().fpgaToken }, get().sdrGateway);
      }
      get().stopScan();
      gGate.reset();
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
      set({ sdrOpened: null, sdrRemote: "", transmitArmed: false, signalTxActive: false, lastForwardMhz: null, lastSdrTxUs: null, lastForwardPowerDbm: null, sdrHoldSince: null });
      pushLog("sys", "SDR закрыт");
    },

    flashSdr: async (action) => {
      if (get().flashBusy) {
        pushLog("sys", "прошивка уже идёт — ждите");
        return;
      }
      if (get().fpgaArmed) {
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
          // FPGA+СКАНЕР: автономный цикл «скан → handoff → ARM → возврат».
          // Старт = скан-фаза; ARM случается из tickScan по детекту.
          if (s.fpgaArmed || s.fpgaBusy || gFpgaHandoffBusy) return;
          const board = fpgaBoardPlan(s.sdrId);
          if (!board.ok) {
            pushLog("sys", board.reason);
            return;
          }
          if (!s.sdrLoadOk) {
            pushLog("sys", "FPGA+сканер: подтвердите нагрузку 50 Ом на выходе усилителя SDR");
            return;
          }
          set({ fpgaMode: "lb_gated" });
          if (!s.sdrEmulation) {
            // Шлюз нужен только на ARM; без него сканируем и ждём — честно в лог.
            const ping = await hostFpga({ op: "ping", token: s.fpgaToken }, s.sdrGateway);
            const no = fpgaGatewayRefused(ping);
            if (no) {
              pushLog("sys", `FPGA+сканер: ${no} — сканируем, ARM начнётся когда шлюз оживёт`);
            } else {
              // Скан-фаза: USB у хоста (агент держит его с момента старта —
              // без release openSdr ниже словил бы занятое устройство).
              await hostFpga({ op: "usb", action: "release", token: s.fpgaToken }, s.sdrGateway);
            }
          }
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
        if (s.fpgaArmed) {
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
        const st = get();
        const caps = catalogCaps(st.sdrId);
        const analog = gLive ? caps.analogBwMhz : gSdr.analogBwMhz();
        const windowMhz = clampWindowMhz(parseFloat(st.scanWindowMhz), analog);
        const walker = new ScanWalker({
          bands: st.sdrBands,
          pattern: "sweep",
          windowMhz,
          analogBwMhz: analog,
          dwellMs: parseFloat(st.scanDwellMs),
          seed: Date.now() & 0xffffffff,
        });
        gWalker = walker;
        const nBins = 1024;
        set({ scanRunning: true, scanCenterMhz: null });
        pushLog(
          "sys",
          `${gLive ? "SDR SCAN DIO-sys" : "SDR SCAN эмуляция"}: Hann+Welch-8 · ADC 40 MSPS · окно LO ${walker.windowMhz} МГц`,
        );
        let inflight = false;
        let lastResenseAt = 0;
        const tickScan = async (): Promise<void> => {
          if (!get().scanRunning || get().flashBusy) return;
          let bins: ScanBin[] = [];
          let centerMhz = 0;
          let detections: Detection[] = [];
          const step = gWalker?.next();
          if (!step?.centerMhz) return;
          const spanMhz = hostScanSpanMhz(analog);
          centerMhz = step.centerMhz;
          if (gLive) {
            const win = await hostScan(centerMhz, spanMhz, nBins);
            if (!get().scanRunning || get().flashBusy) return;
            if (win.txError) {
              pushLog("sys", win.txError);
              await get().stopTransmit();
            }
            if (!win.ok) {
              pushLog("sys", win.reason || "scan fail");
              return;
            }
            bins = win.bins;
          } else {
            bins = gSdr.scanWindow(centerMhz, spanMhz, nBins);
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
          if (bins.length > 0) set({ scanBins: bins });
          const cur = get();
          if (isFpgaAirPattern(cur.scanPattern)) {
            // FPGA+СКАНЕР: детект → handoff (парк → порог → USB → ARM lb_gated).
            // ПЕРЕДАТЬ не участвует — режим автономный. Пропуски: gSkipMhz
            // (мёртвая после ARM) и gHandoffFailMhz (handoff упал — ретрай
            // через паузу, не каждым тиком).
            gSkipMhz = refreshSkipMhz(gSkipMhz, detections, centerMhz, spanMhz, bins.length > 0);
            if (cur.sdrEmulation) return; // демо без железа: сканируем, ARM не делаем
            if (gFpgaHandoffBusy || cur.fpgaArmed || cur.fpgaBusy || cur.flashBusy) return;
            // Интерлок нагрузки — как planHandoff в хост-пути: без подтверждённой
            // нагрузки 50 Ом ARM не ставим (снятие галки гасит и будущие ARM).
            if (!cur.sdrLoadOk) return;
            const failActive =
              gHandoffFailMhz != null && Date.now() - gHandoffFailAt < FPGA_HANDOFF_RETRY_MS;
            const pool = detections.filter((d) => {
              if (gSkipMhz != null && sameBin(d.freqMhz, gSkipMhz)) return false;
              if (failActive && gHandoffFailMhz != null && sameBin(d.freqMhz, gHandoffFailMhz)) {
                return false;
              }
              return true;
            });
            const target = pickStrongest(pool);
            if (target) void fpgaHandoff(target.freqMhz, target.powerDbm);
            return;
          }
          if (!cur.transmitArmed || !scannerParticipates(cur.scanPattern)) return;
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
            if (!shouldContinuePriorityTick(rs)) return;
          }
          if (!get().scanRunning || get().flashBusy || !get().transmitArmed) return;
          const after = get();
          const heldNow = gGate.lastCuedMhz;
          const dispatch = after.autoDispatch;
          const target = pickArmedAutoTarget({
            liveWindow: dispatch === "turn" ? raw : detections,
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
      if (gScanTimer) {
        clearInterval(gScanTimer);
        gScanTimer = null;
      }
      gWalker = null;
      if (get().scanRunning) set({ scanRunning: false });
      // СТОП СКАН гасит только хост-FFT. FPGA+сканер стопается с вкладки СКАН
      // (fpgaDisarm) или СТОП ПЕРЕДАЧУ. Нельзя гасить PLAYER/NCO только потому,
      // что в меню остался пункт «FPGA+СКАНЕР».
      if (get().transmitArmed) {
        // Re-sense живёт внутри tickScan: без скана удержание слепое —
        // жива ли частота, больше никто не проверяет (только watch потока).
        pushLog("sys", "СТОП СКАН: TX-удержание продолжается вслепую, без перепроверки эфира");
      }
    },

    startTransmit: async () => {
      const s = get();
      if (isFpgaAirPattern(s.scanPattern)) {
        if (s.fpgaArmed || s.fpgaBusy) return;
        set({ fpgaMode: "lb_gated" });
        await get().fpgaArm();
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
      if (s.fpgaArmed) {
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
      const alreadyScanning = get().scanRunning;
      if (!alreadyScanning) {
        get().startScan();
        return;
      }
      const raw = clipToAllowlist(detectFromBins(get().scanBins, get().scanThresholdDb), get().sdrBands);
      const dispatch = get().autoDispatch;
      const live =
        dispatch === "turn"
          ? raw
          : withoutOwnTx(raw, get().lastForwardMhz, ownTxGuardMhz(get().txWaveKind !== null));
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
      gResense = false;
      gSkipMhz = null;
      set({ transmitArmed: false, signalTxActive: false });
      gGate.reset();
      if (get().fpgaArmed) await get().fpgaDisarm();
      if (gLive) await hostTxOff();
      gSdr.txOff();
      set({ lastSdrTxUs: null, lastForwardMhz: null, lastForwardPowerDbm: null, sdrHoldSince: null, lastCueReason: "SDR TX остановлен" });
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
