// ============================================================================
// LEGION — план записи официального образа. Сам не врёт, что записал.
// Команды сверены с манифестом official.ts (Nuand bladeRF-cli, UHD, GSG, ADI).
// ============================================================================
import type { FlashJob } from "./types";

export interface FlashCliPlan {
  argv: string[];
  reason: string;
}

/** Что должен запустить оператор/CLI. Путь к файлу не режем — иначе CLI ищет в cwd. */
export function planFlashCli(job: FlashJob, addr?: string): FlashCliPlan {
  const file = job.filename;
  switch (job.deviceId) {
    case "bladerf-x40":
    case "bladerf-micro-xa4":
    case "bladerf-micro-xa9":
      if (job.action === "flash-fx3") {
        return { argv: ["bladeRF-cli", "-f", file], reason: "Nuand: FX3 -f" };
      }
      if (job.action === "load-fpga") {
        return { argv: ["bladeRF-cli", "-l", file], reason: "Nuand: FPGA в RAM -l" };
      }
      return { argv: ["bladeRF-cli", "-L", file], reason: "Nuand: FPGA autoload -L" };
    case "usrp-n210": {
      const ip = (addr || "192.168.10.2").trim() || "192.168.10.2";
      // MCU-firmware (uhd-n210-fw) идёт через --fw-path, FPGA — через
      // --fpga-path (Ettus KB / official.ts). Было: всегда --fpga-path —
      // MCU-образ писался в FPGA-слот.
      const pathArg = job.action === "flash-fx3" ? `--fw-path=${file}` : `--fpga-path=${file}`;
      return {
        argv: ["uhd_image_loader", `--args=type=usrp2,addr=${ip}`, pathArg],
        reason: "Ettus: uhd_image_loader",
      };
    }
    case "hackrf-one":
      return { argv: ["hackrf_spiflash", "-w", file], reason: "GSG: hackrf_spiflash -w" };
    case "plutosdr":
      return { argv: [], reason: "ADI: скопировать pluto.frm на mass-storage и извлечь том — не CLI из LEGION" };
    default:
      return { argv: [], reason: "для этого устройства автозапись из LEGION не задана" };
  }
}
