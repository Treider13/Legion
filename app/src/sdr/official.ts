// ============================================================================
// LEGION — официальные прошивки SDR и Ethernet-план.
// Бинарники в git не кладём: только имена, URL вендора и команда прошивки.
// ESP32 OTA сюда не входит. Не собираем свой «jam» FPGA.
// ============================================================================
import { catalogById, soapyRemoteArgs } from "./catalog";
import type { EthCable, FirmwareKind } from "./types";

export interface OfficialImage {
  deviceIds: readonly string[];
  kind: FirmwareKind;
  /** Имена, которые принимает классификатор (официальные). */
  names: readonly string[];
  url: string;
  repo: string;
  tool: string;
}

export interface EthPlan {
  deviceId: string;
  cable: EthCable;
  /** Куда физически идёт RJ45. */
  cableText: string;
  defaultHost: string;
  /** Soapy/UHD args. Пустой host → локальный USB (только USB-SDR). */
  openArgs: string;
  /** Что должно крутиться на стороне Ethernet. */
  serverHint: string;
}

/**
 * Официальные образы под наш замысел: RX-скан + TX LO на SDR,
 * актуатор PA — ESP32+ADF4351. Источники: Nuand, ADI, Ettus, GSG, Lime.
 */
export const OFFICIAL_IMAGES: readonly OfficialImage[] = [
  {
    deviceIds: ["bladerf-micro-xa4"],
    kind: "fpga-a4",
    names: ["hostedxA4.rbf", "hostedxA4-latest.rbf"],
    url: "https://www.nuand.com/fpga/hostedxA4-latest.rbf",
    repo: "https://github.com/Nuand/bladeRF",
    tool: "bladeRF-cli -L hostedxA4.rbf  (autoload)  |  -l (RAM)",
  },
  {
    deviceIds: ["bladerf-micro-xa9"],
    kind: "fpga-a9",
    names: ["hostedxA9.rbf", "hostedxA9-latest.rbf"],
    url: "https://www.nuand.com/fpga/hostedxA9-latest.rbf",
    repo: "https://github.com/Nuand/bladeRF",
    tool: "bladeRF-cli -L hostedxA9.rbf  |  -l (RAM)",
  },
  {
    deviceIds: ["bladerf-micro-xa4", "bladerf-micro-xa9"],
    kind: "fx3",
    names: ["bladeRF_fw_latest.img", "bladeRF_fw_v2.6.0.img", "bladeRF.img"],
    url: "https://www.nuand.com/fx3/bladeRF_fw_latest.img",
    repo: "https://github.com/Nuand/bladeRF",
    tool: "bladeRF-cli -f bladeRF_fw_latest.img",
  },
  {
    deviceIds: ["plutosdr"],
    kind: "pluto-frm",
    names: ["pluto.frm", "pluto.dfu"],
    url: "https://github.com/analogdevicesinc/plutosdr-fw/releases/latest",
    repo: "https://github.com/analogdevicesinc/plutosdr-fw",
    tool: "скопировать pluto.frm на mass-storage Pluto и извлечь том (wiki ADI)",
  },
  {
    deviceIds: ["usrp-n210"],
    kind: "uhd-n210-fpga",
    names: ["usrp_n210_r4_fpga.bin", "usrp_n210_fpga.bin"],
    url: "https://kb.ettus.com/N200/N210",
    repo: "https://github.com/EttusResearch/uhd",
    tool: 'uhd_images_downloader && uhd_image_loader --args="type=usrp2,addr=<IP>"',
  },
  {
    deviceIds: ["usrp-n210"],
    kind: "uhd-n210-fw",
    names: ["usrp_n210_fw.bin"],
    url: "https://kb.ettus.com/N200/N210",
    repo: "https://github.com/EttusResearch/uhd",
    tool: "uhd_image_loader --fw-path usrp_n210_fw.bin",
  },
  {
    deviceIds: ["hackrf-one"],
    kind: "hackrf-fw",
    names: ["hackrf_one_usb.bin", "hackrf_one_usb.dfu"],
    url: "https://github.com/greatscottgadgets/hackrf/releases",
    repo: "https://github.com/greatscottgadgets/hackrf",
    tool: "hackrf_spiflash -w hackrf_one_usb.bin",
  },
];

export function imagesFor(deviceId: string): OfficialImage[] {
  return OFFICIAL_IMAGES.filter((r) => r.deviceIds.includes(deviceId));
}

export function defaultFlashName(deviceId: string): string {
  const fpga = imagesFor(deviceId).find((r) => r.kind.startsWith("fpga") || r.kind === "pluto-frm" || r.kind === "uhd-n210-fpga");
  if (fpga) return fpga.names[0];
  const any = imagesFor(deviceId)[0];
  return any?.names[0] ?? "";
}

export function defaultEthHost(deviceId: string): string {
  switch (deviceId) {
    case "usrp-n210":
      return "192.168.10.2"; // Ettus KB: заводской адрес N210
    case "plutosdr":
      return "192.168.2.1"; // wiki ADI [NETWORK] ipaddr
    case "limenet-micro":
      return "192.168.1.10";
    default:
      return "192.168.1.20"; // шлюз SoapyRemote, не сам USB-SDR
  }
}

export function ethCable(deviceId: string): EthCable {
  if (deviceId === "usrp-n210" || deviceId === "limenet-micro") return "sdr-rj45";
  if (deviceId === "plutosdr") return "usb-gadget";
  return "gateway-rj45";
}

export function sdrOpenArgs(deviceId: string, host: string): string {
  const h = host.trim();
  if (!h) return "";
  switch (deviceId) {
    case "usrp-n210":
      return `driver=uhd,type=usrp2,addr=${h}`;
    case "plutosdr":
      return `driver=plutosdr,hostname=${h}`;
    default:
      return soapyRemoteArgs(h);
  }
}

export function planEthernet(deviceId: string, host: string): EthPlan {
  const row = catalogById(deviceId);
  const cable = ethCable(deviceId);
  const h = host.trim() || defaultEthHost(deviceId);
  const name = row?.name ?? deviceId;
  let cableText: string;
  let serverHint: string;
  if (cable === "sdr-rj45") {
    cableText = `RJ45 в сам ${name}. Это не USB и не ESP32.`;
    serverHint =
      deviceId === "usrp-n210"
        ? "Нативный GbE (Ettus). Хост: 1 Гбит, адрес платы обычно 192.168.10.2."
        : "Ethernet на плате. SoapySDRServer — на самом устройстве, если нужен remote.";
  } else if (cable === "usb-gadget") {
    cableText =
      `${name}: Ethernet-over-USB (192.168.2.1) или USB-ETH адаптер после официального pluto.frm. RJ45 в корпус stock Pluto нет.`;
    serverHint = "Официальный ADI firmware (pluto.frm). config.txt [NETWORK] / [USB_ETHERNET].";
  } else {
    cableText = `${name} — USB 3.0/2.0, RJ45 в плате нет. Кабель Ethernet → мини-ПК-шлюз (USB3 к SDR).`;
    serverHint = "На шлюзе: SoapySDRServer --bind  (порт 55132, pothosware/SoapyRemote).";
  }
  return {
    deviceId,
    cable,
    cableText,
    defaultHost: defaultEthHost(deviceId),
    openArgs: sdrOpenArgs(deviceId, h),
    serverHint,
  };
}
