// ============================================================================
// LEGION — план записи официального образа. Сам не врёт, что записал.
// Команды сверены с манифестом official.ts (Nuand bladeRF-cli, UHD, GSG, ADI).
// ============================================================================
import type { FlashJob } from "./types";

export interface FlashCliPlan {
  argv: string[];
  reason: string;
}

/** Что должен запустить оператор/CLI. Пустой argv = нет автозаписи из LEGION. */
export function planFlashCli(job: FlashJob): FlashCliPlan {
  const file = job.filename.split(/[/\\]/).pop() ?? job.filename;
  switch (job.deviceId) {
    case "bladerf-micro-xa4":
    case "bladerf-micro-xa9":
      if (job.action === "flash-fx3") {
        return { argv: ["bladeRF-cli", "-f", file], reason: "Nuand: FX3 -f" };
      }
      if (job.action === "load-fpga") {
        return { argv: ["bladeRF-cli", "-l", file], reason: "Nuand: FPGA в RAM -l" };
      }
      return { argv: ["bladeRF-cli", "-L", file], reason: "Nuand: FPGA autoload -L" };
    case "usrp-n210":
      return {
        argv: ["uhd_image_loader", `--args=type=usrp2,addr=192.168.10.2`, `--fpga-path=${file}`],
        reason: "Ettus: uhd_image_loader",
      };
    case "hackrf-one":
      return { argv: ["hackrf_spiflash", "-w", file], reason: "GSG: hackrf_spiflash -w" };
    case "plutosdr":
      return { argv: [], reason: "ADI: скопировать pluto.frm на mass-storage и извлечь том — не CLI из LEGION" };
    default:
      return { argv: [], reason: "для этого устройства автозапись из LEGION не задана" };
  }
}
