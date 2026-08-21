// ============================================================================
// LEGION — прошивка ESP32 только своим PlatformIO env.
// Не принимаем произвольный .bin/.rbf. Неверная плата = кирпич.
// Envs = firmware/platformio.ini (без native / native_fuzz).
// ============================================================================
import { refuseCrossFlash } from "./guard";

export const ESP32_FLASH_ENVS = ["esp32dev", "esp32-s3", "esp32-s2", "esp32-c3", "esp32-c6", "esp32-h2"] as const;

export type Esp32FlashEnv = (typeof ESP32_FLASH_ENVS)[number];

export interface Esp32EnvInfo {
  env: Esp32FlashEnv;
  title: string;
  chip: string;
  warn: string;
}

export const ESP32_ENV_INFO: readonly Esp32EnvInfo[] = [
  { env: "esp32-s3", title: "ESP32-S3 (рекомендована)", chip: "ESP32-S3", warn: "не C3 и не classic" },
  { env: "esp32dev", title: "ESP32 classic (WROOM)", chip: "ESP32", warn: "не S2/S3/C3/C6/H2" },
  { env: "esp32-s2", title: "ESP32-S2", chip: "ESP32-S2", warn: "нет Bluetooth, не S3" },
  { env: "esp32-c3", title: "ESP32-C3", chip: "ESP32-C3", warn: "RISC-V, не S3" },
  { env: "esp32-c6", title: "ESP32-C6", chip: "ESP32-C6", warn: "не C3" },
  { env: "esp32-h2", title: "ESP32-H2", chip: "ESP32-H2", warn: "без Wi-Fi" },
];

export function isEsp32FlashEnv(v: string): v is Esp32FlashEnv {
  return (ESP32_FLASH_ENVS as readonly string[]).includes(v);
}

/** Разбор вывода esptool chip_id / flash_id. */
export function parseEsp32Chip(text: string): string | null {
  const s = text.replace(/\s+/g, " ");
  const m =
    /Chip is (ESP32-S3|ESP32-S2|ESP32-C6|ESP32-C3|ESP32-H2|ESP32-P4|ESP32)\b/i.exec(s) ??
    /Detecting chip type\.\.\. (ESP32-S3|ESP32-S2|ESP32-C6|ESP32-C3|ESP32-H2|ESP32)\b/i.exec(s);
  return m ? m[1].toUpperCase().replace("ESP32S3", "ESP32-S3") : null;
}

export function envMatchesChip(env: Esp32FlashEnv, chip: string): boolean {
  const c = chip.toUpperCase();
  switch (env) {
    case "esp32-s3":
      return c === "ESP32-S3";
    case "esp32-s2":
      return c === "ESP32-S2";
    case "esp32-c3":
      return c === "ESP32-C3";
    case "esp32-c6":
      return c === "ESP32-C6";
    case "esp32-h2":
      return c === "ESP32-H2";
    case "esp32dev":
      return c === "ESP32";
  }
}

export function usableSerialPort(port: string): boolean {
  const p = port.trim();
  if (!p || p.includes("..") || /\s/.test(p)) return false;
  if (/^COM\d{1,3}$/i.test(p)) return true;
  if (/^\/dev\/ttyUSB\d+$/.test(p)) return true;
  if (/^\/dev\/ttyACM\d+$/.test(p)) return true;
  if (/^\/dev\/(cu|tty)\.usb(serial|modem)[\w.-]*$/i.test(p)) return true;
  if (/^\/dev\/serial\/by-id\/[A-Za-z0-9._:-]+$/.test(p)) return true;
  return false;
}

export interface Esp32FlashPlan {
  ok: boolean;
  reason: string;
  env?: Esp32FlashEnv;
  port?: string;
  argv?: string[];
}

export interface Esp32FlashResult {
  ok: boolean;
  reason: string;
  written: boolean;
}

/**
 * Только pio run -e <allowlist> --target upload.
 * Произвольный файл / SDR-образ / native env — отказ.
 */
export function planEsp32Flash(opts: {
  env: string;
  port: string;
  confirmed: boolean;
  chip: string | null;
  /** Порт, с которого сняли chip_id. Смена порта сбрасывает пробу. */
  chipPort?: string | null;
  filename?: string;
}): Esp32FlashPlan {
  if (opts.filename) {
    const cross = refuseCrossFlash("esp32", opts.filename);
    if (cross) return { ok: false, reason: cross };
    return { ok: false, reason: "ESP32 шьём только LEGION через PlatformIO env, не чужим файлом" };
  }
  if (!opts.confirmed) {
    return { ok: false, reason: "подтвердите: выбранная плата = env. Неверная прошивка кирпичит ESP32." };
  }
  if (opts.env === "native" || opts.env === "native_fuzz") {
    return { ok: false, reason: "env native на железо не шьём" };
  }
  if (!isEsp32FlashEnv(opts.env)) {
    return { ok: false, reason: `env «${opts.env}» не из firmware/platformio.ini — не шьём` };
  }
  if (!usableSerialPort(opts.port)) {
    return { ok: false, reason: "нужен реальный USB-UART порт (/dev/ttyUSB* / ttyACM* / COM*)" };
  }
  if (!opts.chip) {
    return { ok: false, reason: "сначала ПРОБЕ ЧИПА (esptool chip_id). Без совпадения не шьём." };
  }
  if (!opts.chipPort || opts.chipPort.trim() !== opts.port.trim()) {
    return { ok: false, reason: "порт сменился после пробы чипа — ПРОБЕ снова" };
  }
  if (!envMatchesChip(opts.env, opts.chip)) {
    return {
      ok: false,
      reason: `чип ${opts.chip} ≠ env ${opts.env} — отказ, иначе кирпич`,
    };
  }
  const port = opts.port.trim();
  return {
    ok: true,
    env: opts.env,
    port,
    argv: ["pio", "run", "-e", opts.env, "--target", "upload", "--upload-port", port],
    reason: `pio run -e ${opts.env} --target upload --upload-port ${port}`,
  };
}
