// Разбор ELRS из основного окна. Отдельный экран не открывается.
import { bindDesignStop, useLegion } from "../state/store";
import { hostClose } from "../sdr/hostClient";
import { isTauriRuntime } from "../transport/types";
import { autoTuneDigital, defaultDigitalCorridors, digitalTuneLine, type DigitalCorridor } from "./digitalMode";

export const SMART_CORRIDOR_MHZ = 56;
export const SMART_JAM_MHZ = 0.5;
export const SMART_SHIFT_HZ = 15000;
export const SMART_LOOK_EVERY_MS = 100;
export const SMART_LOOK_FOR_MS = 2;

export const rxFields = {
  shiftHz: SMART_SHIFT_HZ,
  lookEveryMs: SMART_LOOK_EVERY_MS,
  lookForMs: SMART_LOOK_FOR_MS,
  lna: 20,
  searchLo: "",
  searchHi: "",
};

let replayArmed = false;
const watchers = new Set<() => void>();

export function replayArmedNow(): boolean {
  return replayArmed;
}

export function setReplayArmed(on: boolean): void {
  replayArmed = on;
}

export function subscribeRx(fn: () => void): () => void {
  watchers.add(fn);
  return () => {
    watchers.delete(fn);
  };
}

async function invoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  const { invoke: inv } = await import("@tauri-apps/api/core");
  return inv<T>(cmd, args);
}

export interface RxStatus {
  running: boolean;
  exit?: number | null;
  line: string;
  err: string;
}

export function rxAvailable(): boolean {
  return isTauriRuntime();
}

function corridorHz(): { fStartHz: number; fEndHz: number } | string {
  const s = useLegion.getState();
  const a = parseFloat(String(s.sdrF1).replace(",", "."));
  if (!Number.isFinite(a)) return "коридор: задайте начало в мегагерцах";
  return { fStartHz: a * 1e6, fEndHz: (a + SMART_CORRIDOR_MHZ) * 1e6 };
}

export async function primeAccepted(
  fStartHz: number,
  fEndHz: number,
  hopsMhz: number[],
  dwellUs = 1000,
): Promise<void> {
  if (!rxAvailable()) throw new Error("это основное приложение, не браузер");
  const dwell = Math.max(1, Math.min(1_000_000, Math.round(dwellUs)));
  await invoke("legion_rx_prime", { fStartHz, fEndHz, hopsMhz, dwellUs: dwell });
}

export async function startLive(): Promise<string> {
  if (!rxAvailable()) return "это основное приложение, не браузер";
  const band = corridorHz();
  if (typeof band === "string") return band;
  bindDesignStop(stopDesignWatch);
  stopDesignWatch();
  useLegion.getState().stopScan();
  await hostClose();
  try {
    await invoke("legion_rx_test_stop");
  } catch {
    /* прошлого разбора нет */
  }
  await invoke("legion_rx_test_start", {
    fStartHz: band.fStartHz,
    fEndHz: band.fEndHz,
    jamDurationS: 0,
    muteNs: 0,
    lnaGainDb: rxFields.lna,
    fromLog: false,
    live: true,
    shiftHz: rxFields.shiftHz,
    lookEveryMs: rxFields.lookEveryMs,
    lookForMs: rxFields.lookForMs,
  });
  watchers.forEach((fn) => fn());
  const mhz = band.fStartHz / 1e6;
  return `коридор ${mhz.toFixed(3)}–${(mhz + SMART_CORRIDOR_MHZ).toFixed(3)} МГц, DRFM сдвиг ${rxFields.shiftHz} Гц, удар ${SMART_JAM_MHZ} МГц, до Стоп`;
}

export async function startDigital(): Promise<string> {
  if (!rxAvailable()) return "это основное приложение, не браузер";
  const s = useLegion.getState();
  const f1 = parseFloat(String(s.sdrF1).replace(",", "."));
  const f2 = parseFloat(String(s.sdrF2).replace(",", "."));
  const corridors: DigitalCorridor[] = s.digitalCorridors.length
    ? s.digitalCorridors
    : defaultDigitalCorridors(f1, f2);
  for (const c of corridors) {
    if (!(c.endMhz > c.startMhz) || c.endMhz - c.startMhz > 56 + 1e-6) {
      return "цифровой: каждый коридор не шире 56 МГц, конец больше начала";
    }
    if (!(c.priority > 0)) return "цифровой: приоритет должен быть больше нуля";
  }
  bindDesignStop(stopDesignWatch);
  stopDesignWatch();
  useLegion.getState().stopScan();
  await hostClose();
  try {
    await invoke("legion_rx_test_stop");
  } catch {
    /* прошлого разбора нет */
  }
  await invoke("legion_rx_digital_start", {
    job: {
      corridors: corridors.map((c) => ({
        start_hz: c.startMhz * 1e6,
        end_hz: c.endMhz * 1e6,
        priority: c.priority,
      })),
      walk: s.digitalWalk,
      wave: s.digitalWave,
      static_index: s.digitalStaticIndex,
      chirp_dir: s.digitalChirpDir,
      saw_period_s: s.digitalSawPeriodUs * 1e-6,
      amp: s.digitalAmp,
      tone_width_hz: s.digitalToneWidthMhz * 1e6,
      seed: 1,
      preset: s.digitalPreset,
      profile_hz: s.digitalProfileMhz * 1e6,
      dwell_s: s.digitalDwellMs * 1e-3,
    },
  });
  watchers.forEach((fn) => fn());
  watchDesignRx();
  const tune = autoTuneDigital(corridors, s.digitalDwellMs, s.digitalProfileMhz);
  return (
    `цифровой: ${s.digitalPreset}, ${corridors.length} коридор(ов), ` +
    `${digitalTuneLine(tune)}, ${s.digitalWalk}, ${s.digitalWave}, до Стоп`
  );
}

