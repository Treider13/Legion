// ============================================================================
// LEGION — проверка образа SDR до прошивки.
// Не пишет в железо: только имя/размер/совместимость с официальным манифестом.
// ESP32 OTA сюда не входит.
// ============================================================================
import { catalogById } from "./catalog";
import { rejectAlienFirmware } from "./task";
import type { FirmwareKind, FlashJob, FlashResult } from "./types";

function fail(kind: FirmwareKind, reason: string): FlashResult {
  return { ok: false, kind, reason, written: false };
}

const KINDS: Array<{ re: RegExp; kind: FirmwareKind }> = [
  { re: /hosted\s*x?a4|hostedxA4|\.xa4\./i, kind: "fpga-a4" },
  { re: /hosted\s*x?a5|hostedxA5/i, kind: "fpga-a5" },
  { re: /hosted\s*x?a9|hostedxA9/i, kind: "fpga-a9" },
  { re: /hostedx40|fpga40/i, kind: "fpga-x40" },
  { re: /hostedx115|fpga115/i, kind: "fpga-x115" },
  { re: /pluto\.(frm|dfu)|plutosdr-fw/i, kind: "pluto-frm" },
  { re: /usrp_n210.*fpga|n210_r4_fpga/i, kind: "uhd-n210-fpga" },
  { re: /usrp_n210_fw|n210_fw\.bin/i, kind: "uhd-n210-fw" },
  { re: /hackrf_one_usb|hackrf.*\.(bin|dfu)/i, kind: "hackrf-fw" },
  { re: /lime.*(rpd|rbf|img)/i, kind: "lime-img" },
  { re: /bladeRF_fw|bladerf.*\.img$|fx3/i, kind: "fx3" },
];

export function classifyFirmware(filename: string): FirmwareKind {
  const base = filename.split(/[/\\]/).pop() ?? filename;
  for (const row of KINDS) {
    if (row.re.test(base)) return row.kind;
  }
  return "unknown";
}

const DEVICE_KINDS: Record<string, FirmwareKind[]> = {
  "bladerf-x40": ["fx3", "fpga-x40"],
  "bladerf-micro-xa4": ["fx3", "fpga-a4"],
  "bladerf-micro-xa9": ["fx3", "fpga-a9"],
  "hackrf-one": ["hackrf-fw"],
  "limesdr-usb": ["lime-img"],
  "limenet-micro": ["lime-img"],
  plutosdr: ["pluto-frm"],
  "usrp-b210": [],
  "usrp-n210": ["uhd-n210-fpga", "uhd-n210-fw"],
  "rtl-sdr": [],
};

const FX3_ACTIONS: FirmwareKind[] = ["fx3", "uhd-n210-fw", "hackrf-fw"];
const FPGA_ACTIONS: FirmwareKind[] = [
  "fpga-a4",
  "fpga-a5",
  "fpga-a9",
  "fpga-x40",
  "fpga-x115",
  "pluto-frm",
  "uhd-n210-fpga",
  "lime-img",
];

export function validateFlashJob(job: FlashJob): FlashResult {
  const alien = rejectAlienFirmware(job.filename);
  if (alien) return fail("unknown", alien);
  const entry = catalogById(job.deviceId);
  if (!entry) {
    return fail("unknown", "неизвестный deviceId");
  }
  if (job.byteLength <= 0) {
    return fail("unknown", "пустой файл");
  }
  if (entry.id === "rtl-sdr") {
    return fail("unknown", "RTL-SDR не прошивается FPGA/FX3");
  }
  const kind = classifyFirmware(job.filename);
  const allowed = DEVICE_KINDS[entry.id];
  if (!allowed || allowed.length === 0) {
    return fail(
      kind,
      `${entry.name}: ручная прошивка из LEGION не нужна (autoload UHD / нет образа)`,
    );
  }
  if (kind === "unknown") {
    return fail(
      kind,
      "не распознан официальный образ (hostedxA4.rbf / bladeRF_fw_latest.img / pluto.frm / usrp_n210_r4_fpga.bin)",
    );
  }
  if (!allowed.includes(kind)) {
    return fail(kind, `образ ${kind} несовместим с ${entry.name}`);
  }
  if (job.action === "flash-fx3" && !FX3_ACTIONS.includes(kind)) {
    return fail(kind, "это действие ждёт FX3/MCU-образ, не FPGA");
  }
  if ((job.action === "flash-fpga" || job.action === "load-fpga") && !FPGA_ACTIONS.includes(kind)) {
    return fail(kind, "FPGA-действие ждёт bitstream/frm, не FX3 .img");
  }
  return {
    ok: true,
    kind,
    reason: `принято: ${job.action} ${kind} → ${entry.name}`,
    written: false,
  };
}
