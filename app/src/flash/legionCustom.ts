// ============================================================================
// LEGION — кастомная ревизия legion: сборка из fpga/ (Quartus на стенде)
// и запись bladeRF-cli -l/-L. Это НЕ вкладка hosted: classifyFirmware /
// validateFlashJob сюда не ходят, hosted-фильтр не ослабляется.
// Имена артефактов — факт build_bladerf.sh: BUILD_NAME="$rev"x"$size" →
// legionx40.rbf / legionxA4.rbf / legionxA9.rbf (каталог legionx<size>-<дата>).
// ============================================================================
import { usableImagePath } from "../sdr/host";

export type LegionBoardKey = "x40" | "xa4" | "xa9";

export interface LegionBoard {
  sdrId: string;
  /** -b для build_bladerf.sh */
  board: "bladeRF" | "bladeRF-micro";
  /** -s для build_bladerf.sh */
  size: "40" | "A4" | "A9";
  /** Имя .rbf на выходе сборки. */
  rbf: string;
  /** Soapy hardwareKey семейства (requireHw). */
  hwKey: "bladerf1" | "bladerf2";
}

/** Только эти три: A2/A5 и x115 в каталоге LEGION нет, кастома для них нет. */
export const LEGION_BOARDS: readonly LegionBoard[] = [
  { sdrId: "bladerf-x40", board: "bladeRF", size: "40", rbf: "legionx40.rbf", hwKey: "bladerf1" },
  { sdrId: "bladerf-micro-xa4", board: "bladeRF-micro", size: "A4", rbf: "legionxA4.rbf", hwKey: "bladerf2" },
  { sdrId: "bladerf-micro-xa9", board: "bladeRF-micro", size: "A9", rbf: "legionxA9.rbf", hwKey: "bladerf2" },
];

export function legionBoardFor(sdrId: string): LegionBoard | null {
  return LEGION_BOARDS.find((b) => b.sdrId === sdrId) ?? null;
}

const RBF_RE = /^legion_?x(40|a4|a9)\.rbf$/i;

/** Класс платы по имени артефакта. hosted/FX3/ESP32 сюда не попадают. */
export function classifyLegionRbf(filename: string): LegionBoardKey | null {
  const base = filename.split(/[/\\]/).pop() ?? filename;
  const m = RBF_RE.exec(base);
  if (!m) return null;
  const sz = m[1].toLowerCase();
  return sz === "40" ? "x40" : sz === "a4" ? "xa4" : "xa9";
}

export interface LegionBuildPlan {
  ok: boolean;
  reason: string;
  board?: LegionBoard["board"];
  size?: LegionBoard["size"];
  rbf?: string;
}

/** Команда сборки под плату. Запуск — Rust (legion_build), здесь только план. */
export function planLegionBuild(sdrId: string): LegionBuildPlan {
  const b = legionBoardFor(sdrId);
  if (!b) {
    return {
      ok: false,
      reason: `ревизия legion собирается только под bladeRF 1 x40 и bladeRF 2.0 micro xA4/xA9 — ${sdrId} не поддержан`,
    };
  }
  return {
    ok: true,
    reason: `build_bladerf.sh -b ${b.board} -s ${b.size} -r legion → ${b.rbf}`,
    board: b.board,
    size: b.size,
    rbf: b.rbf,
  };
}

/** -l = FPGA в RAM (после питания спадёт), -L = autoload во flash. */
export type LegionFlashAction = "load" | "store";

export interface LegionFlashPlan {
  ok: boolean;
  reason: string;
  argv: string[];
  file?: string;
}

function boardMismatch(sdrId: string, path: string): string | null {
  const b = legionBoardFor(sdrId);
  if (!b) return `ревизии legion для ${sdrId} нет — только bladeRF x40 / micro xA4 / xA9`;
  const key = classifyLegionRbf(path);
  if (!key) {
    return `это не артефакт ревизии legion (${b.rbf}): hosted/FX3/ESP32 сюда не шьём`;
  }
  const want: LegionBoardKey = b.size === "40" ? "x40" : b.size === "A4" ? "xa4" : "xa9";
  if (key !== want) {
    return `образ ${key} несовместим с платой ${sdrId} (нужен ${want}) — неверный size кирпичит FPGA до отката`;
  }
  return null;
}

/** Локальная запись: bladeRF-cli крутится на этом ПК, USB к плате здесь. */
export function planLegionFlashLocal(opts: {
  sdrId: string;
  path: string;
  action: LegionFlashAction;
  confirmed: boolean;
}): LegionFlashPlan {
  if (!opts.confirmed) {
    return { ok: false, reason: "подтвердите: это ревизия legion для ЭТОЙ платы, не hosted и не ESP32", argv: [] };
  }
  const path = opts.path.trim();
  const mismatch = boardMismatch(opts.sdrId, path);
  if (mismatch) return { ok: false, reason: mismatch, argv: [] };
  if (!usableImagePath(path)) {
    return { ok: false, reason: "нужен абсолютный путь к .rbf — имя без каталога bladeRF-cli ищет в cwd", argv: [] };
  }
  const flag = opts.action === "load" ? "-l" : "-L";
  return {
    ok: true,
    reason: `bladeRF-cli ${flag} ${path}`,
    argv: ["bladeRF-cli", flag, path],
    file: path,
  };
}

/** Запись на шлюзе (Ethernet-стенд): файл уже лежит на машине шлюза. */
export function planLegionFlashGateway(opts: {
  sdrId: string;
  path: string;
  action: LegionFlashAction;
  confirmed: boolean;
}): LegionFlashPlan {
  if (!opts.confirmed) {
    return { ok: false, reason: "подтвердите: это ревизия legion для ЭТОЙ платы, не hosted и не ESP32", argv: [] };
  }
  const path = opts.path.trim();
  const mismatch = boardMismatch(opts.sdrId, path);
  if (mismatch) return { ok: false, reason: mismatch, argv: [] };
  if (!path.startsWith("/")) {
    return { ok: false, reason: "путь на шлюзе должен быть абсолютным (/…): bladeRF-cli там ищет от cwd", argv: [] };
  }
  return {
    ok: true,
    reason: `шлюз: bladeRF-cli ${opts.action === "load" ? "-l" : "-L"} ${path}`,
    argv: [],
    file: path,
  };
}
