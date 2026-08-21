// LEGION — режим SDR: антенна RX, усилитель на RF out. ESP32 не вызывается.
import {
  autoDispatchOptionRu,
  patternOptionRu,
  scannerParticipates,
  type AutoDispatch,
} from "../sense/modes";
import type { ScanPattern } from "../sense/scan";
import { useLegion } from "../state/store";

export function ScanPanel() {
  const s = useLegion();
  const f1 = s.sdrBands.length ? Math.min(...s.sdrBands.map((b) => b.f1Mhz)) : parseFloat(s.sdrF1) || 2400;
  const f2 = s.sdrBands.length ? Math.max(...s.sdrBands.map((b) => b.f2Mhz)) : parseFloat(s.sdrF2) || 2500;
  const span = Math.max(f2 - f1, 1e-6);
  const holdSec = s.sdrHoldSince != null ? Math.floor((Date.now() - s.sdrHoldSince) / 1000) : 0;
  const auto = scannerParticipates(s.scanPattern);
  const busy = s.scanRunning || s.transmitArmed;

  return (
    <section className="panel">
      <span className="panel-title">РЕЖИМ SDR // АВТО-СКАНЕР ИЛИ TX С НОУТБУКА</span>
      <p className="panel-note">
        АВТО: антенна RX находит сигнал, ПЕРЕДАТЬ — на усилитель до стопа.
        Приоритет — держим частоту, пока жива, затем следующая. Обычный — по очереди,
        каждая выдержка. Хост Soapy не ставит 0.3 мс: минимум 1 мс.
        Качание / сплошная / случайная — без сканера.
        СБРОСИТЬ — оператор. ESP32 сюда не входит.
      </p>
      <div className="freq-hud" aria-label="Перехваченная и TX частоты">
        <div className="freq-hud-card hit">
          <span className="freq-hud-k">ПЕРЕХВАЧЕНА</span>
          <span className="freq-hud-v">
            {s.lastInterceptMhz != null ? `${s.lastInterceptMhz.toFixed(3)}` : "—"}
          </span>
          <span className="freq-hud-u">МГц · {auto ? "energy" : "сканер выкл"}</span>
        </div>
        <div className={`freq-hud-card tx ${s.lastForwardMhz != null ? "live" : ""}`}>
          <span className="freq-hud-k">НА TX SDR</span>
          <span className="freq-hud-v">
            {s.lastForwardMhz != null ? `${s.lastForwardMhz.toFixed(3)}` : "—"}
          </span>
          <span className="freq-hud-u">
            МГц · {auto ? (s.autoDispatch === "priority" ? "приоритет" : "очередь") : "открытый TX"}
            {s.lastForwardMhz != null ? ` · ${holdSec} с` : ""}
            {s.lastSdrTxUs != null ? ` · ${s.lastSdrTxUs} µs host` : ""}
          </span>
        </div>
      </div>
      <div className="corr-grid">
        <label>
          РЕЖИМ
          <select
            aria-label="Режим работы SDR"
            value={s.scanPattern}
            onChange={(e) => s.setScanPattern(e.target.value as ScanPattern)}
            disabled={busy}
          >
            <option value="auto">{patternOptionRu("auto")}</option>
            <option value="sweep">{patternOptionRu("sweep")}</option>
            <option value="band">{patternOptionRu("band")}</option>
            <option value="hop">{patternOptionRu("hop")}</option>
          </select>
        </label>
        {auto && (
          <label>
            АВТО
            <select
              aria-label="Приоритет или очередь АВТО"
              value={s.autoDispatch}
              onChange={(e) => s.setAutoDispatch(e.target.value as AutoDispatch)}
              disabled={busy}
            >
              <option value="turn">{autoDispatchOptionRu("turn")}</option>
              <option value="priority">{autoDispatchOptionRu("priority")}</option>
            </select>
          </label>
        )}
        <label>
          F1 МГц
          <input
            value={s.sdrF1}
            onChange={(e) => s.setSdrAllowField("sdrF1", e.target.value)}
            disabled={busy}
          />
        </label>
        <label>
          F2 МГц
          <input
            value={s.sdrF2}
            onChange={(e) => s.setSdrAllowField("sdrF2", e.target.value)}
            disabled={busy}
          />
        </label>
        <label>
          {auto ? "ОКНО RX МГц" : "ШАГ TX МГц"}
          <input
            value={s.scanWindowMhz}
            onChange={(e) => s.setScanWindowMhz(e.target.value)}
            disabled={busy}
          />
        </label>
        <label>
          ВЫДЕРЖКА мс
          <input
            value={s.scanDwellMs}
            onChange={(e) => s.setScanDwellMs(e.target.value)}
            disabled={busy}
          />
        </label>
      </div>
      <p className="sens-hint">
        {auto
          ? s.autoDispatch === "priority"
            ? "приоритет: держим частоту, пока не пропадёт, затем следующая сильнейшая"
            : "обычный: частота на выдержку, затем следующая из эфира (хост ≥ 1 мс)"
          : "без сканера: ноутбук по Ethernet ставит TX LO до стопа (качание / сплошная / случайная)"}
      </p>
      {auto && (
        <>
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
              aria-label="Чувствительность засечки"
            />
            <span className="att-value">{Math.round(s.scanThresholdDb)} дБ СНР</span>
          </div>
          <p className="sens-hint">низкая = все подряд · высокая = только сильные</p>
        </>
      )}
      <label className="check-row">
        <input
          type="checkbox"
          checked={s.sdrLoadOk}
          onChange={(e) => s.setSdrLoad(e.target.checked)}
        />
        Нагрузка 50 Ом на выходе усилителя SDR
      </label>
      <div className="power-row">
        <button className="btn-primary" onClick={() => s.addSdrBand()} disabled={busy}>
          ДОБАВИТЬ ПОЛОСУ
        </button>
        <button className="btn-ghost" onClick={() => s.clearSdrBands()} disabled={busy}>
          ОЧИСТИТЬ
        </button>
        {auto && (
          <button className="btn-ghost" onClick={() => s.injectDemoTone()}>
            ДЕМО-НЕСУЩАЯ
          </button>
        )}
        {auto &&
          (s.scanRunning ? (
            <button className="btn-danger" onClick={() => s.stopScan()}>
              СТОП СКАН
            </button>
          ) : (
            <button className="btn-primary" onClick={() => s.startScan()}>
              СКАНИРОВАТЬ
            </button>
          ))}
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
        {s.sdrBands.length === 0 && <li>полоса из F1…F2 при старте, либо добавьте вручную</li>}
        {s.sdrBands.map((b, i) => (
          <li key={`${b.f1Mhz}-${b.f2Mhz}-${i}`}>
            {b.f1Mhz} … {b.f2Mhz} МГц
          </li>
        ))}
      </ul>

      <div className="spectrum-wrap" aria-label="Спектр скана">
        {auto && s.scanBins.length > 0 ? (
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
        {s.scanCenterMhz !== null && auto && (
          <div
            className="spectrum-center"
            style={{ left: `${Math.min(100, Math.max(0, ((s.scanCenterMhz - f1) / span) * 100))}%` }}
          />
        )}
      </div>
      <div className="range-labels">
        <span>{f1}</span>
        <span className="range-cur">
          {s.lastForwardMhz != null
            ? `${s.lastForwardMhz.toFixed(3)} МГц`
            : s.scanCenterMhz != null
              ? `${s.scanCenterMhz.toFixed(3)} МГц`
              : "—"}
          {s.transmitArmed ? (auto ? " · авто TX" : " · TX с ноутбука") : auto && s.scanRunning ? " · слушает" : ""}
        </span>
        <span>{f2}</span>
      </div>
      <p className="status-line">{s.lastCueReason || "режим и ПЕРЕДАТЬ — решение оператора"}</p>
      {auto && (
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
                <td colSpan={4}>нет засечек — СКАНИРОВАТЬ, затем ПЕРЕДАТЬ</td>
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
      )}
    </section>
  );
}
