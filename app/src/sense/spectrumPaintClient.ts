// Один поток на оба холста. Сортировка FFT и свёртка в колонки живут здесь.
// Если поток не поднялся, тот же расчёт выполняется один раз на новый спектр,
// а не на каждом кадре окна.

import {
  buildSpectrumPaint,
  packTrace,
  type PackedTrace,
  type SpectrumPaintBuilt,
} from "./spectrumPaint";

export type SpectrumPaintResult = SpectrumPaintBuilt & { id: number };

type Job = {
  f1: number;
  f2: number;
  cols: number;
  traces: readonly (readonly { freqMhz: number; powerDbm: number }[])[];
  waterfall: { bins: readonly { freqMhz: number; powerDbm: number }[]; cols: number } | null;
};

type WorkerMsg = {
  id: number;
  f1: number;
  f2: number;
  cols: number;
  traces: PackedTrace[];
  waterfall: { freq: Float64Array; dbm: Float64Array; cols: number } | null;
};

let worker: Worker | null = null;
let failed = false;
let seq = 0;
const pending = new Map<number, (result: SpectrumPaintResult | null) => void>();

function takeBuffer(seen: Set<ArrayBuffer>, transfer: ArrayBuffer[], buf: ArrayBufferLike): void {
  const raw = buf as ArrayBuffer;
  if (seen.has(raw)) return;
  seen.add(raw);
  transfer.push(raw);
}

function ensureWorker(): Worker | null {
  if (failed) return null;
  if (worker) return worker;
  if (typeof Worker === "undefined") {
    failed = true;
    return null;
  }
  try {
    worker = new Worker(new URL("./spectrumPaint.worker.ts", import.meta.url), { type: "module" });
  } catch {
    failed = true;
    return null;
  }
  worker.onmessage = (ev: MessageEvent<SpectrumPaintResult>) => {
    const id = ev.data?.id;
    const done = pending.get(id);
    if (!done) return;
    pending.delete(id);
    done(ev.data);
  };
  worker.onerror = () => {
    failed = true;
    worker = null;
    for (const done of pending.values()) done(null);
    pending.clear();
  };
  return worker;
}

export function requestSpectrumPaint(job: Job, onResult: (result: SpectrumPaintResult | null) => void): number {
  const id = ++seq;
  const traces = job.traces.map((bins) => packTrace(bins));
  const waterfall =
    job.waterfall == null
      ? null
      : job.waterfall.bins === job.traces[0]
        ? { freq: traces[0]?.freq ?? new Float64Array(), dbm: traces[0]?.dbm ?? new Float64Array(), cols: job.waterfall.cols }
        : { ...packTrace(job.waterfall.bins), cols: job.waterfall.cols };
  const msg: WorkerMsg = { id, f1: job.f1, f2: job.f2, cols: job.cols, traces, waterfall };
  const finish = (built: SpectrumPaintBuilt | null) => {
    if (!built) {
      onResult(null);
      return;
    }
    onResult({ id, scales: built.scales, columns: built.columns, waterfall: built.waterfall });
  };
  const thread = ensureWorker();
  if (!thread) {
    const built = buildSpectrumPaint(msg);
    queueMicrotask(() => finish(built));
    return id;
  }
  pending.set(id, finish);
  try {
    const seen = new Set<ArrayBuffer>();
    const transfer: ArrayBuffer[] = [];
    for (const trace of traces) {
      takeBuffer(seen, transfer, trace.freq.buffer);
      takeBuffer(seen, transfer, trace.dbm.buffer);
    }
    if (waterfall) {
      takeBuffer(seen, transfer, waterfall.freq.buffer);
      takeBuffer(seen, transfer, waterfall.dbm.buffer);
    }
    thread.postMessage(msg, transfer);
  } catch {
    pending.delete(id);
    failed = true;
    worker = null;
    finish(buildSpectrumPaint(msg));
  }
  return id;
}
