// LEGION — режим SDR: антенна RX, усилитель на RF out. ESP32 не вызывается.
import { useLegion } from "../state/store";

export function ScanPanel() {
  const s = useLegion();
  const f1 = s.sdrBands.length ? Math.min(...s.sdrBands.map((b) => b.f1Mhz)) : parseFloat(s.sdrF1) || 2400;
  const f2 = s.sdrBands.length ? Math.max(...s.sdrBands.map((b) => b.f2Mhz)) : parseFloat(s.sdrF2) || 2500;
  const span = Math.max(f2 - f1, 1e-6);

  return (
    <section className="panel">
      <span className="panel-title">РЕЖИМ SDR // АНТЕННА + УСИЛИТЕЛЬ НА SDR</span>
      <p className="panel-note">
        Ethernet к ноутбуку. Антенна на RX, усилитель на RF out SDR. Energy detect —
        не разбор пакетов и не RF-Clown/BlueJammer (те — nRF24 на ESP32). ПЕРЕДАТЬ:
        улов → TX LO на этом же SDR → усилитель и держим, пока засечка жива.
        Свой тон маскирует бин: раз в секунду TX гасится на проверку эфира.
        СБРОСИТЬ — если замок подозрительный, ищем другую. ESP32 сюда не входит.
      </p>
      <div className="freq-hud" aria-label="Перехваченная и TX частоты">
        <div className="freq-hud-card hit">
          <span className="freq-hud-k">ПЕРЕХВАЧЕНА</span>
          <span className="freq-hud-v">
            {s.lastInterceptMhz != null ? `${s.lastInterceptMhz.toFixed(3)}` : "—"}
          </span>
          <span className="freq-hud-u">МГц · energy</span>
        </div>
        <div className={`freq-hud-card tx ${s.lastForwardMhz != null ? "live" : ""}`}>
          <span className="freq-hud-k">НА TX SDR</span>
          <span className="freq-hud-v">
            {s.lastForwardMhz != null ? `${s.lastForwardMhz.toFixed(3)}` : "—"}
          </span>
          <span className="freq-hud-u">
            МГц · {s.lastForwardMhz != null ? "держим" : "усилитель"}
            {s.lastSdrTxUs != null ? ` · ${s.lastSdrTxUs} µs host` : ""}
          </span>
        </div>
      </div>
      <div className="corr-grid">
        <label>
          F1 МГц
          <input value={s.sdrF1} onChange={(e) => s.setSdrAllowField("sdrF1", e.target.value)} />
        </label>
        <label>
          F2 МГц
          <input value={s.sdrF2} onChange={(e) => s.setSdrAllowField("sdrF2", e.target.value)} />
        </label>
      </div>
      <div className="sens-row">
        <span className="att-label">ЧУВСТВИТЕЛЬНОСТЬ ЗАСЕЧКИ</span>
        <input
          className="att-slider"
          type="range"
          min={0}
          max={100}
          step={1}
          value={s.scanSensitivity}
          onChange={(e) => s.setScanSensitivity(parseFloat(e.target.value))}
          aria-label="Чувствительность засечки: низкая — все подряд, высокая — только сильные"
        />
        <span className="att-value">{Math.round(s.scanThresholdDb)} дБ СНР</span>
      </div>
      <p className="sens-hint">
        низкая = все подряд (слабые тоже) · высокая = только сильные
      </p>
      <label className="check-row">
        <input
          type="checkbox"
          checked={s.sdrLoadOk}
          onChange={(e) => s.setSdrLoad(e.target.checked)}
        />
        Нагрузка 50 Ом на выходе усилителя SDR
      </label>
      <div className="power-row">
        <button className="btn-primary" onClick={() => s.addSdrBand()}>
          ДОБАВИТЬ ПОЛОСУ
        </button>
        <button className="btn-ghost" onClick={() => s.clearSdrBands()}>
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
        <button
          className="btn-ghost"
          disabled={s.lastForwardMhz == null}
          onClick={() => void s.resetSdrLock()}
        >
          СБРОСИТЬ
        </button>
      </div>
      <ul className="allow-list">
        {s.sdrBands.length === 0 && <li>полос нет — скан и передача запрещены</li>}
        {s.sdrBands.map((b, i) => (
          <li key={`${b.f1Mhz}-${b.f2Mhz}-${i}`}>
            {b.f1Mhz} … {b.f2Mhz} МГц
          </li>
        ))}
      </ul>

      <div className="spectrum-wrap" aria-label="Спектр скана">
        {s.scanBins.length > 0 ? (
          <svg className="spectrum-svg" viewBox="0 0 640 88" preserveAspectRatio="none" role="img">
            {s.scanBins.map((b, i) => {
              const x = (i / Math.max(s.scanBins.length - 1, 1)) * 640;
              const n = 88;
              const h = Math.min(n, Math.max(2, ((b.powerDbm + 100) / 70) * n));
              const hit = s.detections.some((d) => Math.abs(d.freqMhz - b.freqMhz) < 0.3);
              const tx =
                s.lastForwardMhz != null && Math.abs(b.freqMhz - s.lastForwardMhz) < 0.3;
              return (
                <rect
                  key={`${b.freqMhz}-${i}`}
                  x={x}
                  y={88 - h}
                  width={Math.max(640 / s.scanBins.length - 0.4, 1)}
                  height={h}
                  fill={tx ? "#ff6b73" : hit ? "#5eead4" : "rgba(45,212,191,0.28)"}
                />
              );
            })}
          </svg>
        ) : (
          <div className="spectrum-strip">
            <div className="spectrum-fill" />
          </div>
        )}
        {s.scanCenterMhz !== null && (
          <div
            className="spectrum-center"
            style={{ left: `${Math.min(100, Math.max(0, ((s.scanCenterMhz - f1) / span) * 100))}%` }}
          />
        )}
      </div>
      <div className="range-labels">
        <span>{f1}</span>
        <span className="range-cur">
          {s.scanCenterMhz !== null ? `${s.scanCenterMhz.toFixed(3)} МГц` : "—"}
          {s.transmitArmed
            ? ` · SDR TX → усилитель${s.lastSdrTxUs != null ? ` · ${s.lastSdrTxUs} µs` : ""}`
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
                <td>{d.forwarded ? "НА TX SDR" : "ПЕРЕХВАЧЕНА"}</td>
              </tr>
            ))}
        </tbody>
      </table>
    </section>
  );
}
