// ============================================================================
// LEGION — проверка образа SDR до прошивки.
// Не пишет в железо: только имя/размер/совместимость с каталогом.
// Официальные имена Nuand: hostedxA4.rbf / bladeRF.img (man bladeRF-cli).
// ============================================================================
import { catalogById } from "./catalog";
import type { FirmwareKind, FlashJob, FlashResult } from "./types";

const KINDS: Array<{ re: RegExp; kind: FirmwareKind }> = [
  { re: /hosted\s*x?a4|\.xa4\.|fpgaa4|hostedxA4/i, kind: "fpga-a4" },
  { re: /hosted\s*x?a5|hostedxA5|fpgaa5/i, kind: "fpga-a5" },
  { re: /hosted\s*x?a9|hostedxA9|fpgaa9/i, kind: "fpga-a9" },
  { re: /hostedx40|fpga40/i, kind: "fpga-x40" },
  { re: /hostedx115|fpga115/i, kind: "fpga-x115" },
  { re: /bladerf.*\.img$|fx3|\.fw$/i, kind: "fx3" },
];

export function classifyFirmware(filename: string): FirmwareKind {
  const base = filename.split(/[/\\]/).pop() ?? filename;
  for (const row of KINDS) {
    if (row.re.test(base)) return row.kind;
  }
  return "unknown";
}

const DEVICE_KINDS: Record<string, FirmwareKind[]> = {
  "bladerf-micro-xa4": ["fx3", "fpga-a4"],
  "bladerf-micro-xa9": ["fx3", "fpga-a9"],
  "hackrf-one": ["unknown"],
  "limesdr-usb": ["unknown"],
  plutosdr: ["unknown"],
  "usrp-b210": ["unknown"],
  "usrp-n210": ["unknown"],
  "rtl-sdr": [],
};

export function validateFlashJob(job: FlashJob): FlashResult {
  const entry = catalogById(job.deviceId);
  if (!entry) {
    return { ok: false, kind: "unknown", reason: "неизвестный deviceId" };
  }
  if (job.byteLength <= 0) {
    return { ok: false, kind: "unknown", reason: "пустой файл" };
  }
  if (entry.id === "rtl-sdr") {
    return { ok: false, kind: "unknown", reason: "RTL-SDR не прошивается FPGA/FX3" };
  }
  const kind = classifyFirmware(job.filename);
  const allowed = DEVICE_KINDS[entry.id];
  if (kind === "unknown") {
    return {
      ok: false,
      kind,
      reason: "не распознан официальный образ (нужен hostedxA4.rbf / bladeRF.img и т.п.)",
    };
  }
  if (allowed && !allowed.includes(kind)) {
    return {
      ok: false,
      kind,
      reason: `образ ${kind} несовместим с ${entry.name}`,
    };
  }
  if (job.action === "flash-fx3" && kind !== "fx3") {
    return { ok: false, kind, reason: "flash-fx3 ждёт FX3 .img, не FPGA .rbf" };
  }
  if ((job.action === "flash-fpga" || job.action === "load-fpga") && kind === "fx3") {
    return { ok: false, kind, reason: "FPGA-действие ждёт .rbf, не FX3 .img" };
  }
  return { ok: true, kind, reason: `принято: ${job.action} ${kind} → ${entry.name}` };
}
