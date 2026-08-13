// LEGION — панель частоты: ввод, пресеты, LOCK-индикация (фаза 2)
import { useLegion } from "../state/store";

const PRESETS = [2400, 2425, 2450, 2475, 2500];

export function FrequencyPanel() {
  const s = useLegion();
  const connected = s.transportState === "connected";

  return (
    <section className="panel">
      <span className="panel-title">FREQUENCY</span>
      <div className="freq-row">
        <input
          className="freq-input"
          value={s.freqMhz}
          onChange={(e) => s.setFreqMhz(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void s.setFrequency()}
          disabled={!connected}
          spellCheck={false}
        />
        <span className="freq-unit">MHz</span>
        <button
          className="btn-primary"
          onClick={() => void s.setFrequency()}
          disabled={!connected}
        >
          SET FREQ
        </button>
      </div>
      <div className="preset-row">
        {PRESETS.map((p) => (
          <button
            key={p}
            className="btn-ghost"
            disabled={!connected}
            onClick={() => {
              s.setFreqMhz(p.toFixed(3));
              // сразу применяем
              setTimeout(() => void s.setFrequency(), 0);
            }}
          >
            {p}
          </button>
        ))}
      </div>
      <div className="lock-row">
        <span
          className={
            s.lock === null
              ? "lock-badge lock-unknown"
              : s.lock
                ? "lock-badge lock-yes"
                : "lock-badge lock-no"
          }
        >
          {s.lock === null ? "LOCK —" : s.lock ? "LOCK ✓" : "NO LOCK ✗"}
        </span>
        {s.status && (
          <span className="status-line">
            {s.status.freq.toFixed(6)} MHz · {s.status.mode} · {s.status.board}
          </span>
        )}
      </div>
    </section>
  );
}
