// ============================================================================
// LEGION — журнал лабораторного стенда вокруг живого lb_gated / хост-Welch.
// Источники (код, не README):
//   rtl-sdr-analyzer: тройной порог (SNR + мин. ширина + min_duration 0.1 с).
//     Их баг — спам события на каждый бин. У нас кластер + min_duration
//     ТОЛЬКО в журнале. Гейт FPGA / USB-handoff сюда не ходят.
//   jamrf: iperf3 JSON `lost_percent` + `bytes`; JSR MATLAB Pj = JSR * Esig.
//     Не утверждаем «шум всегда лучше тона» — exp1 у них это опроверг.
//   eris: BPER пакетами/батчами, не ML-заглушка.
//   CleverJAM: шаг name/center/look/dwell/wave. Их XML-RPC hop (issue #9)
//     ненадёжен — шаг применяет параметры, ARM не стартует. В UI — поля,
//     JSON только импорт файла.
//   HckRF-Spectral: known/ignore. У них списки пустые — здесь сверка по МГц.
// xA4: RX 70–6000, TX 47–6000, analog ≤56. Частота любая в диапазоне,
// 2450 не зашита. STA/SMA в журнал не пишем как PASS.
// ============================================================================
import { detectFromBins, estimateNoiseFloor } from "../sdr/backend";
import type { ScanBin } from "../sdr/types";
import { WAVE_CATALOG, type WaveKind } from "../sdr/waveforms";
import { width3dbMhz } from "./labPsd";

export const LAB_MIN_DURATION_SEC = 0.1;
export const LAB_MIN_WIDTH_MHZ = 0.05;
export const LAB_LIST_TOL_MHZ = 0.25;
export const XA4_RX_MHZ: [number, number] = [70, 6000];
export const XA4_TX_MHZ: [number, number] = [47, 6000];
export const XA4_ANALOG_MHZ = 56;
export const XA4_LOOK_MIN_MHZ = 0.2;

export type LabEventSource = "host-welch" | "fpga-gate";

export interface LabEvent {
  id: string;
  source: LabEventSource;
  freqMhz: number;
  powerDbm: number | null;
  noiseDbm: number | null;
  snrDb: number | null;
  widthMhz: number;
  /** rtl-sdr-analyzer 3 дБ только у host-welch. FPGA = analog look. */
  widthKind: "3db" | "look";
  startedMs: number;
  endedMs: number;
  durationSec: number;
  duty: number;
  forwarded: boolean;
}

export interface LabOpenBurst {
  key: string;
  source: LabEventSource;
  freqMhz: number;
  powerDbm: number | null;
  noiseDbm: number | null;
  snrDb: number | null;
  widthMhz: number;
  widthKind: "3db" | "look";
  startedMs: number;
  lastSeenMs: number;
  forwarded: boolean;
}

export interface IperfRecord {
  lostPercent: number;
  bytes: number;
  packets: number | null;
  lostPackets: number | null;
  rawKind: "iperf3-json";
  capturedMs: number;
}

export interface BperRecord {
  batchesOk: number;
  batchesBad: number;
  bper: number;
  capturedMs: number;
}

export interface JsrRecord {
  /** Линейное отношение Pj/Esig, не дБ. jamrf: Pj = JSR * Esig. */
  jsr: number;
  jsrDb: number;
  eSig: number;
  pJ: number;
  unit: "linear-power";
  capturedMs: number;
}

export interface LabPlaylistStep {
  name: string;
  centerMhz: number;
  lookMhz: number;
  dwellMs: number;
  wave: WaveKind | null;
}

export interface LabPlaylist {
  name: string;
  steps: LabPlaylistStep[];
}

export interface LabListMatch {
  mhz: number;
  kind: "known" | "ignore";
}

const WAVE_IDS = new Set<string>(WAVE_CATALOG.map((w) => w.id));

export function parseMhzList(text: string): number[] {
  const out: number[] = [];
  for (const part of (text || "").split(/[,;\s]+/)) {
    if (!part) continue;
    const n = Number(part.replace(",", "."));
    if (Number.isFinite(n) && n > 0) out.push(n);
  }
  return out;
}

