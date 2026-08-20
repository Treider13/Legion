// LEGION — ручная частота ADF4351 (актуатор). Не SDR и не скан.
import { useLegion } from "../state/store";
import { PowerPanel } from "./PowerPanel";

export function SynthPanel() {
  const s = useLegion();
  const connected = s.transportState === "connected";

  return (
    <>
      <section className="panel">
        <span className="panel-title">СИНТЕЗАТОР // ADF4351</span>
        <p className="panel-note">
          Режим ESP32: генератор ADF4351. SDR и Ethernet здесь не участвуют.
          Приём — СКАН RX. Официальная FPGA SDR — вкладка SDR.
        </p>
        <div className="corr-grid">
          <label>
            ЧАСТОТА МГц
            <input
              aria-label="Частота синтезатора, МГц"
              value={s.freqMhz}
              onChange={(e) => s.setFreqMhz(e.target.value)}
              disabled={!connected}
            />
          </label>
        </div>
        <div className="power-row">
          <button className="btn-primary" disabled={!connected} onClick={() => void s.setFrequency()}>
            УСТАНОВИТЬ
          </button>
          <span className={`lock-badge ${s.lock === true ? "lock-yes" : s.lock === false ? "lock-no" : "lock-unknown"}`}>
            {s.lock === true ? "LOCK" : s.lock === false ? "НЕТ LOCK" : "LOCK —"}
          </span>
        </div>
      </section>
      <PowerPanel />
    </>
  );
}
