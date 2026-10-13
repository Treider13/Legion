import { buildSpectrumPaint, type PackedTrace, type SpectrumPaintBuilt } from "./spectrumPaint";

type InMsg = {
  id: number;
  f1: number;
  f2: number;
  cols: number;
  traces: PackedTrace[];
  waterfall: { freq: Float64Array; dbm: Float64Array; cols: number } | null;
};

const scope = globalThis as unknown as {
  onmessage: ((ev: MessageEvent<InMsg>) => void) | null;
  postMessage: (data: unknown, transfer?: Transferable[]) => void;
};

scope.onmessage = (ev) => {
  const msg = ev.data;
  const built: SpectrumPaintBuilt = buildSpectrumPaint(msg);
  const transfer: Transferable[] = [];
  for (const col of built.columns) transfer.push(col.buffer);
  if (built.waterfall) transfer.push(built.waterfall.buffer);
  scope.postMessage({ id: msg.id, scales: built.scales, columns: built.columns, waterfall: built.waterfall }, transfer);
};
