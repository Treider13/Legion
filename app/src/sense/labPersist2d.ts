// ============================================================================
// LEGION — RTSA persistence. 1:1 с pavsa PersistentDisplay.java
// (hackrf-spectrum-analyzer). Палитра — HotIronBluePalette.java.
// Каждый бин = +1 в пиксель (x=частота, y=дБм). Спад EMA:
//   order = persistSec * updatesPerSec; k = 2/(order+1); data *= (1-k).
// Пока не набрана 1 с калибровки FPS — холст пустой (у них так же).
// ============================================================================
import type { ScanBin } from "../sdr/types";
import { finiteDbm } from "./labPsd";
import { hotIronBlueNorm } from "./hotIronBlue";

export const RTS_PERSIST_SEC = 5;
export const RTS_CALIBRATE_MS = 1000;

export class PersistentDisplay {
  readonly width: number;
  readonly height: number;
  readonly persistSec: number;
  private data: Float32Array;
  private calibrated = false;
  private calibrating = false;
  private calibStarted = 0;
  private incoming = 0;
  private updatesPerSec = 1;

  constructor(width = 320, height = 160, persistSec = RTS_PERSIST_SEC) {
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this.persistSec = persistSec;
    this.data = new Float32Array(this.width * this.height);
  }

  reset(): void {
    this.data.fill(0);
    this.calibrated = false;
    this.calibrating = false;
    this.incoming = 0;
    this.updatesPerSec = 1;
  }

  push(bins: readonly ScanBin[], yMin: number, yMax: number, nowMs: number): void {
    if (!this.calibrated) {
      if (!this.calibrating) {
        this.calibrating = true;
        this.calibStarted = nowMs;
        this.incoming = 0;
      } else {
        this.incoming += 1;
        const t = nowMs - this.calibStarted;
        if (t >= RTS_CALIBRATE_MS) {
          this.updatesPerSec = Math.max(1, this.incoming / (t / 1000));
          this.calibrated = true;
          this.calibrating = false;
        }
      }
      return;
    }

    const order = this.persistSec * this.updatesPerSec;
    const k = 2 / (order + 1);
    const decay = 1 - k;
    for (let i = 0; i < this.data.length; i++) this.data[i] *= decay;

    const range = yMax - yMin;
    if (!(range > 0) || bins.length === 0) return;
    const hDiv = -this.height / range;
    const maxAcc = this.updatesPerSec * this.persistSec;
    for (let i = 0; i < bins.length; i++) {
      const p = bins[i].powerDbm;
      if (!finiteDbm(p)) continue;
      const x = Math.floor((i * this.width) / bins.length);
      const y = Math.floor((p - yMin) * hDiv + this.height);
      if (x < 0 || y < 0 || x >= this.width || y >= this.height) continue;
      const idx = y * this.width + x;
      if (this.data[idx] < maxAcc) this.data[idx] += 1;
    }
  }

  /** Лог-сжатие + HotIronBlue, как drawSpectrumFloat renderImage. */
  renderRgba(out: Uint8ClampedArray): void {
    const setToZero = 0.01;
    const minOut = 1;
    const maxOut = 100;
    const logMin = Math.log10(minOut);
    const logMax = Math.log10(maxOut);
    let maxVal = Number.MIN_VALUE;
    for (let i = 0; i < this.data.length; i++) if (this.data[i] > maxVal) maxVal = this.data[i];
    if (!(maxVal > 0)) {
      out.fill(0);
      return;
    }
    for (let i = 0; i < this.data.length; i++) {
      let val = this.data[i];
      if (val < setToZero) val = 0;
      const o = i * 4;
      if (val === 0) {
        out[o] = 0;
        out[o + 1] = 0;
        out[o + 2] = 0;
        out[o + 3] = 0;
        continue;
      }
      const mapped = minOut + (val / maxVal) * (maxOut - minOut);
      const compressed = Math.log10(mapped);
      const norm = ((compressed - logMin) / (logMax - logMin)) * (0.95 - 0.15) + 0.15;
      const [r, g, b] = hotIronBlueNorm(norm);
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
      out[o + 3] = 210;
    }
  }
}
