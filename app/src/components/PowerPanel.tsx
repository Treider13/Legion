// LEGION — панель мощности и RF on/off + SELFTEST (фаза 2)
import { useLegion } from "../state/store";

const POWERS = [-4, -1, 2, 5];

export function PowerPanel() {
  const s = useLegion();
  const connected = s.transportState === "connected";

  return (
    <section className="panel">
      <span className="panel-title">РЧ-ВЫХОД</span>
      <div className="power-row">
        {POWERS.map((p) => (
          <button
            key={p}
            className={s.powerDbm === p ? "btn-ghost active" : "btn-ghost"}
            disabled={!connected}
            onClick={() => void s.setPower(p)}
          >
            {p > 0 ? `+${p}` : p} дБм
          </button>
        ))}
      </div>
      {/* PE43702: аттенюатор 0–31.75 дБ (фаза 8) */}
      <div className="att-row">
        <span className="att-label">АТТ</span>
        <input
          type="range"
          aria-label="Затухание PE43702, дБ"
          min={0}
          max={31.75}
          step={0.25}
          value={s.attDb}
          disabled={!connected}
          onChange={(e) => void s.setAtt(parseFloat(e.target.value))}
          className="att-slider"
        />
        <span className="att-value">{s.attDb.toFixed(2)} дБ</span>
      </div>
      <div className="power-row">
        <button
          className={s.rfOn ? "btn-danger" : "btn-primary"}
          disabled={!connected}
          onClick={() => void s.setRf(!s.rfOn)}
        >
          {s.rfOn ? "РЧ ВЫКЛ" : "РЧ ВКЛ"}
        </button>
        <button
          className="btn-ghost"
          disabled={!connected}
          onClick={() => void s.runSelftest()}
        >
          САМОТЕСТ
        </button>
        <button
          className="btn-ghost"
          disabled={!connected}
          onClick={() => void s.pollStatus()}
        >
          СТАТУС?
        </button>
      </div>
    </section>
  );
}
