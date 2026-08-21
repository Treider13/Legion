// LEGION — панель коридора: SWEEP/HOP, range gate, live-маркер (фаза 3)
import { useLegion } from "../state/store";

export function CorridorPanel() {
  const s = useLegion();
  const connected = s.transportState === "connected";

  const f1 = parseFloat(s.corrF1) || 2400;
  const f2 = parseFloat(s.corrF2) || 2500;
  const span = Math.max(f2 - f1, 1e-6);
  // Позиция live-маркера телеметрии внутри коридора, %
  const markerPct =
    s.telemFreq !== null
      ? Math.min(100, Math.max(0, ((s.telemFreq - f1) / span) * 100))
      : null;

  return (
    <section className="panel">
      <span className="panel-title">КОРИДОР TX // ГЕНЕРАТОР</span>
      <p className="panel-note">
        Режим ESP32: USB → ESP32 → ADF4351 → усилитель. Нет SDR и нет антенны скана.
        Полоса/скорость задаются здесь. Скан Ethernet — другой режим.
      </p>
      <div className="corr-grid">
        <label>
          РЕЖИМ
          <select
            aria-label="Режим коридора"
            value={s.corrMode}
            onChange={(e) => s.setCorrMode(e.target.value as "SWEEP" | "HOP" | "CHIRP")}
            disabled={!connected || s.corridorRunning}
          >
            <option value="SWEEP">СВИП TX (SWEEP)</option>
            <option value="HOP">СКАЧКИ (HOP)</option>
            <option value="CHIRP">ЛЧМ (CHIRP)</option>
          </select>
        </label>
        <label>
          F1 МГц
          <input
            value={s.corrF1}
            onChange={(e) => s.setCorrField("corrF1", e.target.value)}
            disabled={!connected || s.corridorRunning}
          />
        </label>
        <label>
          F2 МГц
          <input
            value={s.corrF2}
            onChange={(e) => s.setCorrField("corrF2", e.target.value)}
            disabled={!connected || s.corridorRunning}
          />
        </label>
        <label>
          {s.corrMode === "CHIRP" ? "ШАГ Гц" : "ШАГ кГц"}
          <input
            value={s.corrStepKhz}
            onChange={(e) => s.setCorrField("corrStepKhz", e.target.value)}
            disabled={!connected || s.corridorRunning}
          />
        </label>
        <label>
          {s.corrMode === "SWEEP" ? "ВЫДЕРЖКА мс" : "ТЕМП мс"}
          <input
            value={s.corrDwellMs}
            onChange={(e) => s.setCorrField("corrDwellMs", e.target.value)}
            disabled={!connected || s.corridorRunning}
          />
        </label>
        {s.corrMode === "HOP" && (
          <label>
            СИД
            <input
              value={s.corrSeed}
              onChange={(e) => s.setCorrField("corrSeed", e.target.value)}
              disabled={!connected || s.corridorRunning}
            />
          </label>
        )}
      </div>

      {/* Range gate: полоса коридора с live-маркером телеметрии */}
      <div className="range-gate">
        <div className="range-gate-fill" />
        {markerPct !== null && (
          <div
            className={`range-marker ${s.telemLock ? "locked" : "unlocked"}`}
            style={{ left: `${markerPct}%` }}
          />
        )}
      </div>
      <div className="range-labels">
        <span>{s.corrF1}</span>
        <span className="range-cur">
          {s.telemFreq !== null ? `${s.telemFreq.toFixed(3)} МГц` : "—"}
        </span>
        <span>{s.corrF2}</span>
      </div>

      <div className="power-row">
        {s.corridorRunning ? (
          <button className="btn-danger" onClick={() => void s.corridorStop()}>
            СТОП
          </button>
        ) : (
          <button
            className="btn-primary"
            disabled={!connected}
            onClick={() => void s.corridorStart()}
          >
            ЗАПУСТИТЬ КОРИДОР
          </button>
        )}
        {s.corridorRunning && (
          <span className="state-badge state-connected">КОРИДОР TX</span>
        )}
      </div>
    </section>
  );
}
