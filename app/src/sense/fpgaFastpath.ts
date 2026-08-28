// ============================================================================
// LEGION — микросекундный detect→TX только внутри FPGA (lb_gated).
// Хост-скан / Soapy / React сюда не входят: USB retune = сотни µs…мс.
// Окно детектора: 2^shift сэмплов I²+Q². Ревизия legion: fs = 2 МГц.
// shift=4 → 16 сэмплов → 8 µs. shift=8 (дефолт шлюза) → 256 → 128 µs.
// Полоса должна влезть в analog BW (x40 = 28 МГц): hop ФАПЧ ≠ микросекунды.
// ============================================================================
import type { AllowBand } from "../policy/allowlist";

export const LEGION_FPGA_FS_HZ = 2_000_000;
/** Окно 16 сэмплов @ 2 МГц = 8 µs. Минимум HDL (win_shift 4..12). */
export const FPGA_US_DET_SHIFT = 4;
/** Стартовый порог средней энергии; 0 открывает гейт на шум (шлюз отказывает). */
export const FPGA_DEFAULT_DET_THR = 5000;
export const FPGA_AIR_SDR_ID = "bladerf-x40";

export function clampDetShift(shift: number): number {
  if (!Number.isFinite(shift)) return FPGA_US_DET_SHIFT;
  return Math.min(12, Math.max(4, Math.round(shift)));
}

/** Длительность окна детектора в микросекундах. */
export function detectorWindowUs(winShift: number, fsHz = LEGION_FPGA_FS_HZ): number {
  if (!(fsHz > 0)) return Number.POSITIVE_INFINITY;
  const n = 1 << clampDetShift(winShift);
  return (n / fsHz) * 1e6;
}

export function parkSpanMhz(bands: readonly AllowBand[]): number {
  if (bands.length === 0) return 0;
  const f1 = Math.min(...bands.map((b) => b.f1Mhz));
  const f2 = Math.max(...bands.map((b) => b.f2Mhz));
  return f2 - f1;
}

export interface FpgaAirInput {
  sdrId: string;
  analogBwMhz: number;
  bands: readonly AllowBand[];
  loadOk: boolean;
  detThr: number;
  detShift: number;
}

export interface FpgaAirPlan {
  ok: boolean;
  reason: string;
  windowUs: number;
  detThr: number;
  detShift: number;
  spanMhz: number;
}

export function planFpgaAir(i: FpgaAirInput): FpgaAirPlan {
  const detShift = clampDetShift(i.detShift);
  const windowUs = detectorWindowUs(detShift);
  const spanMhz = parkSpanMhz(i.bands);
  const fail = (reason: string): FpgaAirPlan => ({
    ok: false,
    reason,
    windowUs,
    detThr: i.detThr,
    detShift,
    spanMhz,
  });
  if (i.sdrId !== FPGA_AIR_SDR_ID) {
    return fail("FPGA эфир: ревизия legion только на bladeRF 1 x40");
  }
  if (!i.loadOk) {
    return fail("FPGA эфир: подтвердите нагрузку 50 Ом на выходе усилителя SDR");
  }
  if (!(i.detThr > 0) || !Number.isFinite(i.detThr)) {
    return fail("FPGA эфир: задайте det_thr > 0 (порог 0 = гейт на шум)");
  }
  if (spanMhz > i.analogBwMhz) {
    return {
      ok: true,
      reason: `FPGA I²+Q² окно ${windowUs.toFixed(1)} µs в текущем LO (≤${i.analogBwMhz} МГц). Полоса ${spanMhz.toFixed(1)} МГц не сканируется — hop ФАПЧ = мс`,
      windowUs,
      detThr: i.detThr,
      detShift,
      spanMhz,
    };
  }
  return {
    ok: true,
    reason: `FPGA I²+Q² окно ${windowUs.toFixed(1)} µs → RX→TX внутри чипа → усилитель`,
    windowUs,
    detThr: i.detThr,
    detShift,
    spanMhz,
  };
}

/** Команда ARM для шлюза. det_thr/shift — только lb_gated. */
export function fpgaArmCmd(
  mode: "player" | "nco" | "lb_gated" | "lb_always",
  opts: { detThr: number; detShift: number; token: string; wd?: boolean },
): Record<string, unknown> {
  const cmd: Record<string, unknown> = {
    op: "arm",
    mode,
    wd: opts.wd !== false,
    token: opts.token,
  };
  if (mode === "lb_gated") {
    cmd.det_thr = opts.detThr;
    cmd.det_shift = clampDetShift(opts.detShift);
  }
  return cmd;
}
