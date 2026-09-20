// Главный старт: ESP32-коридор, онбордовый перехват (плата смотрит эфир)
// или FPGA-ревизия legion без онбордового обзора (эфир-стоянка/обход, генерация).
import type { WaveKind } from "../../sdr/waveforms";
import type { FpgaSoloPattern } from "../../sense/fpgaSoloWalk";
import type { AutoDispatch } from "../../sense/modes";
import { useLegion } from "../../state/store";

export type CinemaMode = "sdr" | "esp32";
export type FpgaStartPath = "solo" | "air" | "auto";

export async function runSmartStart(opts: {
  f1: string;
  f2: string;
  wave: WaveKind;
  loadOk: boolean;
  path: FpgaStartPath;
  windowMhz?: string;
  dwellMs?: string;
  pattern?: FpgaSoloPattern;
  /** Умная атака: приоритет сильнейшей или очередь с выдержкой. */
  dispatch?: AutoDispatch;
  /** Умная атака: порог I²+Q² (полка USB-IQ в круге не меряется). */
  detThr?: string;
}): Promise<boolean> {
  const s = useLegion.getState();
  s.setWorkspace("scan");
  s.setSdrAllowField("sdrF1", opts.f1);
  s.setSdrAllowField("sdrF2", opts.f2);
  s.clearSdrBands();
  s.setSdrLoad(opts.loadOk);
  if (opts.path === "auto") {
    // Онбордовый перехват: после Старта хозяин — SDR. Ноутбук — рубильник.
    s.setScanPattern("fpga");
    if (opts.dispatch) s.setAutoDispatch(opts.dispatch);
    if (opts.windowMhz !== undefined) s.setFpgaAirBwMhz(opts.windowMhz);
    if (opts.dwellMs !== undefined) s.setFpgaTurnDwellMs(opts.dwellMs);
    if (opts.detThr !== undefined) s.setFpgaDetThr(parseFloat(opts.detThr));
    s.startScan();
    if (useLegion.getState().sdrEmulation) return true;
    const t0 = Date.now();
    while (Date.now() - t0 < 8000) {
      const st = useLegion.getState();
      if (st.fpgaBusy || st.fpgaArmed) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  }
  s.armTxWave(opts.wave);
  if (opts.path === "air") {
    // Эфир-обход: окно шага = канал подавления; выдержка/порядок — свои поля.
    if (opts.windowMhz !== undefined) s.setFpgaAirBwMhz(opts.windowMhz);
    if (opts.dwellMs !== undefined) s.setFpgaAirDwellMs(opts.dwellMs);
    if (opts.pattern !== undefined) s.setFpgaAirWalkPattern(opts.pattern);
    // Ручной порог — для одной стоянки; при обходе коридора пороги меряются
    // калибровочным проходом и едут в tune (см. startFpgaPath).
    if (opts.detThr !== undefined) s.setFpgaDetThr(parseFloat(opts.detThr));
  } else {
    if (opts.windowMhz !== undefined) s.setFpgaSoloWindowMhz(opts.windowMhz);
    if (opts.dwellMs !== undefined) s.setFpgaSoloDwellMs(opts.dwellMs);
    if (opts.pattern !== undefined) s.setFpgaSoloPattern(opts.pattern);
  }
  return s.startFpgaPath(opts.path);
}

export async function runSimpleStart(opts: { f1: string; f2: string; loadOk: boolean }): Promise<void> {
  const s = useLegion.getState();
  s.setWorkspace("corridor");
  s.setCorrField("corrF1", opts.f1);
  s.setCorrField("corrF2", opts.f2);
  if (opts.loadOk) await s.setLoad(true);
  if (s.transportState !== "connected") await s.connect();
  if (useLegion.getState().transportState !== "connected") return;
  await s.corridorStart();
}

export async function runCinemaStop(): Promise<void> {
  const s = useLegion.getState();
  // Старт в полёте (capture/park): fpgaArmed ещё false — DISARM не зовём,
  // но поколения бампаем. Solo читает gFpgaSoloGen. Эфир / handoff читают
  // gFpgaAirGen — без abortFpgaAir клик Стоп во время parkFpgaLo эфира
  // доходил до AIR_PREP (кино live из-за fpgaBusy).
  s.abortFpgaSolo();
  s.abortFpgaAir();
  // Ручной ARM панели тоже в полёте виден как fpgaBusy — Стоп обязан
  // отозвать и его, иначе кнопка видна, но ARM доезжает.
  s.abortFpgaArm();
  if (s.fpgaArmed) await s.fpgaDisarm();
  if (s.transmitArmed || s.signalTxActive) await s.stopTransmit();
  if (s.scanRunning) s.stopScan();
  if (s.corridorRunning) await s.corridorStop();
}

export function cinemaIsLive(s: {
  scanRunning: boolean;
  transmitArmed: boolean;
  corridorRunning: boolean;
  signalTxActive: boolean;
  fpgaArmed: boolean;
  fpgaBusy: boolean;
}): boolean {
  return s.scanRunning || s.transmitArmed || s.corridorRunning || s.signalTxActive || s.fpgaArmed || s.fpgaBusy;
}
