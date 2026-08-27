// Главный старт: те же API, что СКАН + ПЕРЕДАТЬ / КОРИДОР. FPGA ARM сюда не входит.
import type { WaveKind } from "../../sdr/waveforms";
import { useLegion } from "../../state/store";

export type CinemaMode = "sdr" | "esp32";

export async function runSmartStart(opts: {
  f1: string;
  f2: string;
  wave: WaveKind;
  loadOk: boolean;
}): Promise<void> {
  const s = useLegion.getState();
  s.setWorkspace("scan");
  s.setSdrAllowField("sdrF1", opts.f1);
  s.setSdrAllowField("sdrF2", opts.f2);
  s.clearSdrBands();
  s.setScanPattern("auto");
  s.setSdrLoad(opts.loadOk);
  s.armTxWave(opts.wave);
  await s.startTransmit();
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
  if (s.transmitArmed || s.signalTxActive) await s.stopTransmit();
  if (s.scanRunning) s.stopScan();
  if (s.corridorRunning) await s.corridorStop();
}

export function cinemaIsLive(s: {
  scanRunning: boolean;
  transmitArmed: boolean;
  corridorRunning: boolean;
  signalTxActive: boolean;
}): boolean {
  return s.scanRunning || s.transmitArmed || s.corridorRunning || s.signalTxActive;
}
