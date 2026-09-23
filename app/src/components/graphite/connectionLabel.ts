import type { SdrIface } from "../../sdr/types";

/** Подпись физического подключения для главного экрана. */
export function connectionLabel(iface: SdrIface | undefined): { value: string; note: string } {
  if (iface === "usb2") return { value: "USB 2.0", note: "подключение USB" };
  if (iface === "ethernet") return { value: "Ethernet", note: "подключение RJ45" };
  if (iface === "usb3") return { value: "USB 3.0", note: "подключение USB" };
  return { value: "USB", note: "подключение USB" };
}
