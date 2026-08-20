// LEGION — SCAN RX: одна антенна, allowlist, ПЕРЕДАТЬ → авто в PA/заглушку.
import { useLegion } from "../state/store";

export function ScanPanel() {
  const s = useLegion();
  const f1 = s.allowBands.length ? Math.min(...s.allowBands.map((b) => b.f1Mhz)) : parseFloat(s.allowF1) || 2400;
  const f2 = s.allowBands.length ? Math.max(...s.allowBands.map((b) => b.f2Mhz)) : parseFloat(s.allowF2) || 2500;
  const span = Math.max(f2 - f1, 1e-6);

  return (
    <section className="panel">
      <span className="panel-title">СКАН RX // ОДНА АНТЕННА</span>
      <p className="panel-note">
        Одна антенна на SDR слушает только заданную полосу. СКАНИРОВАТЬ показывает
        улов. ПЕРЕДАТЬ взводит PA: дальше без участия — детект в том же процессе, что
        и SDR, сразу ставит TX LO (full-duplex не рвёт скан), затем CUE на ADF4351 и
        ток в нагрузку 50 Ом. Улов в нагрузке — красный. UART — миллисекунды; микросекунды
        на FPGA не обещаем (xA4 тесен, нужен свой HDL).
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
        <label>
          ТОК PA мА
          <input
            type="number"
            value={s.paMa}
            onChange={(e) => s.setPaMa(parseInt(e.target.value, 10) || 0)}
          />
        </label>
      </div>
      <label className="check-row">
        <input
          type="checkbox"
          checked={s.loadOk}
          onChange={(e) => void s.setLoad(e.target.checked)}
        />
        Нагрузка 50 Ом / экран на выходе усилителя
      </label>
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
        {s.transmitArmed ? (
          <button className="btn-danger" onClick={() => void s.stopTransmit()}>
            СТОП ПЕРЕДАЧУ
          </button>
        ) : (
          <button className="btn-primary" onClick={() => void s.startTransmit()}>
            ПЕРЕДАТЬ
          </button>
        )}
      </div>
      <ul className="allow-list">
        {s.allowBands.length === 0 && <li>полос нет — скан и передача запрещены</li>}
        {s.allowBands.map((b, i) => (
          <li key={`${b.f1Mhz}-${b.f2Mhz}-${i}`}>
            {b.f1Mhz} … {b.f2Mhz} МГц
          </li>
        ))}
      </ul>

      <div className="spectrum-strip" aria-label="Полоса скана">
        <div className="spectrum-fill" />
        {s.scanCenterMhz !== null && (
          <div
            className="spectrum-center"
            style={{ left: `${Math.min(100, Math.max(0, ((s.scanCenterMhz - f1) / span) * 100))}%` }}
          />
        )}
        {s.detections.map((d, i) => (
          <div
            key={`${d.freqMhz}-${i}`}
            className={d.forwarded ? "spectrum-hit forwarded" : "spectrum-hit"}
            style={{ left: `${Math.min(100, Math.max(0, ((d.freqMhz - f1) / span) * 100))}%` }}
            title={`${d.freqMhz.toFixed(3)} МГц`}
          />
        ))}
      </div>
      <div className="range-labels">
        <span>{f1}</span>
        <span className="range-cur">
          {s.scanCenterMhz !== null ? `${s.scanCenterMhz.toFixed(3)} МГц` : "—"}
          {s.transmitArmed
            ? ` · в нагрузку${s.lastSdrTxUs != null ? ` · SDR TX ${s.lastSdrTxUs} µs` : ""}`
            : s.scanRunning
              ? " · слушает"
              : ""}
        </span>
        <span>{f2}</span>
      </div>
      <p className="status-line">{s.lastCueReason || "ожидание улова в заданной полосе"}</p>
      <table className="det-table">
        <thead>
          <tr>
            <th>МГц</th>
            <th>дБм</th>
            <th>СНР</th>
            <th>СТАТУС</th>
          </tr>
        </thead>
        <tbody>
          {s.detections.length === 0 && (
            <tr>
              <td colSpan={4}>нет событий — задайте полосу и сканируйте</td>
            </tr>
          )}
          {s.detections
            .slice()
            .sort((a, b) => b.ts - a.ts)
            .slice(0, 10)
            .map((d, i) => (
              <tr
                key={`${d.ts}-${d.freqMhz}-${i}`}
                className={d.forwarded ? "det-row-fwd" : "det-row-hit"}
              >
                <td>{d.freqMhz.toFixed(3)}</td>
                <td>{d.powerDbm.toFixed(1)}</td>
                <td>{d.snrDb.toFixed(1)}</td>
                <td>{d.forwarded ? "В НАГРУЗКУ" : "УЛОВЛЕН"}</td>
              </tr>
            ))}
        </tbody>
      </table>
    </section>
  );
}
