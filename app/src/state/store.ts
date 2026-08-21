// ============================================================================
// LEGION — zustand store: состояние подключения, генератора и журнал.
// ============================================================================
import { create } from "zustand";

import { cueFreqAllowed, parseBand, type AllowBand } from "../policy/allowlist";
import { LegionClient } from "../protocol/client";
import { MockSdrBackend } from "../sdr/backend";
import { defaultEthHost, defaultFlashName, planEthernet, sdrOpenArgs } from "../sdr/official";
import { catalogById } from "../sdr/catalog";
import { planFlashCli } from "../sdr/flashcli";
import { flashFileRequired, hostOpenAllowed } from "../sdr/host";
import {
  catalogCaps,
  hostClose,
  hostFlash,
  hostOpen,
  hostPing,
  hostSdrAvailable,
  hostScan,
  hostTx,
  hostTxOff,
  markCatalogPresent,
} from "../sdr/hostClient";
import { detectFromBins } from "../sdr/backend";
import type { Detection, FlashResult, ScanBin, SdrDeviceInfo } from "../sdr/types";
import { isTauriRuntime } from "../transport/types";
import { HandoffGate, planHandoff, type HandoffPlan } from "../sense/fastpath";
import { modeConflict, modeOf } from "../sense/modes";
import {
  markForwarded,
  mergeDetections,
  pickStrongest,
} from "../sense/orchestrator";
import { AllowlistScanner, clipToAllowlist, planCenters, scanHopMhz, scanTickMs } from "../sense/scan";
import { MockTransport } from "../transport/mock";
import { TauriSerialTransport } from "../transport/tauriSerial";
import type { SerialPortDescriptor, Transport, TransportKind, TransportState } from "../transport/types";
import { WebSerialTransport } from "../transport/webSerial";
import { WebSocketTransport } from "../transport/websocket";

export type WorkspaceId = "synth" | "corridor" | "sdr" | "scan" | "pa";

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
  lastFlash: FlashResult | null;
  sdrEmulation: boolean;
  sdrHostReady: boolean;
  sdrHostDetail: string;
  sdrImageBytes: number;
  sdrImagePath: string;
  // SCAN RX
  scanRunning: boolean;
  scanThresholdDb: number;
  scanCenterMhz: number | null;
  scanBins: ScanBin[];
  detections: Detection[];
  lastInterceptMhz: number | null;
  lastCueReason: string;
  lastSdrTxUs: number | null;
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
  setSdrEmulation(v: boolean): void;
  setSdrImageFile(name: string, byteLength: number, path?: string): void;
  setScanThreshold(db: number): void;
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
  openSdr(): Promise<void>;
  closeSdr(): Promise<void>;
  flashSdr(action: "flash-fx3" | "flash-fpga" | "load-fpga"): Promise<void>;
  injectDemoTone(): void;
  startScan(): void;
  stopScan(): void;
  startTransmit(): Promise<void>;
  stopTransmit(): Promise<void>;
  forwardTo(mhz: number): Promise<void>;
  clearLog(): void;
}

const MAX_LOG = 500;

let gTransport: Transport | null = null;
let gClient: LegionClient | null = null;
const gSdr = new MockSdrBackend();
let gLive = false;
let gScan: AllowlistScanner | null = null;
let gScanTimer: ReturnType<typeof setInterval> | null = null;
const gGate = new HandoffGate();