export function listHits(freqMhz: number, known: readonly number[], ignore: readonly number[], tol = LAB_LIST_TOL_MHZ): LabListMatch | null {
  for (const mhz of ignore) {
    if (Math.abs(mhz - freqMhz) <= tol) return { mhz, kind: "ignore" };
  }
  for (const mhz of known) {
    if (Math.abs(mhz - freqMhz) <= tol) return { mhz, kind: "known" };
  }
  return null;
}

export interface HostPeak {
  freqMhz: number;
  powerDbm: number;
  noiseDbm: number;
  snrDb: number;
  widthMhz: number;
}

/** Тройной порог rtl-sdr-analyzer без записи: SNR + ширина. Длительность — трекер. */
export function hostPeaksForJournal(
  window: readonly ScanBin[],
  thresholdDb: number,
  minWidthMhz: number,
): HostPeak[] {
  if (window.length === 0) return [];
  const painted = window.filter((b) => Number.isFinite(b.powerDbm));
  if (painted.length === 0) return [];
  const noiseDbm = estimateNoiseFloor(painted);
  const dets = detectFromBins(painted, thresholdDb);
  const out: HostPeak[] = [];
  for (const d of dets) {
    const widthMhz = width3dbMhz(painted, d.freqMhz);
    if (widthMhz + 1e-12 < minWidthMhz) continue;
    out.push({
      freqMhz: d.freqMhz,
      powerDbm: d.powerDbm,
      noiseDbm,
      snrDb: d.snrDb,
      widthMhz,
    });
  }
  return out;
}

export function burstKey(source: LabEventSource, freqMhz: number): string {
  return `${source}:${freqMhz.toFixed(3)}`;
}

export class LabEventTracker {
  private open = new Map<string, LabOpenBurst>();
  private seq = 0;

  reset(): void {
    this.open.clear();
  }

  openCount(): number {
    return this.open.size;
  }

  /**
   * Закрывает пропавшие вспышки. Пишет в журнал только если duration ≥ minDuration.
   * Короткий FPGA-гейт (микросекунды) сюда может не попасть — это не отказ гейта.
   */
  ingest(
    live: readonly Omit<LabOpenBurst, "key" | "lastSeenMs" | "startedMs">[],
    nowMs: number,
    minDurationSec: number,
    gapMs = 250,
  ): LabEvent[] {
    const seen = new Set<string>();
    for (const row of live) {
      const key = burstKey(row.source, row.freqMhz);
      seen.add(key);
      const prev = this.open.get(key);
      if (prev) {
        prev.lastSeenMs = nowMs;
        prev.powerDbm = row.powerDbm;
        prev.noiseDbm = row.noiseDbm;
        prev.snrDb = row.snrDb;
        prev.widthMhz = row.widthMhz;
        prev.widthKind = row.widthKind;
        prev.forwarded = prev.forwarded || row.forwarded;
      } else {
        this.open.set(key, {
          ...row,
          key,
          startedMs: nowMs,
          lastSeenMs: nowMs,
        });
      }
    }
    const closed: LabEvent[] = [];
    for (const [key, burst] of [...this.open.entries()]) {
      if (seen.has(key)) continue;
      if (nowMs - burst.lastSeenMs < gapMs) continue;
      this.open.delete(key);
      const durationSec = Math.max(0, (burst.lastSeenMs - burst.startedMs) / 1000);
      if (durationSec + 1e-12 < minDurationSec) continue;
      this.seq += 1;
      closed.push({
        id: `${burst.source}-${burst.startedMs}-${this.seq}`,
        source: burst.source,
        freqMhz: burst.freqMhz,
        powerDbm: burst.powerDbm,
        noiseDbm: burst.noiseDbm,
        snrDb: burst.snrDb,
        widthMhz: burst.widthMhz,
        widthKind: burst.widthKind,
        startedMs: burst.startedMs,
        endedMs: burst.lastSeenMs,
        durationSec,
        duty: 1,
        forwarded: burst.forwarded,
      });
    }
    return closed;
  }
}

