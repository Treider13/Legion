import { useLegion } from "../state/store";

function autoDb(min: number, max: number): number {
  return Math.round(min + 0.4 * (max - min));
}

/** libbladeRF: 60 дБ усиления TX ≈ 0 дБм. Оценка вендора, не измерение и не дБи. */
export function bladeTxDbm(gainDb: number, sdrId: string): number | null {
  if (!sdrId.startsWith("bladerf")) return null;
  return gainDb - 60;
}

export function TxGainControl({ tone = "lab" }: { tone?: "lab" | "cinema" }) {
  const txGainDb = useLegion((s) => s.txGainDb);
  const min = useLegion((s) => s.txGainMin);
  const max = useLegion((s) => s.txGainMax);
  const sdrId = useLegion((s) => s.sdrId);
  const setTxGain = useLegion((s) => s.setTxGain);
  /* Целые дБ внутри диапазона платы. У xA4 min = −23.75: Math.round даёт −24,
   * а это уже за пределом bladerf2_tx_gain_ranges. */
  const lo = Math.ceil(min);
  const hi = Math.max(lo, Math.floor(max));
  const shown = Math.min(hi, Math.max(lo, txGainDb ?? autoDb(min, max)));
  const dbm = bladeTxDbm(shown, sdrId);
  const value = `${shown} дБ${txGainDb == null ? " · авто" : ""}${
    dbm == null ? "" : ` · ≈ ${dbm > 0 ? "+" : ""}${dbm} дБм`
  }`;
  const title =
    "Усиление тракта TX в дБ. У bladeRF 60 дБ ≈ 0 дБм на SMA (Nuand, без калибровки). " +
    "Это не дБи антенны — дБи задаётся на вкладке Позиция. " +
    "Кастомный образ legion применит число на TX после пересборки и прошивки.";

  if (tone === "cinema") {
    return (
      <label className="cinema-tx-gain" title={title}>
        Мощность TX, дБ
        <input
          type="range"
          min={lo}
          max={hi}
          step={1}
          value={shown}
          aria-label="Мощность TX, дБ"
          onChange={(e) => void setTxGain(parseFloat(e.target.value))}
        />
        <span>{value}</span>
      </label>
    );
  }

  return (
    <div className="sens-row">
      <span className="att-label">МОЩНОСТЬ TX</span>
      <input
        className="att-slider"
        type="range"
        min={lo}
        max={hi}
        step={1}
        value={shown}
        aria-label="Мощность TX, дБ"
        title={title}
        onChange={(e) => void setTxGain(parseFloat(e.target.value))}
      />
      <span className="att-value">{value}</span>
    </div>
  );
}
