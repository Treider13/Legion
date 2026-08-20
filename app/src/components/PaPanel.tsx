// LEGION — усилитель: интерлок нагрузки + команда тока. Не SDR.
import { useLegion } from "../state/store";

export function PaPanel() {
  const s = useLegion();
  const connected = s.transportState === "connected";

  return (
    <section className="panel">
      <span className="panel-title">УСИЛИТЕЛЬ // НАГРУЗКА 50Ω</span>
      <p className="panel-note">
        Режим ESP32: ток задатчика на усилитель после ADF4351. Это не усилитель на
        RF out SDR. Скан и ПЕРЕДАТЬ на вкладке SDR сюда не ходят.
      </p>
      <label className="check-row">
        <input
          type="checkbox"
          checked={s.loadOk}
          onChange={(e) => void s.setLoad(e.target.checked)}
        />
        Подтверждаю эквивалент антенны / экран (LOAD OK)
      </label>
      <div className="att-row">
        <span className="att-label">ТОК</span>
        <input
          type="range"
          aria-label="Ток PA, мА"
          min={0}
          max={1500}
          step={10}
          value={s.paMa}
          disabled={!connected}
          onChange={(e) => s.setPaMa(parseInt(e.target.value, 10))}
          className="att-slider"
        />
        <span className="att-value">{s.paMa} мА</span>
      </div>
      <div className="power-row">
        <button className="btn-ghost" disabled={!connected} onClick={() => void s.applyPaCurrent()}>
          ЗАДАТЬ ТОК
        </button>
        <button
          className={s.paOn ? "btn-danger" : "btn-primary"}
          disabled={!connected}
          onClick={() => void s.setPaEnabled(!s.paOn)}
        >
          {s.paOn ? "PA ВЫКЛ" : "PA ВКЛ"}
        </button>
      </div>
      <p className="status-line">{s.paOn ? `PA ON ${s.paMa} мА` : "PA выключен (режим ESP32)"}</p>
    </section>
  );
}