/** iperf3 --json: jamrf читает end.sum.lost_percent и bytes. Не выдумываем 80 %. */
export function parseIperfJson(raw: string, nowMs = Date.now()): { ok: true; record: IperfRecord } | { ok: false; reason: string } {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "iperf: это не JSON (нужен iperf3 --json)" };
  }
  if (!data || typeof data !== "object") {
    return { ok: false, reason: "iperf: корень не объект" };
  }
  const sum = (data as { end?: { sum?: Record<string, unknown>; sum_received?: Record<string, unknown> } }).end;
  const block = sum?.sum ?? sum?.sum_received;
  if (!block || typeof block !== "object") {
    return { ok: false, reason: "iperf: нет end.sum / end.sum_received — это не отчёт iperf3" };
  }
  const lostPercent = Number(block.lost_percent);
  const bytes = Number(block.bytes);
  if (!Number.isFinite(lostPercent) || !Number.isFinite(bytes)) {
    return { ok: false, reason: "iperf: lost_percent или bytes не число" };
  }
  const packets = Number(block.packets);
  const lostPackets = Number(block.lost_packets);
  return {
    ok: true,
    record: {
      lostPercent,
      bytes,
      packets: Number.isFinite(packets) ? packets : null,
      lostPackets: Number.isFinite(lostPackets) ? lostPackets : null,
      rawKind: "iperf3-json",
      capturedMs: nowMs,
    },
  };
}

/** eris: BPER = плохие батчи / все батчи. */
export function recordBper(batchesOk: number, batchesBad: number, nowMs = Date.now()): { ok: true; record: BperRecord } | { ok: false; reason: string } {
  if (!Number.isFinite(batchesOk) || !Number.isFinite(batchesBad) || batchesOk < 0 || batchesBad < 0) {
    return { ok: false, reason: "BPER: батчи — неотрицательные числа" };
  }
  const total = batchesOk + batchesBad;
  if (total <= 0) return { ok: false, reason: "BPER: нет ни одного батча" };
  return {
    ok: true,
    record: {
      batchesOk,
      batchesBad,
      bper: batchesBad / total,
      capturedMs: nowMs,
    },
  };
}

/** jamrf MATLAB: заданы любые 2 из (JSR, Esig, Pj). Не подставляем «типичные» дБм. */
export function recordJsr(opts: { jsr?: number; eSig?: number; pJ?: number }, nowMs = Date.now()): { ok: true; record: JsrRecord } | { ok: false; reason: string } {
  let { jsr, eSig, pJ } = opts;
  const haveJsr = jsr != null && Number.isFinite(jsr) && jsr > 0;
  const haveE = eSig != null && Number.isFinite(eSig) && eSig > 0;
  const haveP = pJ != null && Number.isFinite(pJ) && pJ > 0;
  if (haveJsr && haveE && !haveP) pJ = jsr! * eSig!;
  else if (haveJsr && haveP && !haveE) eSig = pJ! / jsr!;
  else if (haveE && haveP && !haveJsr) jsr = pJ! / eSig!;
  else if (haveJsr && haveE && haveP) {
    const expect = jsr! * eSig!;
    if (Math.abs(expect - pJ!) / expect > 0.05) {
      return { ok: false, reason: "JSR: Pj должно быть JSR×Esig (±5 %)" };
    }
  } else {
    return { ok: false, reason: "JSR: нужны две величины из JSR, Esig, Pj (линейные мощности)" };
  }
  if (jsr == null || eSig == null || pJ == null) {
    return { ok: false, reason: "JSR: не собралось три величины" };
  }
  return {
    ok: true,
    record: {
      jsr,
      jsrDb: 10 * Math.log10(jsr),
      eSig,
      pJ,
      unit: "linear-power",
      capturedMs: nowMs,
    },
  };
}

export function inRange(mhz: number, lo: number, hi: number): boolean {
  return Number.isFinite(mhz) && mhz >= lo && mhz <= hi;
}

