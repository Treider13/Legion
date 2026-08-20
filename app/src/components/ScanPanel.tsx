// LEGION — SCAN RX: только allowlist, energy detection, без излучения.
import { useLegion } from "../state/store";

export function ScanPanel() {
  const s = useLegion();

  return (
    <section className="panel">
      <span className="panel-title">СКАН RX // ALLOWLIST</span>
      <p className="panel-note">
        Это приём. Не путать с КОРИДОР TX (свип синтезатора). Сканер ходит только по заданным полосам.
      </p>
      <div className="corr-grid">
        <label>
          F1 МГц
          <input value={s.allowF1} onChange={(e) => s.setAllowField("allowF1", e.target.value)} />
        </label>
        <label>
          F2 МГц
          <input value={s.allowF2} onChange={(e) => s.setAllowField("allowF2", e.target.value)} />
        </label>
        <label>
          ПОРОГ СНР дБ
          <input
            type="number"
            value={s.scanThresholdDb}
            onChange={(e) => s.setScanThreshold(parseFloat(e.target.value) || 0)}
          />
        </label>
      </div>
      <div className="power-row">
        <button className="btn-primary" onClick={() => void s.addAllowBand()}>
          ДОБАВИТЬ ПОЛОСУ
        </button>
        <button className="btn-ghost" onClick={() => void s.clearAllowBands()}>
          ОЧИСТИТЬ
        </button>
        <button className="btn-ghost" onClick={() => s.injectDemoTone()}>
          ДЕМО-НЕСУЩАЯ
        </button>
        {s.scanRunning ? (
          <button className="btn-danger" onClick={() => s.stopScan()}>
            СТОП СКАН
          </button>
        ) : (
          <button className="btn-primary" onClick={() => s.startScan()}>
            СКАНИРОВАТЬ
          </button>
        )}
      </div>
      <ul className="allow-list">
        {s.allowBands.length === 0 && <li>полос нет — скан и CUE запрещены</li>}
        {s.allowBands.map((b, i) => (
          <li key={`${b.f1Mhz}-${b.f2Mhz}-${i}`}>
            {b.f1Mhz} … {b.f2Mhz} МГц
          </li>
        ))}
      </ul>
      <p className="status-line">
        центр: {s.scanCenterMhz !== null ? `${s.scanCenterMhz.toFixed(3)} МГц` : "—"}
        {s.scanRunning ? " · идёт проход" : ""}
      </p>
      <table className="det-table">
        <thead>
          <tr>
            <th>МГц</th>
            <th>дБм</th>
            <th>СНР</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {s.detections.length === 0 && (
            <tr>
              <td colSpan={4}>нет событий</td>
            </tr>
          )}
          {s.detections.slice(-8).reverse().map((d, i) => (
            <tr key={`${d.ts}-${d.freqMhz}-${i}`}>
              <td>{d.freqMhz.toFixed(3)}</td>
              <td>{d.powerDbm.toFixed(1)}</td>
              <td>{d.snrDb.toFixed(1)}</td>
              <td>
                <button className="btn-ghost btn-mini" onClick={() => void s.cueTo(d.freqMhz)}>
                  НАВЕСТИ
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
