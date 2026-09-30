import { useMemo, useState } from "react";
import { buildAttackCallout, settleCallout, type AttackCallout, type CalloutRow } from "../../sense/attackCallout";
import type { AttackRow } from "../../sense/attackScene";
import { useLegion } from "../../state/store";

function typeOf(row: AttackRow): string {
  return row.look?.label ?? row.atlas.label;
}

function calloutRows(rows: readonly AttackRow[]): CalloutRow[] {
  return rows.map((row) => ({
    freqMhz: row.freqMhz,
    powerDbm: row.powerDbm,
    state: row.state,
    atlasId: row.atlas.id,
    typeLabel: typeOf(row),
  }));
}

function useSettledCallout(next: AttackCallout): AttackCallout {
  const [shown, setShown] = useState(next);
  const settled = settleCallout(shown, next);
  if (settled !== shown) setShown(settled);
  return settled;
}

function SignalStat({ typeLabel, freqMhz }: { typeLabel: string | null; freqMhz: number | null }) {
  return (
    <div className="graphite-stat">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" aria-hidden="true">
        <path d="M5 18V7m7 11V4m7 14v-8" />
      </svg>
      <div>
        <span className="graphite-stat-label">Сигнал</span>
        <span className="graphite-stat-value">{typeLabel ?? "нет сигнала"}</span>
      </div>
      <small>{freqMhz != null ? `${freqMhz.toFixed(3)} МГц` : "ожидание"}</small>
    </div>
  );
}

export function GraphiteFacts({
  source,
  sourceNote,
  range,
  rangeNote,
}: {
  source: string;
  sourceNote: string;
  range: string;
  rangeNote: string;
}) {
  const rows = useLegion((s) => s.attackRows);
  const advice = useLegion((s) => s.attackAdvice);
  const transmitArmed = useLegion((s) => s.transmitArmed);
  const applyAttackHint = useLegion((s) => s.applyAttackHint);
  const live = useMemo(() => buildAttackCallout(calloutRows(rows), advice), [rows, advice]);
  const shown = useSettledCallout(live);

  return (
    <>
      <div className="graphite-stats">
        <div className="graphite-stat">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" aria-hidden="true">
            <path d="M12 13v7m-3 0h6M8.5 15a5 5 0 0 1 0-7M15.5 8a5 5 0 0 1 0 7M5.5 18a9 9 0 0 1 0-13M18.5 5a9 9 0 0 1 0 13" />
            <circle cx="12" cy="11.5" r="1.5" />
          </svg>
          <div>
            <span className="graphite-stat-label">Подключение</span>
            <span className="graphite-stat-value">{source}</span>
          </div>
          <small>{sourceNote}</small>
        </div>
        <div className="graphite-stat">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" aria-hidden="true">
            <path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M9 9h6v6H9z" />
          </svg>
          <div>
            <span className="graphite-stat-label">Диапазон</span>
            <span className="graphite-stat-value">{range}</span>
          </div>
          <small>{rangeNote}</small>
        </div>
        <SignalStat typeLabel={live.typeLabel} freqMhz={live.freqMhz} />
      </div>
      <section className="graphite-assist" aria-label="Совет помощника">
        <div className="graphite-assist-kicker">
          <span>Помощник</span>
          <span>{shown.freqMhz != null ? `${shown.freqMhz.toFixed(3)} МГц` : shown.kicker}</span>
        </div>
        <div className="graphite-assist-body" aria-live="polite" aria-atomic="true">
          <h2>{shown.title}</h2>
          <p>{shown.text}</p>
          {shown.why && <small>{shown.why}</small>}
        </div>
        {shown.applyLabel && shown.applyKind && shown.hint && (
          <div className="graphite-assist-side">
            <button
              type="button"
              className="graphite-assist-apply"
              disabled={transmitArmed}
              onClick={() => {
                if (shown.hint && shown.applyKind) applyAttackHint(shown.applyKind, shown.hint);
              }}
            >
              {shown.applyLabel}
            </button>
          </div>
        )}
      </section>
    </>
  );
}
