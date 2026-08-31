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
  requireHw?: string,
): Promise<{ ok: boolean; reason: string; fake?: boolean; hardwareKey?: string }> {
  return hostRpc({
    op: "open",
    args,
    analogBwMhz,
    canTx,
    fullDuplex,
    ...(requireHw ? { requireHw } : {}),
  });
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

/** requireHw под плату: x40 → bladerf1 (LMS6002D), micro → bladerf2 (AD9361).
 *  Подмены нет: каждая плата паркуется как сама себя. */
export function requireHwForSdr(sdrId: string): string {
  if (sdrId === "bladerf-x40") return "bladerf1";
  if (sdrId === "bladerf-micro-xa4" || sdrId === "bladerf-micro-xa9") return "bladerf2";
  return "";
}

/** Захват шумовой полки на припаркованном LO (handoff скан→FPGA):
 *  медиана нижних 60% энергий окон по win сэмплов, единицы SC16Q11. */
export async function hostDetCapture(
  win: number,
  windows: number,
): Promise<{ ok: boolean; reason: string; medianEnergy?: number; fsHz?: number }> {
  if (!hostSdrAvailable()) return { ok: false, reason: "нет Tauri" };
  try {
    const r = await hostRpc<{
      ok?: boolean;
      reason?: string;
      medianEnergy?: number;
      fsHz?: number;
    }>({ op: "det_capture", win, windows });
    return {
      ok: !!r.ok,
      reason: r.reason ?? "",
      medianEnergy: r.medianEnergy,
      fsHz: r.fsHz,
    };
  } catch (e) {
    return { ok: false, reason: String(e) };
  }
}

export async function hostPark(
  centerMhz: number,
  bwMhz: number,
  fsHz: number,
  rx: boolean,
  tx: boolean,
): Promise<{
  ok: boolean;
  reason: string;
  freqMhz?: number;
  fsHz?: number;
  fake?: boolean;
  rxLo?: number;
  txLo?: number;
  rxFs?: number;
  txFs?: number;
  rxGainDb?: number;
}> {
  if (!hostSdrAvailable()) return { ok: false, reason: "нет Tauri" };
  try {
    const r = await hostRpc<{
      ok?: boolean;
      reason?: string;
      freqMhz?: number;
      fsHz?: number;
      fake?: boolean;
      rxLo?: number;
      txLo?: number;
      rxFs?: number;
      txFs?: number;
      rxGainDb?: number;
    }>({ op: "park", centerMhz, bwMhz, fsHz, rx, tx });
    return {
      ok: !!r.ok,
      reason: r.reason ?? "",
      freqMhz: r.freqMhz,
      fsHz: r.fsHz,
      fake: !!r.fake,
      rxLo: r.rxLo,
      txLo: r.txLo,
      rxFs: r.rxFs,
      txFs: r.txFs,
      rxGainDb: r.rxGainDb,
    };
  } catch (e) {
    return { ok: false, reason: String(e) };
  }
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

export async function hostTxWave(
  freqMhz: number,
  wave: string,
  params: Record<string, number>,
  fsHz?: number,
): Promise<TxCueResult> {
  const payload: Record<string, unknown> = { op: "tx_wave", freqMhz, wave, params };
  if (fsHz != null && Number.isFinite(fsHz) && fsHz > 0) payload.fsHz = fsHz;
  const r = await hostRpc<{
    ok?: boolean;
    reason?: string;
    latencyUs?: number;
    freqMhz?: number;
    fake?: boolean;
  }>(payload);
  return {
    ok: !!r.ok,
    reason: r.reason ?? "",
    freqMhz: r.freqMhz ?? freqMhz,
    latencyUs: r.latencyUs ?? 0,
    path: r.ok ? "sdr-tx" : "none",
    fake: !!r.fake,
  };
}

export async function hostTxOff(): Promise<void> {
  await hostRpc({ op: "tx_off" });
}

export interface FpgaStatus {
  ok: boolean;
  reason?: string;
  playing?: boolean;
  capture_done?: boolean;
  det_active?: boolean;
  wd_fired?: boolean;
  lb_level?: number;
  det_count?: number;
  fake?: boolean;
  /** Шлюз распознал ревизию legion (0x80 отвечает). null/undefined — неизвестно. */
  legion?: boolean | null;
  /** Секунды непрерывного ARM по часам шлюза (0 — не армировано). */
  armed_s?: number | null;
  /** op flash (async): started — процесс пошёл; running/done/log — flash_status. */
  started?: boolean;
  running?: boolean;
  done?: boolean;
  log?: string;
  action?: string;
  /** flash: CLI записал, но USB обратно не занялся (Soapy держит / FPGA не поднялась).
   *  status: длительная непрерывная работа — проверить охлаждение. */
  warn?: string;
  /** LO, кГц/1000 из NIOS AIR_FREQ — текущий взгляд платы. */
  freq_mhz?: number;
}

/** Команда FPGA-ревизии legion (x40): релей через воркер → шлюз → NIOS.
 *  gw — IP шлюза передаём явно: управление FPGA не зависит от того,
 *  открыт ли Soapy-стрим (прошивка/мониторинг до старта потока). */
export async function hostFpga(cmd: Record<string, unknown>, gw: string): Promise<FpgaStatus> {
  if (!hostSdrAvailable()) {
    return { ok: false, reason: "нужен desktop LEGION (Tauri), не браузер" };
  }
  try {
    return await hostRpc<FpgaStatus>({ op: "fpga", cmd, gw });
  } catch (e) {
    return { ok: false, reason: String(e) };
  }
}

export async function hostClose(): Promise<void> {
  try {
    await hostRpc({ op: "close" });
  } catch {
    /* worker мог уже выйти */
  }
}

// ---------------------------------------------------------------------------
// КАСТОМ FPGA (ревизия legion): сборка Quartus на этом ПК + запись .rbf.
// Сборка — свои команды legion_build_* (не sdr_rpc с его 15 с); запись —
// существующий sdr_flash (allowlist bladeRF-cli) локально или op flash шлюза.
// ---------------------------------------------------------------------------

export interface LegionEnvInfo {
  os: string;
  repoRoot?: string | null;
  quartusDir?: string | null;
  niosShell?: string | null;
  canBuild: boolean;
  reason: string;
}

export interface LegionBuildStatus {
  running: boolean;
  exit?: number;
  tail?: string;
  logPath?: string;
  elapsedSec?: number;
  artifact?: { path: string; sha256?: string | null; dir?: string } | null;
  reason?: string;
}

export async function hostLegionEnvInfo(): Promise<{ ok: boolean; info?: LegionEnvInfo; reason: string }> {
  if (!hostSdrAvailable()) return { ok: false, reason: "нужен desktop LEGION (Tauri), не браузер" };
  try {
    const info = await invoke<LegionEnvInfo>("legion_env_info", {});
    return { ok: true, info, reason: info.reason };
  } catch (e) {
    return { ok: false, reason: String(e) };
  }
}

export async function hostLegionToolchain(): Promise<{ ok: boolean; text: string }> {
  if (!hostSdrAvailable()) return { ok: false, text: "нужен desktop LEGION (Tauri), не браузер" };
  try {
    const text = await invoke<string>("legion_toolchain_check", {});
    return { ok: true, text };
  } catch (e) {
    return { ok: false, text: String(e) };
  }
}

export async function hostLegionBuildStart(
  board: string,
  size: string,
): Promise<{ ok: boolean; reason: string; logPath?: string }> {
  if (!hostSdrAvailable()) return { ok: false, reason: "нужен desktop LEGION (Tauri), не браузер" };
  try {
    const r = await invoke<{ logPath?: string }>("legion_build_start", { board, size });
    return { ok: true, reason: "сборка пошла", logPath: r.logPath };
  } catch (e) {
    return { ok: false, reason: String(e) };
  }
}

export async function hostLegionBuildStatus(): Promise<LegionBuildStatus> {
  try {
    return await invoke<LegionBuildStatus>("legion_build_status", {});
  } catch (e) {
    return { running: false, reason: String(e) };
  }
}

export async function hostLegionBuildCancel(): Promise<{ ok: boolean; reason: string }> {
  try {
    const reason = await invoke<string>("legion_build_cancel", {});
    return { ok: true, reason };
  } catch (e) {
    return { ok: false, reason: String(e) };
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
