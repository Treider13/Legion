// ============================================================================
// LEGION — типы SDR-слоя (хост). ESP32/ADF4351 сюда не входят.
// Факты интерфейса: Nuand bladeRF 2.0 micro = USB 3.0, не Ethernet;
// USRP N210 = нативный Gigabit Ethernet (Ettus KB).
// ============================================================================

export type SdrIface = "usb2" | "usb3" | "ethernet";

export type SdrRole = "rx" | "tx" | "trx";

export interface SdrCatalogEntry {
  id: string;
  vendor: string;
  name: string;
  iface: SdrIface;
  nativeEthernet: boolean;
  role: SdrRole;
  rxMhz: [number, number] | null;
  txMhz: [number, number] | null;
  /** Аналоговая RF BW, МГц (офиц. спецификация, не hop UI). */
  analogBwMhz: number;
  /** Полный дуплекс: RX может продолжаться при TX на том же устройстве. */
  fullDuplex: boolean;
  fpga: string;
  /** Как официально прошивается (не ESP32 OTA). */
  flash: {
    fx3: boolean;
    fpgaAutoload: boolean;
    notes: string;
  };
  /** Как устройство говорит с PA. */
  paHint: string;
  /** Как появляется в LAN. */
  lanHint: string;
}

export interface SdrDeviceInfo extends SdrCatalogEntry {
  serial: string;
  present: boolean;
}

export type FirmwareKind =
  | "fx3"
  | "fpga-a4"
  | "fpga-a5"
  | "fpga-a9"
  | "fpga-x40"
  | "fpga-x115"
  | "pluto-frm"
  | "uhd-n210-fpga"
  | "uhd-n210-fw"
  | "hackrf-fw"
  | "lime-img"
  | "unknown";

/** Куда втыкается Ethernet-кабель (не путать с USB3 у xA4). */
export type EthCable = "sdr-rj45" | "gateway-rj45" | "usb-gadget";

export interface FlashJob {
  deviceId: string;
  filename: string;
  byteLength: number;
  action: "flash-fx3" | "flash-fpga" | "load-fpga";
}

export interface FlashResult {
  ok: boolean;
  kind: FirmwareKind;
  reason: string;
}

export interface ScanBin {
  freqMhz: number;
  powerDbm: number;
}

export interface Detection {
  freqMhz: number;
  powerDbm: number;
  noiseDbm: number;
  snrDb: number;
  ts: number;
  /** Уже ушло на синтезатор+PA (в нагрузку). UI красит красным. */
  forwarded: boolean;
}

/** Результат перестройки TX LO внутри SDR (тот же процесс, не React). */
export interface TxCueResult {
  ok: boolean;
  reason: string;
  freqMhz: number;
  /** Модель host-retune, не FPGA HDL. Не выдаём за микросекунды FPGA. */
  latencyUs: number;
  path: "sdr-tx" | "none";
}
