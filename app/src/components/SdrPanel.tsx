// LEGION — каталог SDR + прошивка официальных образов (хост, не ESP32 OTA).
import { useLegion } from "../state/store";

export function SdrPanel() {
  const s = useLegion();
  const opened = s.sdrOpened;

  return (
    <section className="panel">
      <span className="panel-title">SDR // ХОСТ</span>
      <p className="panel-note">
        bladeRF 2.0 micro xA4 — USB 3.0, без Ethernet. LAN = адрес шлюза SoapyRemote на мини-ПК у платы.
        Прошивка FPGA/FX3 — не OTA ESP32.
      </p>
      <div className="corr-grid">
        <label>
          УСТРОЙСТВО
          <select aria-label="Тип SDR" value={s.sdrId} onChange={(e) => s.setSdrId(e.target.value)}>
            {s.sdrDevices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          ШЛЮЗ LAN (хост)
          <input
            aria-label="Хост SoapyRemote"
            placeholder="192.168.1.20"
            value={s.sdrGateway}
            onChange={(e) => s.setSdrGateway(e.target.value)}
            spellCheck={false}
          />
        </label>
        <label>
          ОБРАЗ
          <input
            aria-label="Имя файла прошивки SDR"
            value={s.sdrFlashName}
            onChange={(e) => s.setSdrFlashName(e.target.value)}
            spellCheck={false}
          />
        </label>
      </div>
      <div className="power-row">
        <button className="btn-ghost" onClick={() => s.probeSdr()}>
          PROBE
        </button>
        {opened ? (
          <button className="btn-danger" onClick={() => s.closeSdr()}>
            ЗАКРЫТЬ SDR
          </button>
        ) : (
          <button className="btn-primary" onClick={() => s.openSdr()}>
            ОТКРЫТЬ SDR
          </button>
        )}
        <button className="btn-ghost" disabled={!opened} onClick={() => s.flashSdr("load-fpga")}>
          FPGA В RAM
        </button>
        <button className="btn-ghost" disabled={!opened} onClick={() => s.flashSdr("flash-fpga")}>
          FPGA В FLASH
        </button>
        <button className="btn-ghost" disabled={!opened} onClick={() => s.flashSdr("flash-fx3")}>
          FX3
        </button>
      </div>
      {opened && (
        <div className="sdr-facts">
          <div>Открыт: {opened.name} · {opened.serial}</div>
          <div>Интерфейс: {opened.iface}{opened.nativeEthernet ? " · нативный Ethernet" : " · Ethernet только через шлюз"}</div>
          <div>FPGA: {opened.fpga}</div>
          <div>{opened.flash.notes}</div>
          <div>{opened.lanHint}</div>
          <div>{opened.paHint}</div>
          {s.sdrRemote && <div>Soapy: {s.sdrRemote}</div>}
        </div>
      )}
      {s.lastFlash && (
        <p className={s.lastFlash.ok ? "status-line" : "panel-warn"}>{s.lastFlash.reason}</p>
      )}
    </section>
  );
}