/** Частоты из прежнего демо-плейлиста журнала + демо-несущая 2442. Не выдуманный диапазон. */
export const LAB_PLAYLIST_PRESETS: readonly LabPlaylistStep[] = [
  { name: "UHF", centerMhz: 433, lookMhz: 2, dwellMs: 0.4, wave: "awgn" },
  { name: "2.4 ГГц", centerMhz: 2442, lookMhz: 2, dwellMs: 1, wave: "tone" },
  { name: "5.8 ГГц", centerMhz: 5800, lookMhz: 10, dwellMs: 1, wave: "tone" },
];

export interface ScannerPlaylistSource {
  signalFreqMhz: string;
  sdrF1: string;
  sdrF2: string;
  fpgaAirBwMhz: string;
  scanWindowMhz: string;
  fpgaTurnDwellMs: string;
  scanDwellMs: string;
  txWaveKind: WaveKind | null;
}

/** Копия уже выставленных полей сканера / типа сигнала. Цифр не придумываем. */
export function playlistStepFromScanner(s: ScannerPlaylistSource): LabPlaylistStep {
  const f1 = Number(String(s.sdrF1).replace(",", "."));
  const f2 = Number(String(s.sdrF2).replace(",", "."));
  const fromBand = Number.isFinite(f1) && Number.isFinite(f2) ? (f1 + f2) / 2 : Number.NaN;
  const typed = Number(String(s.signalFreqMhz).replace(",", "."));
  const centerMhz = Number.isFinite(typed) && typed > 0 ? typed : fromBand;
  const lookTyped = Number(String(s.fpgaAirBwMhz).replace(",", "."));
  const lookWin = Number(String(s.scanWindowMhz).replace(",", "."));
  const lookMhz = Number.isFinite(lookTyped) && lookTyped > 0 ? lookTyped : lookWin;
  const dwellFpga = Number(String(s.fpgaTurnDwellMs).replace(",", "."));
  const dwellScan = Number(String(s.scanDwellMs).replace(",", "."));
  const dwellMs = Number.isFinite(dwellFpga) && dwellFpga > 0 ? dwellFpga : dwellScan;
  return {
    name: "сканер",
    centerMhz,
    lookMhz,
    dwellMs,
    wave: s.txWaveKind,
  };
}

export function buildPlaylist(data: unknown): { ok: true; playlist: LabPlaylist } | { ok: false; reason: string } {
  if (!data || typeof data !== "object") return { ok: false, reason: "playlist: корень не объект" };
  const name = String((data as { name?: unknown }).name ?? "").trim();
  const stepsIn = (data as { steps?: unknown }).steps;
  if (!name) return { ok: false, reason: "playlist: пустое имя" };
  if (!Array.isArray(stepsIn) || stepsIn.length === 0) {
    return { ok: false, reason: "playlist: добавьте хотя бы один шаг" };
  }
  const steps: LabPlaylistStep[] = [];
  for (let i = 0; i < stepsIn.length; i++) {
    const row = stepsIn[i];
    if (!row || typeof row !== "object") {
      return { ok: false, reason: `playlist: шаг ${i + 1} не объект` };
    }
    const stepName = String((row as { name?: unknown }).name ?? `step-${i + 1}`).trim();
    const centerMhz = Number((row as { centerMhz?: unknown }).centerMhz);
    const lookMhz = Number((row as { lookMhz?: unknown }).lookMhz);
    const dwellMs = Number((row as { dwellMs?: unknown }).dwellMs);
    const waveRaw = (row as { wave?: unknown }).wave;
    let wave: WaveKind | null = null;
    if (waveRaw != null && waveRaw !== "" && waveRaw !== "cw") {
      const id = String(waveRaw);
      if (!WAVE_IDS.has(id)) {
        return { ok: false, reason: `playlist: шаг «${stepName}» — волны «${id}» нет в каталоге Legion` };
      }
      wave = id as WaveKind;
    }
    if (!inRange(centerMhz, XA4_RX_MHZ[0], XA4_RX_MHZ[1])) {
      return { ok: false, reason: `playlist: шаг «${stepName}» center ${centerMhz} вне RX xA4 ${XA4_RX_MHZ[0]}–${XA4_RX_MHZ[1]} МГц` };
    }
    if (!Number.isFinite(lookMhz) || lookMhz < XA4_LOOK_MIN_MHZ || lookMhz > XA4_ANALOG_MHZ) {
      return { ok: false, reason: `playlist: шаг «${stepName}» look ${lookMhz} вне 0.2…${XA4_ANALOG_MHZ} МГц (analog xA4)` };
    }
    if (!Number.isFinite(dwellMs) || dwellMs <= 0) {
      return { ok: false, reason: `playlist: шаг «${stepName}» dwell должна быть > 0 мс` };
    }
    steps.push({ name: stepName || `step-${i + 1}`, centerMhz, lookMhz, dwellMs, wave });
  }
  return { ok: true, playlist: { name, steps } };
}

