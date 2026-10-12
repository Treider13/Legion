// Разбор ELRS из основного окна. Отдельный экран не открывается.
import { useLegion } from "../state/store";
import { hostClose } from "../sdr/hostClient";
import { isTauriRuntime } from "../transport/types";

export const rxFields = { jam: 15, mute: 0, lna: 20 };

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
  const b = parseFloat(String(s.sdrF2).replace(",", "."));
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) {
    return "коридор от и до — числа, до больше от";
  }
  return { fStartHz: a * 1e6, fEndHz: b * 1e6 };
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
    jamDurationS: rxFields.jam,
    muteNs: rxFields.mute,
    lnaGainDb: rxFields.lna,
    fromLog,
  });
  watchers.forEach((fn) => fn());
  return fromLog ? "удар по загруженному логу" : "тест идёт — включи ELRS рядом";
}

export async function stopRx(): Promise<void> {
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
