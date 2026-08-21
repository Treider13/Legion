// ============================================================================
// LEGION — что официальный образ SDR обязан уметь в режиме 1.
// Не RF-Clown / не BlueJammer: те — ESP32 + nRF24, шум 2.4 ГГц, другой тракт.
// ============================================================================
import { classifyFirmware } from "./firmware";
import type { FirmwareKind } from "./types";

export type SdrTask = "rx-scan+tx-lo" | "rx-only" | "none";

const JAM_NAME =
  /rf-?clown|blue-?jammer|bluejammer|nrf24|nrf24l01|jammer|bt.?jam|ble.?jam|wifi.?jam/i;

/** Чужой jam-бинарий (RF-Clown / BlueJammer / nRF24) в SDR FPGA не принимаем. */
export function rejectAlienFirmware(filename: string): string | null {
  const base = filename.split(/[/\\]/).pop() ?? filename;
  if (JAM_NAME.test(base)) {
    return "отклонён чужой образ (RF-Clown / BlueJammer / nRF24) — это не hosted FPGA SDR";
  }
  return null;
}

/**
 * Замысел режима SDR: RX energy-detect + TX LO на RF out → усилитель.
 * FX3 без hosted FPGA RX+TX не даёт. RTL — только RX.
 */
export function firmwareDoesTask(kind: FirmwareKind, deviceId: string): {
  ok: boolean;
  task: SdrTask;
  rx: boolean;
  tx: boolean;
  reason: string;
} {
  if (deviceId === "rtl-sdr") {
    return { ok: false, task: "rx-only", rx: true, tx: false, reason: "RTL только RX — усилитель не к чему" };
  }
  if (kind === "fx3" || kind === "uhd-n210-fw" || kind === "hackrf-fw") {
    return {
      ok: false,
      task: "none",
      rx: false,
      tx: false,
      reason: "это MCU/FX3, не hosted FPGA: RX+TX LO ещё нет",
    };
  }
  const hosted =
    kind === "fpga-a4" ||
    kind === "fpga-a9" ||
    kind === "fpga-a5" ||
    kind === "pluto-frm" ||
    kind === "uhd-n210-fpga" ||
    kind === "lime-img";
  if (hosted) {
    return {
      ok: true,
      task: "rx-scan+tx-lo",
      rx: true,
      tx: true,
      reason: "офиц. hosted: скан RX + TX LO на RF out",
    };
  }
  return { ok: false, task: "none", rx: false, tx: false, reason: `образ ${kind} задачу режима SDR не закрывает` };
}

export function firmwareFileDoesTask(filename: string, deviceId: string) {
  const alien = rejectAlienFirmware(filename);
  if (alien) {
    return { ok: false, task: "none" as SdrTask, rx: false, tx: false, reason: alien };
  }
  return firmwareDoesTask(classifyFirmware(filename), deviceId);
}
