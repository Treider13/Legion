// LEGION — усилитель: интерлок нагрузки + команда тока. Не SDR.
import { useLegion } from "../state/store";

export function PaPanel() {
  const s = useLegion();
  const connected = s.transportState === "connected";

  return (
    <section className="panel">
      <span className="panel-title">УСИЛИТЕЛЬ // НАГРУЗКА 50Ω</span>
      <p className="panel-note">
        Конвейер «уловил → в нагрузку» запускается кнопкой ПЕРЕДАТЬ на вкладке СКАН RX.
        Здесь ручной ток и интерлок. Bias-tee BladeRF — только on/off, не мА.
      </p>
      <label className="check-row">
        <input
          type="checkbox"
          checked={s.loadOk}
          onChange={(e) => void s.setLoad(e.target.checked)}
        />
        Подтверждаю эквивалент антенны / экран (LOAD OK)
      </label>
      <label className="check-row">
        <input
          type="checkbox"
          checked={s.autoCue}
          onChange={(e) => s.setAutoCue(e.target.checked)}
        />
        Авто-наведение синтезатора после обнаружения (только в нагрузку, без RF ON)
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
      <p className="status-line">{s.lastCueReason || "CUE не выполнялся"}</p>
    </section>
  );
}
