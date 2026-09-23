import { fft } from "./fft";

/** Поля из XML рядом с IQ. Байты снимка лежат отдельно и здесь не переписываются. */
export interface CaptureMeta {
  sourceRepo: string;
  sourceCommit: string;
  sourcePath: string;
  sourceMeta: string;
  device: string;
  dataType: string;
  centerHz: number;
  sampleRate: number;
  ifBandwidthHz: number;
  decimation: number;
}

export interface CaptureView {
  meta: CaptureMeta;
  sampleCount: number;
  seconds: number;
  fftSize: number;
  frameCount: number;
  /** дБ относительно медианы среднего спектра, после fftshift. Кадр подряд. */
  frames: Float32Array;
  avgDb: Float32Array;
  peakHz: number;
  peakDb: number;
  /** Ширина пика по уровню −6 дБ, Гц. */
  widthHz: number;
  loHz: number;
  hiHz: number;
}

export const FFT_SIZE = 1024;
const IQ_URL = "/demo/signalhound/capture.iq";
const META_URL = "/demo/signalhound/meta.json";

function isMeta(value: unknown): value is CaptureMeta {
  if (!value || typeof value !== "object") return false;
  const m = value as CaptureMeta;
  return (
    m.dataType === "Complex Short" &&
    typeof m.centerHz === "number" &&
    typeof m.sampleRate === "number" &&
    m.sampleRate > 0 &&
    typeof m.ifBandwidthHz === "number" &&
    m.ifBandwidthHz > 0 &&
    typeof m.device === "string" &&
    typeof m.sourceRepo === "string" &&
    typeof m.sourceCommit === "string" &&
    typeof m.sourcePath === "string"
  );
}

export function analyzeIq(buffer: ArrayBuffer, meta: CaptureMeta): CaptureView {
  if (buffer.byteLength % 4 !== 0) {
    throw new Error("длина IQ не кратна паре int16");
  }
  const sampleCount = buffer.byteLength / 4;
  const frameCount = Math.floor(sampleCount / FFT_SIZE);
  if (frameCount < 1) throw new Error("в снимке меньше одного окна БПФ");

  const view = new DataView(buffer);
  let sumI = 0;
  let sumQ = 0;
  for (let i = 0; i < sampleCount; i++) {
    sumI += view.getInt16(i * 4, true);
    sumQ += view.getInt16(i * 4 + 2, true);
  }
  const meanI = sumI / sampleCount;
  const meanQ = sumQ / sampleCount;

  const hann = new Float32Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) {
    hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1));
  }

  const power = new Float64Array(frameCount * FFT_SIZE);
  const acc = new Float64Array(FFT_SIZE);
  const re = new Float32Array(FFT_SIZE);
  const im = new Float32Array(FFT_SIZE);

  for (let frame = 0; frame < frameCount; frame++) {
    for (let i = 0; i < FFT_SIZE; i++) {
      const off = (frame * FFT_SIZE + i) * 4;
      re[i] = (view.getInt16(off, true) - meanI) * hann[i];
      im[i] = (view.getInt16(off + 2, true) - meanQ) * hann[i];
    }
    fft(re, im);
    for (let i = 0; i < FFT_SIZE; i++) {
      const src = (i + FFT_SIZE / 2) % FFT_SIZE;
      const p = re[src] * re[src] + im[src] * im[src];
      power[frame * FFT_SIZE + i] = p;
      acc[i] += p;
    }
  }

  const avgLog = new Float64Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) {
    avgLog[i] = 10 * Math.log10(acc[i] / frameCount + 1e-12);
  }
  const sorted = Array.from(avgLog).sort((a, b) => a - b);
  const median = sorted[FFT_SIZE >> 1];

  const avgDb = new Float32Array(FFT_SIZE);
  let peak = 0;
  for (let i = 0; i < FFT_SIZE; i++) {
    avgDb[i] = avgLog[i] - median;
    if (avgDb[i] > avgDb[peak]) peak = i;
  }
  const frames = new Float32Array(power.length);
  for (let i = 0; i < power.length; i++) {
    frames[i] = 10 * Math.log10(power[i] + 1e-12) - median;
  }

  const peakDb = avgDb[peak];
  const floor = peakDb - 6;
  let left = peak;
  let right = peak;
  while (left > 0 && avgDb[left - 1] >= floor) left -= 1;
  while (right < FFT_SIZE - 1 && avgDb[right + 1] >= floor) right += 1;

  const binHz = meta.sampleRate / FFT_SIZE;
  return {
    meta,
    sampleCount,
    seconds: sampleCount / meta.sampleRate,
    fftSize: FFT_SIZE,
    frameCount,
    frames,
    avgDb,
    peakHz: meta.centerHz + (peak - FFT_SIZE / 2) * binHz,
    peakDb,
    widthHz: (right - left + 1) * binHz,
    loHz: meta.centerHz - meta.ifBandwidthHz / 2,
    hiHz: meta.centerHz + meta.ifBandwidthHz / 2,
  };
}

export async function loadCapture(signal?: AbortSignal): Promise<CaptureView> {
  const metaResp = await fetch(META_URL, { signal });
  if (!metaResp.ok) throw new Error("метаданные снимка не открылись");
  const meta: unknown = await metaResp.json();
  if (!isMeta(meta)) throw new Error("метаданные снимка не читаются");
  const iqResp = await fetch(IQ_URL, { signal });
  if (!iqResp.ok) throw new Error("файл снимка не открылся");
  return analyzeIq(await iqResp.arrayBuffer(), meta);
}

export function sourceHref(meta: CaptureMeta): string {
  return `${meta.sourceRepo}/blob/${meta.sourceCommit}/${meta.sourcePath}`;
}