export function parsePlaylistJson(raw: string): { ok: true; playlist: LabPlaylist } | { ok: false; reason: string } {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "playlist: это не JSON" };
  }
  return buildPlaylist(data);
}

export interface PlaylistPatch {
  sdrF1: string;
  sdrF2: string;
  fpgaAirBwMhz: string;
  fpgaTurnDwellMs: string;
  scanWindowMhz: string;
  scanDwellMs: string;
  signalFreqMhz: string;
  txWaveKind: WaveKind | null;
  reason: string;
}

/** Параметры оператора. ARM / startScan не вызываются (CleverJAM #9). */
export function playlistStepPatch(step: LabPlaylistStep): PlaylistPatch {
  const half = step.lookMhz / 2;
  const f1 = Math.max(XA4_RX_MHZ[0], step.centerMhz - half);
  const f2 = Math.min(XA4_RX_MHZ[1], step.centerMhz + half);
  const hostDwell = Math.max(1, Math.round(step.dwellMs));
  return {
    sdrF1: f1.toFixed(3),
    sdrF2: f2.toFixed(3),
    fpgaAirBwMhz: String(step.lookMhz),
    fpgaTurnDwellMs: String(step.dwellMs),
    scanWindowMhz: String(step.lookMhz),
    scanDwellMs: String(hostDwell),
    signalFreqMhz: step.centerMhz.toFixed(3),
    txWaveKind: step.wave,
    reason: `playlist «${step.name}»: центр ${step.centerMhz} МГц · взгляд ${step.lookMhz} · выдержка ${step.dwellMs} мс${step.wave ? ` · ${step.wave}` : " · копия IQ / CW"} · Старт не нажат`,
  };
}

export interface LabJournalFile {
  device: "bladerf-micro-xa4";
  corridorMhz: [number, number];
  baselineTargetSec: number;
  baselineFrozen: boolean;
  coverage: number | null;
  events: LabEvent[];
  iperf: IperfRecord | null;
  bper: BperRecord | null;
  jsr: JsrRecord | null;
  playlist: LabPlaylist | null;
  knownMhz: number[];
  ignoreMhz: number[];
  staSma: "FAIL-closed";
  note: string;
}

export function buildLabJournal(opts: {
  f1: number;
  f2: number;
  baselineTargetSec: number;
  baselineFrozen: boolean;
  coverage: number | null;
  events: readonly LabEvent[];
  iperf: IperfRecord | null;
  bper: BperRecord | null;
  jsr: JsrRecord | null;
  playlist: LabPlaylist | null;
  knownMhz: number[];
  ignoreMhz: number[];
}): LabJournalFile {
  return {
    device: "bladerf-micro-xa4",
    corridorMhz: [opts.f1, opts.f2],
    baselineTargetSec: opts.baselineTargetSec,
    baselineFrozen: opts.baselineFrozen,
    coverage: opts.coverage,
    events: [...opts.events],
    iperf: opts.iperf,
    bper: opts.bper,
    jsr: opts.jsr,
    playlist: opts.playlist,
    knownMhz: opts.knownMhz,
    ignoreMhz: opts.ignoreMhz,
    staSma: "FAIL-closed",
    note:
      "Журнал хоста. Гейт lb_gated на плате не ждёт min_duration. " +
      "STA/SMA остаются FAIL-closed, пока нет Quartus на этой машине и кабеля 50 Ом на стенде оператора. " +
      "lost_percent и BPER — только iperf3 --json (автопрогон или вставка). STA/SMA без квартуса остаются закрытыми.",
  };
}
