// ============================================================================
// LEGION — абстракция транспорта ПК ↔ ESP32 (фаза 2)
// Один интерфейс — три реализации + mock:
//   TauriSerialTransport  — USB-UART через Rust serialport (desktop, основной)
//   WebSerialTransport    — USB из браузера (Chrome/Edge/Firefox 151+, бонус)
//   WebSocketTransport    — WiFi (ESP32 AP/STA; серверная сторона — фаза 4)
//   MockTransport         — эмулятор ESP32+ADF4351 для разработки без железа
// ============================================================================

export type TransportKind = "tauri-serial" | "web-serial" | "websocket" | "mock";

export type TransportState = "disconnected" | "connecting" | "connected" | "error";

export interface TransportEvents {
  /** Построчный приём (строки без \n) */
  onLine(line: string): void;
  onState(state: TransportState, detail?: string): void;
}

export interface Transport {
  readonly kind: TransportKind;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  writeLine(line: string): Promise<void>;
  setEvents(ev: TransportEvents): void;
}

/** Описание доступного serial-порта для UI */
export interface SerialPortDescriptor {
  path: string;
  label: string;
}

/** Детект Tauri-окружения (WebView): без импорта @tauri-apps/api на уровне типов */
export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Поддержка Web Serial API в текущем браузере (факт T1: Chrome/Edge 89+, FF 151+) */
export function isWebSerialSupported(): boolean {
  return typeof navigator !== "undefined" && "serial" in navigator;
}
