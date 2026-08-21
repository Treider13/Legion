// ============================================================================
// LEGION — бэкенд SDR. В CI и без железа — MockSdrBackend.
// Реальный libbladeRF/Soapy не тащим в ESP32 и не ломаем synthTask.
// LAN для xA4 = SoapyRemote на шлюзе (факт Nuand: USB 3.0 only).
// ============================================================================
import { SDR_CATALOG } from "./catalog";
import { validateFlashJob } from "./firmware";
import type {
  Detection,
  FlashJob,
  FlashResult,
  SdrDeviceInfo,
  ScanBin,
  TxCueResult,
} from "./types";

/** Модель host-retune (USB/Soapy), не FPGA schedule_retune. */
export const SDR_TX_US = { usb3: 200, usb2: 1000, ethernet: 500 } as const;

export interface SdrBackend {
  probe(): SdrDeviceInfo[];
  open(id: string, remoteArgs?: string): { ok: boolean; reason: string };
  close(): void;
  opened(): SdrDeviceInfo | null;
  remoteArgs(): string;
  analogBwMhz(): number;
  canTx(): boolean;
  fullDuplex(): boolean;
  flash(job: FlashJob): FlashResult;
  injectTone(freqMhz: number, powerDbm: number): void;
  clearTones(): void;
  scanWindow(centerMhz: number, bwMhz: number, bins: number): ScanBin[];
  /** Перестройка TX LO в том же процессе, что и RX. Не включает PA/RF ESP32. */
  txCue(freqMhz: number): TxCueResult;
  txOff(): void;
  lastTxMhz(): number | null;
}

function noiseAt(freqMhz: number): number {
  // Гладкий «пол» без крипто-случайности — тесты детерминированы.
  const w = Math.sin(freqMhz * 0.017) * 1.5;
  return -92 + w;
}

export class MockSdrBackend implements SdrBackend {
  private device: SdrDeviceInfo | null = null;
  private remote = "";
  private tones: Array<{ f: number; p: number }> = [];
  private txMhz: number | null = null;
  /** false: не притворяемся, что кабель и FPGA живые. */
  emulation: boolean;

  constructor(opts: { emulation?: boolean } = {}) {
    this.emulation = opts.emulation !== false;
  }

  setEmulation(v: boolean): void {
    this.emulation = v;
    if (!v) this.close();
  }

  probe(): SdrDeviceInfo[] {
    return SDR_CATALOG.map((e, i) => ({
      ...e,
      serial: this.emulation ? `MOCK-${e.id}-${i + 1}` : "",
      present: this.emulation,
    }));
  }

  open(id: string, remoteArgs = ""): { ok: boolean; reason: string } {
    if (!this.emulation) {
      return {
        ok: false,
        reason: "нет эмуляции и нет Soapy/bladeRF в этом процессе — это не эфир",
      };
    }
    const row = this.probe().find((d) => d.id === id);
    if (!row) return { ok: false, reason: "устройство не в каталоге" };
    this.device = row;
    this.remote = remoteArgs;
    return {
      ok: true,
      reason: `ЭМУЛЯЦИЯ ${row.name} — IQ/TX модель хоста, не кабель` + (remoteArgs ? ` · args ${remoteArgs}` : ""),
    };
  }

  close(): void {
    this.device = null;
    this.remote = "";
    this.txMhz = null;
  }

  analogBwMhz(): number {
    return this.device?.analogBwMhz ?? 20;
  }

  canTx(): boolean {
    return this.device?.role === "trx" && this.device.txMhz !== null;
  }

  fullDuplex(): boolean {
    return this.device?.fullDuplex === true;
  }

  opened(): SdrDeviceInfo | null {
    return this.device;
  }

  remoteArgs(): string {
    return this.remote;
  }

  flash(job: FlashJob): FlashResult {
    if (!this.device) return { ok: false, kind: "unknown", reason: "SDR не открыт", written: false };
    const v = validateFlashJob({ ...job, deviceId: this.device.id });
    if (!v.ok) return { ...v, written: false };
    return {
      ...v,
      ok: false,
      written: false,
      reason: `${v.reason} · в железо не записано (нет bladeRF-cli / uhd_image_loader в процессе)`,
    };
  }

  injectTone(freqMhz: number, powerDbm: number): void {
    this.tones = this.tones.filter((t) => Math.abs(t.f - freqMhz) > 1e-6);
    this.tones.push({ f: freqMhz, p: powerDbm });
  }

  clearTones(): void {
    this.tones = [];
  }

  txCue(freqMhz: number): TxCueResult {
    if (!this.device) {
      return { ok: false, reason: "SDR не открыт", freqMhz, latencyUs: 0, path: "none" };
    }
    if (!this.canTx()) {
      return {
        ok: false,
        reason: "нет TX на этом SDR — усилитель подключать некуда",
        freqMhz,
        latencyUs: 0,
        path: "none",
      };
    }
    const range = this.device.txMhz;
    if (!range || freqMhz < range[0] || freqMhz > range[1]) {
      return { ok: false, reason: "TX вне диапазона SDR", freqMhz, latencyUs: 0, path: "none" };
    }
    this.txMhz = freqMhz;
    const latencyUs = SDR_TX_US[this.device.iface];
    const half = this.fullDuplex() ? "" : " (half-duplex: RX на этом устройстве паузится)";
    return {
      ok: true,
      reason: `SDR TX LO ${freqMhz.toFixed(6)} МГц · модель host ${latencyUs} µs${half}`,
      freqMhz,
      latencyUs,
      path: "sdr-tx",
    };
  }

  txOff(): void {
    this.txMhz = null;
  }

  lastTxMhz(): number | null {
    return this.txMhz;
  }

  scanWindow(centerMhz: number, bwMhz: number, bins: number): ScanBin[] {
    const n = Math.max(8, Math.min(bins, 4096));
    const half = bwMhz / 2;
    const out: ScanBin[] = [];
    for (let i = 0; i < n; i++) {
      const freqMhz = centerMhz - half + (bwMhz * i) / (n - 1);
      let power = noiseAt(freqMhz);
      for (const t of this.tones) {
        const df = Math.abs(t.f - freqMhz);
        if (df <= bwMhz / n) {
          power = Math.max(power, t.p);
        }
      }
      out.push({ freqMhz, powerDbm: power });
    }
    return out;
  }
}

export function detectFromBins(
  bins: readonly ScanBin[],
  thresholdDb: number,
): Detection[] {
  if (bins.length === 0) return [];
  const sorted = [...bins].map((b) => b.powerDbm).sort((a, b) => a - b);
  const noiseDbm = sorted[Math.floor(sorted.length * 0.2)] ?? sorted[0];
  const hits: Detection[] = [];
  for (const b of bins) {
    const snr = b.powerDbm - noiseDbm;
    if (snr >= thresholdDb) {
      hits.push({
        freqMhz: b.freqMhz,
        powerDbm: b.powerDbm,
        noiseDbm,
        snrDb: snr,
        ts: 0,
        forwarded: false,
      });
    }
  }
  return mergeNeighbors(hits);
}

function mergeNeighbors(hits: Detection[]): Detection[] {
  if (hits.length === 0) return [];
  const out: Detection[] = [];
  let cur = { ...hits[0] };
  for (let i = 1; i < hits.length; i++) {
    const h = hits[i];
    if (Math.abs(h.freqMhz - cur.freqMhz) < 0.25) {
      if (h.powerDbm > cur.powerDbm) cur = { ...h };
    } else {
      out.push(cur);
      cur = { ...h };
    }
  }
  out.push(cur);
  return out;
}
