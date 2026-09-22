// Диаграмма SPLAT: файлы .az и .el, поле 0…1 от оси.
// Усиление = паспортные дБи + 20·lg(поле). Нет файла — остаётся оценка по дБи.

export interface PatternCut {
  deg: number;
  field: number;
}

export interface AntennaPattern {
  az: PatternCut[];
  el: PatternCut[];
}

function cuts(text: string, skip: number): PatternCut[] {
  const rows: PatternCut[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = skip; i < lines.length; i++) {
    const parts = lines[i].trim().split(/[\s,;]+/).filter(Boolean);
    if (parts.length < 2) continue;
    const deg = Number(parts[0]);
    const field = Number(parts[1]);
    if (Number.isFinite(deg) && Number.isFinite(field)) rows.push({ deg, field: Math.max(0, field) });
  }
  rows.sort((a, b) => a.deg - b.deg);
  return rows;
}

/** Первая строка .az — поворот паспорта. В луч берём азимут из поля формы. */
export function parseSplatAz(text: string): PatternCut[] {
  return cuts(text, 1);
}

/** Первая строка .el — наклон и его азимут. */
export function parseSplatEl(text: string): PatternCut[] {
  return cuts(text, 1);
}

export function patternFromFiles(azText: string | null, elText: string | null): AntennaPattern | null {
  const az = azText ? parseSplatAz(azText) : [];
  const el = elText ? parseSplatEl(elText) : [];
  if (az.length === 0 && el.length === 0) return null;
  return { az, el };
}

function fieldAtCircle(cut: PatternCut[], deg: number): number {
  if (cut.length === 0) return 1;
  const rows = cut
    .map((row) => ({ deg: ((row.deg % 360) + 360) % 360, field: row.field }))
    .sort((a, b) => a.deg - b.deg);
  const target = ((deg % 360) + 360) % 360;
  const ring = rows.concat({ deg: rows[0].deg + 360, field: rows[0].field });
  let hi = 1;
  while (hi < ring.length && ring[hi].deg < target) hi += 1;
  const a = ring[hi - 1];
  const b = ring[Math.min(hi, ring.length - 1)];
  const span = b.deg - a.deg;
  const t = span === 0 ? 0 : (target - a.deg) / span;
  return a.field + (b.field - a.field) * t;
}

function fieldAt(cut: PatternCut[], deg: number): number {
  if (cut.length === 0) return 1;
  if (deg <= cut[0].deg) return cut[0].field;
  const last = cut[cut.length - 1];
  if (deg >= last.deg) return last.field;
  let hi = 1;
  while (cut[hi].deg < deg) hi += 1;
  const a = cut[hi - 1];
  const b = cut[hi];
  const span = b.deg - a.deg;
  const t = span === 0 ? 0 : (deg - a.deg) / span;
  return a.field + (b.field - a.field) * t;
}

/** дБи в сторону смещения по азимуту и наклону от оси. */
export function patternGainDb(pattern: AntennaPattern, peakDbi: number, dazDeg: number, delDeg: number): number {
  const field = fieldAtCircle(pattern.az, dazDeg) * fieldAt(pattern.el, delDeg);
  return peakDbi + 20 * Math.log10(Math.max(field, 1e-3));
}