export async function startSurvey(): Promise<string> {
  if (!rxAvailable()) return "это основное приложение, не браузер";
  const a = parseFloat(String(rxFields.searchLo).replace(",", "."));
  const b = parseFloat(String(rxFields.searchHi).replace(",", "."));
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) {
    return "скан: задайте поиск от и до, до больше от";
  }
  bindDesignStop(stopDesignWatch);
  stopDesignWatch();
  useLegion.getState().stopScan();
  await hostClose();
  try {
    await invoke("legion_rx_test_stop");
  } catch {
    /* прошлого разбора нет */
  }
  await invoke("legion_rx_test_start", {
    fStartHz: a * 1e6,
    fEndHz: b * 1e6,
    jamDurationS: 0,
    muteNs: 0,
    lnaGainDb: rxFields.lna,
    fromLog: false,
    live: true,
    shiftHz: rxFields.shiftHz,
    lookEveryMs: rxFields.lookEveryMs,
    lookForMs: rxFields.lookForMs,
    survey: true,
  });
  watchers.forEach((fn) => fn());
  watchDesignRx();
  return `скан ${a.toFixed(3)}–${b.toFixed(3)} МГц, коридор предложит сам`;
}

export async function startRx(fromLog: boolean): Promise<string> {
  if (!rxAvailable()) return "это основное приложение, не браузер";
  const band = corridorHz();
  if (typeof band === "string") return band;
  useLegion.getState().stopScan();
  await hostClose();
  await invoke("legion_rx_test_start", {
    fStartHz: band.fStartHz,
    fEndHz: band.fEndHz,
    jamDurationS: 0,
    muteNs: 0,
    lnaGainDb: rxFields.lna,
    fromLog,
    shiftHz: rxFields.shiftHz,
    lookEveryMs: rxFields.lookEveryMs,
    lookForMs: rxFields.lookForMs,
  });
  watchers.forEach((fn) => fn());
  return fromLog ? "удар по загруженному логу" : "тест идёт — включи ELRS рядом";
}

let designTimer: ReturnType<typeof setInterval> | null = null;

export function watchDesignRx(): void {
  if (designTimer) return;
  designTimer = setInterval(() => {
    void pullDesignRx();
  }, 50);
}

export function stopDesignWatch(): void {
  if (designTimer) clearInterval(designTimer);
  designTimer = null;
}

async function pullDesignRx(): Promise<void> {
  const st = await rxStatus();
  if (!st?.running) {
    stopDesignWatch();
    return;
  }
  if (st.line) useLegion.getState().applyDesignRx(st.line);
}

export async function stopRx(): Promise<void> {
  stopDesignWatch();
  if (!rxAvailable()) return;
  await invoke("legion_rx_test_stop");
}

export async function rxStatus(): Promise<RxStatus | null> {
  if (!rxAvailable()) return null;
  return invoke<RxStatus>("legion_rx_test_status");
}

export async function rxCaptures(): Promise<string[]> {
  if (!rxAvailable()) return [];
  return invoke<string[]>("legion_rx_captures");
}

export async function loadRx(name: string): Promise<string> {
  if (!rxAvailable()) return "это основное приложение, не браузер";
  const raw = await invoke<string>("legion_rx_load", { name });
  let note = raw;
  try {
    const parsed = JSON.parse(raw) as { note?: string };
    if (parsed.note) note = parsed.note;
  } catch {
    /* текст как есть */
  }
  setReplayArmed(!note.includes("паттерна нет"));
  return note;
}

export function paintRxSpectrum(line: string): void {
  let msg: {
    db?: number[];
    f0_hz?: number | null;
    f1_hz?: number | null;
  };
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const db = msg.db;
  const f0 = msg.f0_hz;
  const f1 = msg.f1_hz;
  if (!db || db.length < 2 || f0 == null || f1 == null) return;
  const lo = f0 / 1e6;
  const hi = f1 / 1e6;
  const bins = db.map((powerDbm, i) => ({
    freqMhz: lo + ((hi - lo) * i) / (db.length - 1),
    powerDbm,
  }));
  useLegion.setState({ scanBins: bins, scanCenterMhz: (lo + hi) / 2 });
}
