// ============================================================================
// LEGION — план записи SDR. validate + путь + подтверждение ДО CLI.
// Без этого live-путь мог вызвать bladeRF-cli на несовместимом файле.
// ============================================================================
import { validateFlashJob } from "../sdr/firmware";
import { planFlashCli } from "../sdr/flashcli";
import { flashFileRequired, usableImagePath } from "../sdr/host";
import type { FlashJob } from "../sdr/types";
import { refuseCrossFlash } from "./guard";

export function planSdrWrite(opts: {
  job: FlashJob;
  imagePath: string;
  confirmed: boolean;
  gateway?: string;
}): { ok: boolean; reason: string; argv: string[]; file?: string } {
  if (!opts.confirmed) {
    return { ok: false, reason: "подтвердите: официальный образ вендора для ЭТОГО SDR", argv: [] };
  }
  const cross = refuseCrossFlash("sdr", opts.job.filename);
  if (cross) return { ok: false, reason: cross, argv: [] };
  const v = validateFlashJob(opts.job);
  if (!v.ok) return { ok: false, reason: v.reason, argv: [] };
  const fileOk = flashFileRequired(opts.job.byteLength, opts.imagePath);
  if (!fileOk.ok) return { ok: false, reason: fileOk.reason, argv: [] };
  const cli = planFlashCli(opts.job, opts.gateway);
  if (cli.argv.length === 0) {
    return { ok: false, reason: `${cli.reason} — автозапись не запустим`, argv: [] };
  }
  const file = usableImagePath(opts.imagePath) ? opts.imagePath.trim() : undefined;
  return { ok: true, reason: `${v.reason} · ${cli.reason}`, argv: cli.argv, file };
}

/** Превью CLI без галочки. Запись всё равно требует confirmed. */
export function inspectSdrWrite(opts: {
  job: FlashJob;
  imagePath: string;
  gateway?: string;
}): { ok: boolean; reason: string; argv: string[]; file?: string } {
  return planSdrWrite({ ...opts, confirmed: true });
}
