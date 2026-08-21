// LEGION — режим SDR: антенна RX, усилитель на RF out. ESP32 не вызывается.
import { lockIsStuck, STUCK_MS } from "../sense/hold";
import type { ScanPattern } from "../sense/scan";
import { useLegion } from "../state/store";

export function ScanPanel() {
  const s = useLegion();
  const f1 = s.sdrBands.length ? Math.min(...s.sdrBands.map((b) => b.f1Mhz)) : parseFloat(s.sdrF1) || 2400;
  const f2 = s.sdrBands.length ? Math.max(...s.sdrBands.map((b) => b.f2Mhz)) : parseFloat(s.sdrF2) || 2500;
  const span = Math.max(f2 - f1, 1e-6);
  const holdSec = s.sdrHoldSince != null ? Math.floor((Date.now() - s.sdrHoldSince) / 1000) : 0;
  const stuck = lockIsStuck(s.sdrHoldSince, Date.now(), STUCK_MS);

  return (
    <section className="panel">
      <span className="panel-title">РЕЖИМ SDR // АВТО: ПОЛОСА → ЗАСЕЧКА → УСИЛИТЕЛЬ</span>
      <p className="panel-note">
        Задайте начало и конец, нажмите ЗАПУСТИТЬ. Скан гоняет полосу сам. Сильная
        засечка сразу на TX SDR → усилитель; чуть сильнее — тоже сразу. СБРОСИТЬ —
        если одна частота слишком долго. Energy detect, не RF-Clown/BlueJammer.
        ESP32 сюда не входит. Нагрузка 50 Ом обязательна для TX.
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
            МГц · авто
            {s.lastForwardMhz != null ? ` · ${holdSec} с` : ""}
            {s.lastSdrTxUs != null ? ` · ${s.lastSdrTxUs} µs host` : ""}
          </span>
        </div>
      </div>
      <div className="corr-grid">
        <label>
          ОБХОД
          <select
            aria-label="Режим обхода полосы"
            value={s.scanPattern}
            onChange={(e) => s.setScanPattern(e.target.value as ScanPattern)}
            disabled={s.scanRunning}
          >
            <option value="sweep">ТУДА-СЮДА</option>
            <option value="band">СПЛОШНАЯ ПОЛОСА</option>
            <option value="hop">СЛУЧАЙНАЯ</option>
          </select>
        </label>
        <label>
          F1 МГц
          <input
            value={s.sdrF1}
            onChange={(e) => s.setSdrAllowField("sdrF1", e.target.value)}
            disabled={s.scanRunning}
          />
        </label>
        <label>
          F2 МГц
          <input
            value={s.sdrF2}
            onChange={(e) => s.setSdrAllowField("sdrF2", e.target.value)}
            disabled={s.scanRunning}
          />
        </label>
        <label>
          ОКНО МГц
          <input
            value={s.scanWindowMhz}
            onChange={(e) => s.setScanWindowMhz(e.target.value)}
            disabled={s.scanRunning}
            aria-label="Ширина окна скана в МГц"
          />
        </label>
        <label>
          ВЫДЕРЖКА мс
          <input
            value={s.scanDwellMs}
            onChange={(e) => s.setScanDwellMs(e.target.value)}
            disabled={s.scanRunning}
            aria-label="Время стоянки на окне"
          />
        </label>
      </div>
      <p className="sens-hint">
        окно: 1 МГц или 20 МГц — сколько сразу смотрим. случайная: выдержка на каждой
        стойке. сплошная: по полосе в одну сторону. туда-сюда: туда и обратно.
      </p>
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
        <button className="btn-primary" onClick={() => s.addSdrBand()} disabled={s.scanRunning}>
          ДОБАВИТЬ ПОЛОСУ
        </button>
        <button className="btn-ghost" onClick={() => s.clearSdrBands()} disabled={s.scanRunning}>
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
          <button className="btn-primary" onClick={() => void s.startAuto()}>
            ЗАПУСТИТЬ
          </button>
        )}
        {s.transmitArmed ? (
          <button className="btn-danger" onClick={() => void s.stopTransmit()}>
            СТОП ПЕРЕДАЧУ
          </button>
        ) : s.scanRunning ? (
          <button className="btn-primary" onClick={() => void s.startTransmit()}>
            ПЕРЕДАТЬ
          </button>
        ) : null}
        <button
          className={stuck ? "btn-danger" : "btn-ghost"}
          disabled={s.lastForwardMhz == null}
          onClick={() => void s.resetSdrLock()}
        >
          СБРОСИТЬ
        </button>
      </div>
      <ul className="allow-list">
        {s.sdrBands.length === 0 && <li>полоса из F1…F2 при ЗАПУСТИТЬ, либо добавьте вручную</li>}
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
            ? ` · авто TX${stuck ? " · залипло, СБРОСИТЬ" : ""}`
            : s.scanRunning
              ? " · слушает"
              : ""}
        </span>
        <span>{f2}</span>
      </div>
      <p className="status-line">{s.lastCueReason || "задайте F1…F2 и ЗАПУСТИТЬ"}</p>
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
              <td colSpan={4}>нет событий — задайте полосу и запустите</td>
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
