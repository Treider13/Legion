// ============================================================================
// LEGION — zustand store: состояние подключения, генератора и журнал.
// ============================================================================
import { create } from "zustand";

import { LegionClient } from "../protocol/client";
import { MockTransport } from "../transport/mock";
import { TauriSerialTransport } from "../transport/tauriSerial";
import type { SerialPortDescriptor, Transport, TransportKind, TransportState } from "../transport/types";
import { WebSerialTransport } from "../transport/webSerial";
import { WebSocketTransport } from "../transport/websocket";

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
  status: StatusJson | null;
  // коридор (фаза 3)
  corrF1: string;
  corrF2: string;
  corrStepKhz: string;
  corrDwellMs: string;
  corrSeed: string;
  corrMode: "SWEEP" | "HOP";
  corridorRunning: boolean;
  telemFreq: number | null;
  telemLock: boolean | null;
  // журнал
  log: LogEntry[];

  setTransportKind(k: TransportKind): void;
  setSelectedPort(p: string): void;
  setWsUrl(u: string): void;
  setFreqMhz(f: string): void;
  setCorrField(field: "corrF1" | "corrF2" | "corrStepKhz" | "corrDwellMs" | "corrSeed", v: string): void;
  setCorrMode(m: "SWEEP" | "HOP"): void;
  refreshPorts(): Promise<void>;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(cmd: string): Promise<void>;
  setFrequency(): Promise<void>;
  setPower(dbm: number): Promise<void>;
  setRf(on: boolean): Promise<void>;
  pollStatus(): Promise<void>;
  runSelftest(): Promise<void>;
  corridorStart(): Promise<void>;
  corridorStop(): Promise<void>;
  clearLog(): void;
}

const MAX_LOG = 500;

let gTransport: Transport | null = null;
let gClient: LegionClient | null = null;

export const useLegion = create<LegionStore>((set, get) => {
  const pushLog = (dir: LogEntry["dir"], text: string) =>
    set((s) => ({ log: [...s.log.slice(-MAX_LOG + 1), { ts: Date.now(), dir, text }] }));

  const parseLockFrom = (line: string): boolean | null => {
    const m = /LOCK=(\d)/.exec(line);
    return m ? m[1] === "1" : null;
  };

  return {
    transportKind: "mock",
    transportState: "disconnected",
    transportDetail: undefined,
    ports: [],
    selectedPort: "",
    wsUrl: "ws://192.168.4.1/ws",
    freqMhz: "2475.000",
    lock: null,
    powerDbm: 5,
    rfOn: false,
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
    log: [],

    setTransportKind: (k) => set({ transportKind: k }),
    setSelectedPort: (p) => set({ selectedPort: p }),
    setWsUrl: (u) => set({ wsUrl: u }),
    setFreqMhz: (f) => set({ freqMhz: f }),
    setCorrField: (field, v) => set({ [field]: v }),
    setCorrMode: (m) => set({ corrMode: m }),
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
        set({ telemFreq: t.freq, telemLock: t.lock === 1, corridorRunning: true });
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
        }
      } catch (e) {
        pushLog("sys", `connect failed: ${String(e)}`);
        set({ transportState: "error", transportDetail: String(e) });
      }
    },

    disconnect: async () => {
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

    setRf: async (on) => {
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
      const cmd =
        s.corrMode === "SWEEP"
          ? `SWEEP START ${f1} ${f2} STEP ${step} DWELL ${dwell}`
          : `HOP START ${f1} ${f2} RATE ${dwell} SEED ${seed} STEP ${step}`;
      pushLog("tx", cmd);
      const r =
        s.corrMode === "SWEEP"
          ? await gClient.sweepStart(f1, f2, step, dwell)
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
  };
});
