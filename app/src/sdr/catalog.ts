// ============================================================================
// LEGION — каталог SDR. Поля сверены с публичными спецификациями
// (Nuand bladeRF 2.0 micro, Ettus N200/N210 KB, ADALM-Pluto, Lime, osmocom).
// ============================================================================
import type { SdrCatalogEntry } from "./types";

export const SDR_CATALOG: readonly SdrCatalogEntry[] = [
  {
    id: "bladerf-micro-xa4",
    vendor: "Nuand",
    name: "bladeRF 2.0 micro xA4",
    iface: "usb3",
    nativeEthernet: false,
    role: "trx",
    rxMhz: [70, 6000],
    txMhz: [47, 6000],
    analogBwMhz: 56, // Nuand: analog RF BW ≤56 MHz
    fullDuplex: true, // 2×2 MIMO, RX+TX одновременно
    fpga: "Cyclone V 49 kLE",
    flash: {
      fx3: true,
      fpgaAutoload: true,
      notes: "bladeRF-cli -f (FX3), -L hostedxA4.rbf (autoload), -l (RAM). Образ A9 на A4 не ставить.",
    },
    paHint: "bias-tee TX on/off (BT-100). Произвольный ток — задатчик ESP32 (PA SET I).",
    lanHint: "Нативного Ethernet нет. LAN = хост-шлюз USB3 + SoapyRemote.",
  },
  {
    id: "bladerf-micro-xa9",
    vendor: "Nuand",
    name: "bladeRF 2.0 micro xA9",
    iface: "usb3",
    nativeEthernet: false,
    role: "trx",
    rxMhz: [70, 6000],
    txMhz: [47, 6000],
    analogBwMhz: 56,
    fullDuplex: true,
    fpga: "Cyclone V 301 kLE",
    flash: {
      fx3: true,
      fpgaAutoload: true,
      notes: "Тот же libbladeRF; bitstream hostedxA9.rbf. Больше места под FFT на FPGA.",
    },
    paHint: "Как xA4: bias-tee on/off, не ток.",
    lanHint: "Как xA4: только USB 3.0 + шлюз.",
  },
  {
    id: "hackrf-one",
    vendor: "Great Scott Gadgets",
    name: "HackRF One",
    iface: "usb2",
    nativeEthernet: false,
    role: "trx",
    rxMhz: [1, 6000],
    txMhz: [1, 6000],
    analogBwMhz: 20, // GSG: max sample rate 20 Msps
    fullDuplex: false, // half-duplex: TX останавливает RX
    fpga: "CPLD + LPC43xx",
    flash: {
      fx3: false,
      fpgaAutoload: false,
      notes: "hackrf_spiflash — свой путь, не Nuand и не ESP32 OTA.",
    },
    paHint: "Нет штатного тока PA. Актуатор — ESP32+ADF4351.",
    lanHint: "USB 2.0 + SoapyRemote на хосте.",
  },
  {
    id: "limesdr-usb",
    vendor: "Lime Microsystems",
    name: "LimeSDR USB",
    iface: "usb3",
    nativeEthernet: false,
    role: "trx",
    rxMhz: [0.1, 3800],
    txMhz: [0.1, 3800],
    analogBwMhz: 61, // Lime: 61.44 Msps
    fullDuplex: true,
    fpga: "Altera Cyclone IV",
    flash: {
      fx3: false,
      fpgaAutoload: true,
      notes: "LimeSuite / SoapyLMS7. Не путать с LimeNET (там есть Ethernet).",
    },
    paHint: "Внешний PA отдельно.",
    lanHint: "USB. Для RJ45 в плату — LimeNET Micro, не эта модель.",
  },
  {
    id: "limenet-micro",
    vendor: "Lime Microsystems",
    name: "LimeNET Micro",
    iface: "ethernet",
    nativeEthernet: true,
    role: "trx",
    rxMhz: [0.1, 3800],
    txMhz: [0.1, 3800],
    analogBwMhz: 61,
    fullDuplex: true,
    fpga: "Cyclone IV + SoC",
    flash: {
      fx3: false,
      fpgaAutoload: true,
      notes: "Ethernet на плате. Не путать с LimeSDR USB. Прошивка — LimeSuite, не ESP32 OTA.",
    },
    paHint: "Внешний PA отдельно.",
    lanHint: "RJ45 в сам LimeNET. Типично SoapySDRServer на устройстве.",
  },
  {
    id: "plutosdr",
    vendor: "Analog Devices",
    name: "ADALM-Pluto",
    iface: "usb2",
    nativeEthernet: true,
    role: "trx",
    rxMhz: [70, 6000],
    txMhz: [47, 6000],
    analogBwMhz: 20, // ADI default USB bandwidth
    fullDuplex: true,
    fpga: "Zynq-7010",
    flash: {
      fx3: false,
      fpgaAutoload: true,
      notes: "Официальный firmware ADI; Ethernet включается прошивкой, не кабель в USB-SDR.",
    },
    paHint: "Нет произвольного тока PA.",
    lanHint: "Официальный pluto.frm: Ethernet-over-USB 192.168.2.1 или USB-ETH адаптер. RJ45 в stock Pluto нет.",
  },
  {
    id: "usrp-b210",
    vendor: "Ettus / NI",
    name: "USRP B210",
    iface: "usb3",
    nativeEthernet: false,
    role: "trx",
    rxMhz: [70, 6000],
    txMhz: [70, 6000],
    analogBwMhz: 56, // Ettus B210 analog BW
    fullDuplex: true,
    fpga: "Spartan-6",
    flash: {
      fx3: false,
      fpgaAutoload: true,
      notes: "UHD images. Академический стандарт GNU Radio.",
    },
    paHint: "Внешний PA. UHD не задаёт ток стороннего усилителя.",
    lanHint: "USB 3.0. Для Ethernet — серия N/X, не B210.",
  },
  {
    id: "usrp-n210",
    vendor: "Ettus / NI",
    name: "USRP N210",
    iface: "ethernet",
    nativeEthernet: true,
    role: "trx",
    rxMhz: [0, 6000],
    txMhz: [0, 6000],
    analogBwMhz: 20, // зависит от дочерней платы; консервативно
    fullDuplex: true,
    fpga: "Spartan-3A-DSP",
    flash: {
      fx3: false,
      fpgaAutoload: true,
      notes: "Нативный Gigabit Ethernet (Ettus KB). Дочерние платы задают полосу.",
    },
    paHint: "Внешний PA.",
    lanHint: "Прямой Ethernet. Это не bladeRF.",
  },
  {
    id: "rtl-sdr",
    vendor: "osmocom / RTL",
    name: "RTL-SDR",
    iface: "usb2",
    nativeEthernet: false,
    role: "rx",
    rxMhz: [24, 1766],
    txMhz: null,
    analogBwMhz: 2.4, // типичный rtl_sdr; 3.2 нестабилен
    fullDuplex: false,
    fpga: "нет (RTL2832U)",
    flash: {
      fx3: false,
      fpgaAutoload: false,
      notes: "Только приём. Прошивки FPGA нет.",
    },
    paHint: "Нет TX — наведение PA только через ADF4351.",
    lanHint: "USB + rtl_tcp / SoapyRemote.",
  },
];

export function catalogById(id: string): SdrCatalogEntry | undefined {
  return SDR_CATALOG.find((e) => e.id === id);
}

export function soapyRemoteArgs(host: string, port = 55132): string {
  const h = host.trim();
  if (!h) return "";
  return `driver=remote,remote=tcp://${h}:${port}`;
}