export const useLegion = create<LegionStore>((set, get) => {
  const pushLog = (dir: LogEntry["dir"], text: string) =>
    set((s) => ({ log: [...s.log.slice(-MAX_LOG + 1), { ts: Date.now(), dir, text }] }));

  // Троттлинг телеметрии: прошивка шлёт до ~100 строк/с, а каждый set()
  // перерисовывает панели — коалесцируем до ~15 Гц (глазу и маркеру хватает).
  let telemLastMs = 0;

  const parseLockFrom = (line: string): boolean | null => {
    const m = /LOCK=(\d)/.exec(line);
    return m ? m[1] === "1" : null;
  };

  const executeHandoff = (plan: HandoffPlan, sdrUs: number): void => {
    // Режим SDR: никаких CUE / PA / RF на ESP32.
    set({
      detections: markForwarded(get().detections, plan.freqMhz),
      lastForwardMhz: plan.freqMhz,
      lastSdrTxUs: sdrUs || get().lastSdrTxUs,
      lastCueReason: `SDR TX ${plan.freqMhz.toFixed(3)} МГц → усилитель · ${sdrUs} µs host`,
    });
  };

  const runHandoff = (mhz: number): void => {
    void runHandoffAsync(mhz);
  };

  const runHandoffAsync = async (mhz: number): Promise<void> => {
    const st = get();
    const caps = catalogCaps(st.sdrId);
    const plan = planHandoff({
      det: mhzAsDet(mhz),
      bands: st.sdrBands,
      loadOk: st.sdrLoadOk,
      transmitArmed: st.transmitArmed,
      lastCuedMhz: gGate.lastCuedMhz,
      inflight: gGate.inflight,
      sdrCanTx: gLive ? caps.canTx : gSdr.canTx(),
    });
    if (plan.skip) return;
    gGate.reserve(plan.freqMhz);
    let sdrUs = 0;
    try {
      if (plan.sdrTx) {
        const tx = gLive ? await hostTx(plan.freqMhz) : gSdr.txCue(plan.freqMhz);
        sdrUs = tx.latencyUs;
        pushLog("sys", tx.reason);
        if (!tx.ok) return;
      }
      executeHandoff(plan, sdrUs);
    } finally {
      const queued = gGate.release();
      if (queued !== null) void runHandoffAsync(queued);
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
    workspace: "synth",
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
    sdrDevices: gSdr.probe(),
    sdrId: "bladerf-micro-xa4",
    sdrGateway: "192.168.1.20",
    sdrOpened: null,
    sdrRemote: "",
    sdrFlashName: "hostedxA4.rbf",
    lastFlash: null,
    sdrEmulation: !isTauriRuntime(),
    sdrHostReady: false,
    sdrHostDetail: "",
    sdrImagePath: "",
    sdrImageBytes: 0,
    scanRunning: false,
    scanThresholdDb: 12,
    scanCenterMhz: null,
    scanBins: [],
    detections: [],
    lastInterceptMhz: null,
    lastCueReason: "",
    lastSdrTxUs: null,
    log: [],

    setTransportKind: (k) => set({ transportKind: k }),
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
        sdrGateway: defaultEthHost(id),
      }),
    setSdrGateway: (v) => set({ sdrGateway: v }),
    setSdrFlashName: (v) => set({ sdrFlashName: v }),
    setSdrEmulation: (v) => {
      if (!v) gLive = false;
      gSdr.setEmulation(v);
      set({ sdrEmulation: v, sdrDevices: gSdr.probe(), sdrOpened: gSdr.opened(), sdrRemote: gSdr.remoteArgs() });
      pushLog("sys", v ? "SDR: эмуляция включена (не эфир)" : "SDR: эмуляция выкл — нужен Soapy/CLI на шлюзе");
    },
    setSdrImageFile: (name, byteLength, path) =>
      set({ sdrFlashName: name, sdrImageBytes: byteLength, sdrImagePath: path ?? "" }),
    setScanThreshold: (db) => set({ scanThresholdDb: db }),
    clearLog: () => set({ log: [] }),

    refreshPorts: async () => {
      if (get().transportKind !== "tauri-serial") return;
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
        if (get().corridorRunning) {
          set({ telemFreq: t.freq, telemLock: t.lock === 1 });
        } else {
          set({ telemFreq: t.freq, telemLock: t.lock === 1, corridorRunning: true });
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
      set({ transportState: "disconnected", lock: null });
    },

    send: async (cmd) => {
      if (!gClient) return;
      pushLog("tx", cmd);
      const r = await gClient.cmd(cmd);
      if (!r.ok) pushLog("sys", `command failed: ${r.statusLine}`);
    },

    setFrequency: async () => {
      const blocked = modeConflict("esp32", false, get().transmitArmed);
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
      if (!gClient) return;
      pushLog("tx", `SET POWER ${dbm}`);
      const r = await gClient.setPower(dbm);
      if (r.ok) set({ powerDbm: dbm });
    },

    setAtt: async (db) => {
      if (!gClient) return;
      pushLog("tx", `SET ATT ${db.toFixed(2)}`);
      const r = await gClient.setAtt(db);
      if (r.ok) set({ attDb: db });
    },

    setRf: async (on) => {
      const blocked = modeConflict("esp32", false, get().transmitArmed);
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
          set({ status: st, lock: st.lock === 1, rfOn: st.rf === 1 });
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
      const blocked = modeConflict("esp32", false, get().transmitArmed);
      if (blocked) {
        pushLog("sys", blocked);
        return;
      }
      const s = get();
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
        s.corrMode === "SWEEP"
          ? `SWEEP START ${f1} ${f2} STEP ${step} DWELL ${dwell}`
          : s.corrMode === "CHIRP"
            ? `CHIRP START ${f1} ${f2} STEP ${step} DWELL ${dwell}`
            : `HOP START ${f1} ${f2} RATE ${dwell} SEED ${seed} STEP ${step}`;
      pushLog("tx", cmd);
      const r =
        s.corrMode === "SWEEP"
          ? await gClient.sweepStart(f1, f2, step, dwell)
          : s.corrMode === "CHIRP"
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
        pushLog("sys", "allowlist: неверная полоса (35–4400 МГц, f1≤f2)");
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
        pushLog("sys", "SDR allowlist: неверная полоса (35–4400 МГц, f1≤f2)");
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
      pushLog("sys", ok ? "SDR: нагрузка 50 Ом на усилителе SDR" : "SDR: нагрузка снята");
    },

    applyPaCurrent: async () => {
      const ma = get().paMa;
      if (!gClient) return;
      pushLog("tx", `PA SET I ${Math.round(ma)}`);
      const r = await gClient.paSetI(ma);
      if (!r.ok) pushLog("sys", r.statusLine);
    },

    setPaEnabled: async (on) => {
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

    probeSdr: async () => {
      if (!get().sdrEmulation && hostSdrAvailable()) {
        const p = await hostPing();
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

    openSdr: async () => {
      const s = get();
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
      const ping = hostSdrAvailable() ? await hostPing() : { ok: false, soapy: false, reason: "нет Tauri" };
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
      const r = await hostOpen(remote, caps.analogBwMhz, caps.canTx, caps.fullDuplex);
      if (!r.ok) {
        pushLog("sys", r.reason);
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
      get().stopScan();
      if (gLive) {
        await hostTxOff();
        await hostClose();
      }
      gSdr.txOff();
      gSdr.close();
      gLive = false;
      set({ sdrOpened: null, sdrRemote: "" });
      pushLog("sys", "SDR закрыт");
    },

    flashSdr: async (action) => {
      const s = get();
      const file = flashFileRequired(s.sdrImageBytes);
      if (!file.ok) {
        const r: FlashResult = { ok: false, kind: "unknown", reason: file.reason, written: false };
        set({ lastFlash: r });
        pushLog("sys", r.reason);
        return;
      }
      const job = {
        deviceId: s.sdrOpened?.id ?? s.sdrId,
        filename: s.sdrImagePath || s.sdrFlashName,
        byteLength: s.sdrImageBytes,
        action,
      };
      const cli = planFlashCli(job, s.sdrGateway);
      if (hostSdrAvailable() && cli.argv.length > 0) {
        const r = await hostFlash(cli.argv, s.sdrImagePath || undefined);
        set({
          lastFlash: { ok: r.ok, kind: "unknown", reason: r.reason, written: r.written },
        });
        pushLog("sys", r.written ? `записано в SDR: ${r.reason}` : `не записано: ${r.reason}`);
        return;
      }
      if (!gSdr.opened()) {
        gSdr.setEmulation(true);
        gSdr.open(s.sdrId, sdrOpenArgs(s.sdrId, s.sdrGateway));
      }
      const r = gSdr.flash(job);
      set({ lastFlash: r });
      pushLog("sys", r.written ? `записано в SDR: ${r.reason}` : `не записано: ${r.reason} · ${cli.reason}`);
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
        const blocked = modeConflict("sdr", s.corridorRunning, false);
        if (blocked) {
          pushLog("sys", blocked);
          return;
        }
        if (s.sdrBands.length === 0) {
          pushLog("sys", "SCAN: пустой SDR allowlist — задайте полосы на вкладке СКАН (не ESP32)");
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
        const caps = catalogCaps(get().sdrId);
        const hop = scanHopMhz(gLive ? caps.analogBwMhz : gSdr.analogBwMhz());
        const centers = planCenters(get().sdrBands, hop);
        const nBins = hop >= 40 ? 256 : 64;
        let centerIdx = 0;
        if (!gLive) {
          gScan = new AllowlistScanner(gSdr, {
            bands: get().sdrBands,
            bwMhz: hop,
            bins: nBins,
            thresholdDb: get().scanThresholdDb,
            loop: true,
          });
        } else {
          gScan = null;
        }
        const tickMs = scanTickMs(centers.length);
        set({ scanRunning: true, scanCenterMhz: null });
        pushLog(
          "sys",
          `${gLive ? "SDR SCAN Soapy" : "SDR SCAN эмуляция"}: BW ${hop} МГц · ${centers.length} стоек · тик ${tickMs} мс`,
        );
        let inflight = false;
        gScanTimer = setInterval(() => {
          if (inflight) return;
          inflight = true;
          void (async () => {
            try {
              let bins: ScanBin[] = [];
              let centerMhz = 0;
              let detections: Detection[] = [];
              if (gLive) {
                if (centers.length === 0) return;
                centerMhz = centers[centerIdx % centers.length];
                centerIdx += 1;
                const win = await hostScan(centerMhz, hop, nBins);
                if (!win.ok) {
                  pushLog("sys", win.reason || "scan fail");
                  return;
                }
                bins = win.bins;
                detections = clipToAllowlist(detectFromBins(bins, get().scanThresholdDb), get().sdrBands);
              } else if (gScan) {
                const tick = gScan.tick();
                centerMhz = tick.centerMhz;
                bins = tick.bins;
                detections = tick.detections;
              } else {
                return;
              }
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
              const st = get();
              if (!st.transmitArmed) return;
              const best = pickStrongest(detections);
              if (!best) return;
              if (gGate.queueIfBusy(best.freqMhz)) return;
              runHandoff(best.freqMhz);
            } finally {
              inflight = false;
            }
          })();
        }, tickMs);
      })();
    },

    stopScan: () => {
      if (gScanTimer) {
        clearInterval(gScanTimer);
        gScanTimer = null;
      }
      gScan = null;
      if (get().scanRunning) set({ scanRunning: false });
    },

    startTransmit: async () => {
      const s = get();
      const blocked = modeConflict("sdr", s.corridorRunning, false);
      if (blocked) {
        pushLog("sys", blocked);
        return;
      }
      if (s.sdrBands.length === 0) {
        pushLog("sys", "ПЕРЕДАТЬ: нет SDR allowlist");
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
      pushLog(
        "sys",
        "SDR: ПЕРЕДАТЬ — улов остаётся на SDR, TX LO → RF out → усилитель. ESP32 не вызывается.",
      );
      if (!get().scanRunning) get().startScan();
      const pending = pickStrongest(get().detections.filter((d) => !d.forwarded));
      if (pending) runHandoff(pending.freqMhz);
    },

    stopTransmit: async () => {
      set({ transmitArmed: false });
      gGate.reset();
      if (gLive) await hostTxOff();
      gSdr.txOff();
      set({ lastSdrTxUs: null });
      pushLog("sys", "SDR TX остановлен (ESP32 не тронут)");
    },
  };
});

function mhzAsDet(mhz: number): import("../sdr/types").Detection {
  return { freqMhz: mhz, powerDbm: 0, noiseDbm: 0, snrDb: 0, ts: 0, forwarded: false };
}
