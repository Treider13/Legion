// ============================================================================
// LEGION — клиент живого SDR (Tauri → sdr_worker.py → SoapySDR).
// Не ESP32. В браузере без Tauri не работает.
// ============================================================================
import { catalogById } from "./catalog";
import type { ScanBin, SdrDeviceInfo, TxCueResult } from "./types";
import { isTauriRuntime } from "../transport/types";

export interface HostPing {
  ok: boolean;
  soapy?: boolean;
  numpy?: boolean;
  fake?: boolean;
  reason?: string;
  devices?: Array<Record<string, string>>;
}

export interface HostScanResult {
  ok: boolean;
  bins: ScanBin[];
  reason?: string;
  txLive?: boolean;
  txError?: string;
}

async function invoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const { invoke: inv } = await import("@tauri-apps/api/core");
  return inv<T>(cmd, args);
}

export function hostSdrAvailable(): boolean {
  return isTauriRuntime();
}

export async function hostRpc<T>(msg: Record<string, unknown>): Promise<T> {
  const raw = await invoke<string>("sdr_rpc", { req: JSON.stringify(msg) });
  return JSON.parse(raw) as T;
}

export async function hostHealth(): Promise<{ ok: boolean; txLive?: boolean; txError?: string; reason?: string }> {
  if (!hostSdrAvailable()) return { ok: false, reason: "нет Tauri" };
  try {
    return await hostRpc({ op: "ping" });
  } catch (e) {
    return { ok: false, reason: String(e) };
  }
}

export async function hostPing(args = ""): Promise<HostPing> {
  if (!hostSdrAvailable()) {
    return { ok: false, reason: "нужен desktop LEGION (Tauri), не браузер" };
  }
  try {
    // SoapyRemote: enumerate без remote=tcp://host:55132 не видит шлюз (wiki SoapyRemote).
    return await hostRpc<HostPing>({ op: "probe", args });
  } catch (e) {
    return { ok: false, reason: String(e) };
  }
}

export async function hostOpen(
  args: string,
  analogBwMhz: number,
  canTx: boolean,
  fullDuplex: boolean,
): Promise<{ ok: boolean; reason: string }> {
  return hostRpc({ op: "open", args, analogBwMhz, canTx, fullDuplex });
}

export async function hostScan(centerMhz: number, bwMhz: number, bins: number): Promise<HostScanResult> {
  const r = await hostRpc<HostScanResult & { bins?: ScanBin[] }>({
    op: "scan",
    centerMhz,
    bwMhz,
    bins,
  });
  return {
    ok: !!r.ok,
    bins: r.bins ?? [],
    reason: r.reason,
    txLive: r.txLive,
    txError: r.txError,
  };
}

export async function hostTx(freqMhz: number): Promise<TxCueResult> {
  const r = await hostRpc<{
    ok: boolean;
    reason?: string;
    latencyUs?: number;
    freqMhz?: number;
  }>({ op: "tx", freqMhz });
  return {
    ok: !!r.ok,
    reason: r.reason ?? "",
    freqMhz: r.freqMhz ?? freqMhz,
    latencyUs: r.latencyUs ?? 0,
    path: r.ok ? "sdr-tx" : "none",
  };
}

export async function hostTxOff(): Promise<void> {
  await hostRpc({ op: "tx_off" });
}

export async function hostClose(): Promise<void> {
  try {
    await hostRpc({ op: "close" });
  } catch {
    /* worker мог уже выйти */
  }
}

export async function hostFlash(argv: string[], file?: string): Promise<{ ok: boolean; reason: string; written: boolean }> {
  try {
    const reason = await invoke<string>("sdr_flash", { argv, file: file ?? null });
    return { ok: true, reason, written: true };
  } catch (e) {
    return { ok: false, reason: String(e), written: false };
  }
}

export async function hostEsp32ChipId(port: string): Promise<{ ok: boolean; text: string }> {
  if (!hostSdrAvailable()) {
    return { ok: false, text: "нужен desktop LEGION (Tauri), не браузер" };
  }
  try {
    const text = await invoke<string>("esp32_chip_id", { port });
    return { ok: true, text };
  } catch (e) {
    return { ok: false, text: String(e) };
  }
}

export async function hostEsp32Flash(
  env: string,
  port: string,
): Promise<{ ok: boolean; reason: string; written: boolean }> {
  if (!hostSdrAvailable()) {
    return { ok: false, reason: "нужен desktop LEGION (Tauri) — команда не запущена", written: false };
  }
  try {
    const reason = await invoke<string>("esp32_flash", { env, port });
    return { ok: true, reason, written: true };
  } catch (e) {
    return { ok: false, reason: String(e), written: false };
  }
}

export function markCatalogPresent(list: SdrDeviceInfo[], found: Array<Record<string, string>>): SdrDeviceInfo[] {
  // Матчим ПОСТРОЧНО, не по общему blob: раньше один найденный bladeRF помечал
  // все модели bladeRF, а serial становился первыми 48 символами свалки всех
  // устройств (аудит №24).
  const rows = found.map((d) => ({
    blob: Object.values(d).join(" ").toLowerCase(),
    serial: String(d.serial ?? d.label ?? ""),
  }));
  const matches = (id: string, blob: string): boolean =>
    (id.includes("bladerf") && blob.includes("bladerf")) ||
    (id.includes("hackrf") && blob.includes("hackrf")) ||
    (id.includes("pluto") && (blob.includes("pluto") || blob.includes("ad936"))) ||
    (id.includes("n210") && (blob.includes("n210") || blob.includes("usrp2"))) ||
    (id.includes("b210") && blob.includes("b210")) ||
    (id.includes("lime") && blob.includes("lime")) ||
    (id.includes("rtl") && (blob.includes("rtlsdr") || blob.includes("rtl")));
  return list.map((e) => {
    const row = rows.find((r) => matches(e.id, r.blob));
    return { ...e, present: !!row, serial: row ? row.serial.slice(0, 64) : e.serial };
  });
}

export function catalogCaps(id: string) {
  const row = catalogById(id);
  return {
    analogBwMhz: row?.analogBwMhz ?? 20,
    canTx: row?.role === "trx" && row.txMhz !== null,
    fullDuplex: row?.fullDuplex === true,
  };
}
