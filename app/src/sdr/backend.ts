// ============================================================================
// LEGION — бэкенд SDR. В CI и без железа — MockSdrBackend.
// Реальный libbladeRF/Soapy не тащим в ESP32 и не ломаем synthTask.
// LAN для xA4 = SoapyRemote на шлюзе (факт Nuand: USB 3.0 only).
// ============================================================================
import { SDR_CATALOG } from "./catalog";
import { validateFlashJob } from "./firmware";
import type { Detection, FlashJob, FlashResult, SdrDeviceInfo, ScanBin } from "./types";

export interface SdrBackend {
  probe(): SdrDeviceInfo[];
  open(id: string, remoteArgs?: string): { ok: boolean; reason: string };
  close(): void;
  opened(): SdrDeviceInfo | null;
  remoteArgs(): string;
  flash(job: FlashJob): FlashResult;
  injectTone(freqMhz: number, powerDbm: number): void;
  clearTones(): void;
  scanWindow(centerMhz: number, bwMhz: number, bins: number): ScanBin[];
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

  probe(): SdrDeviceInfo[] {
    return SDR_CATALOG.map((e, i) => ({
      ...e,
      serial: `MOCK-${e.id}-${i + 1}`,
      present: true,
    }));
  }

  open(id: string, remoteArgs = ""): { ok: boolean; reason: string } {
    const row = this.probe().find((d) => d.id === id);
    if (!row) return { ok: false, reason: "устройство не в каталоге" };
    this.device = row;
    this.remote = remoteArgs;
    return {
      ok: true,
      reason: row.nativeEthernet
        ? `открыт ${row.name} (нативный Ethernet)`
        : remoteArgs
          ? `открыт ${row.name} через шлюз ${remoteArgs}`
          : `открыт ${row.name} (локальный USB-мок)`,
    };
  }

  close(): void {
    this.device = null;
    this.remote = "";
  }

  opened(): SdrDeviceInfo | null {
    return this.device;
  }

  remoteArgs(): string {
    return this.remote;
  }

  flash(job: FlashJob): FlashResult {
    if (!this.device) return { ok: false, kind: "unknown", reason: "SDR не открыт" };
    return validateFlashJob({ ...job, deviceId: this.device.id });
  }

  injectTone(freqMhz: number, powerDbm: number): void {
    this.tones = this.tones.filter((t) => Math.abs(t.f - freqMhz) > 1e-6);
    this.tones.push({ f: freqMhz, p: powerDbm });
  }

  clearTones(): void {
    this.tones = [];
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
