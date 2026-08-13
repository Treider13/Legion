// LEGION — компактное управление частотой в консоли (дайл ушёл со сплэша).
import { useLegion } from "../state/store";

const PRESETS = [433.92, 868, 915, 1090, 2400, 2475];

export function FrequencyPanel() {
  const freqMhz = useLegion((s) => s.freqMhz);
  const setFreqMhz = useLegion((s) => s.setFreqMhz);
  const setFrequency = useLegion((s) => s.setFrequency);
  const connected = useLegion((s) => s.transportState === "connected");

  return (
    <section className="panel">
      <span className="panel-title">ЧАСТОТА</span>
      <div className="freq-row">
        <input
          className="freq-input"
          aria-label="Частота, МГц"
          value={freqMhz}
          onChange={(e) => setFreqMhz(e.target.value)}
          disabled={!connected}
          spellCheck={false}
        />
        <span className="freq-unit">МГц</span>
        <button className="btn-primary" disabled={!connected} onClick={() => void setFrequency()}>
          ЗАДАТЬ
        </button>
      </div>
      <div className="preset-row">
        {PRESETS.map((p) => (
          <button
            key={p}
            className="btn-ghost btn-mini"
            disabled={!connected}
            onClick={() => {
              setFreqMhz(p.toFixed(3));
              void setFrequency();
            }}
          >
            {p}
          </button>
        ))}
      </div>
    </section>
  );
}
