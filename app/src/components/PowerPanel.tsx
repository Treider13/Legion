// LEGION — панель мощности и RF on/off + SELFTEST (фаза 2)
import { POWER_DBM_TO_LOPW } from "../sl22/map";
import { useLegion } from "../state/store";

const POWERS = [-4, -1, 2, 5];

export function PowerPanel() {
  const s = useLegion();
  const connected = s.transportState === "connected";
  const sl22 = s.transportKind === "htool-sl22";

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
            {sl22 ? `P${POWER_DBM_TO_LOPW[p]}` : `${p > 0 ? `+${p}` : p} дБм`}
          </button>
        ))}
      </div>
      {!sl22 && (
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
      )}
      <div className="power-row">
        <button
          className={s.rfOn ? "btn-danger" : "btn-primary"}
          disabled={!connected}
          onClick={() => void s.setRf(!s.rfOn)}
        >
          {s.rfOn ? "РЧ ВЫКЛ" : "РЧ ВКЛ"}
        </button>
        {!sl22 && (
        <button
          className="btn-ghost"
          disabled={!connected}
          onClick={() => void s.runSelftest()}
        >
          САМОТЕСТ
        </button>
        )}
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
