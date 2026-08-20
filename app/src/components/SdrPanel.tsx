// LEGION — режим SDR: Ethernet + официальная прошивка. Не ESP32 и не OTA.
import { defaultFlashName, imagesFor, planEthernet } from "../sdr/official";
import { useLegion } from "../state/store";

export function SdrPanel() {
  const s = useLegion();
  const opened = s.sdrOpened;
  const plan = planEthernet(s.sdrId, s.sdrGateway);
  const images = imagesFor(s.sdrId);

  return (
    <section className="panel">
      <span className="panel-title">SDR // ETHERNET · ОФИЦ. FPGA</span>
      <p className="panel-note">
        Отдельный режим от синтезатора ESP32. Сюда не шьётся прошивка ESP32.
        Ethernet-кабель — по схеме ниже. На SDR — только официальный образ вендора
        (Nuand / ADI / Ettus / GSG), чтобы RX+TX LO работали. Свой jam-FPGA не ставим.
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
          ETHERNET (IP)
          <input
            aria-label="Адрес Ethernet SDR или шлюза"
            placeholder={plan.defaultHost}
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
      <div className="sdr-facts">
        <div>Кабель: {plan.cableText}</div>
        <div>{plan.serverHint}</div>
        {plan.openArgs && <div>Открытие: {plan.openArgs}</div>}
        {images.length > 0 && (
          <div>
            Офиц. файлы:{" "}
            {images.map((im) => (
              <span key={im.kind}>
                {im.names[0]} ({im.tool}){" "}
              </span>
            ))}
          </div>
        )}
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
        <button
          className="btn-ghost"
          disabled={!opened}
          onClick={() => {
            if (!s.sdrFlashName) s.setSdrFlashName(defaultFlashName(s.sdrId));
            s.flashSdr("load-fpga");
          }}
        >
          FPGA В RAM
        </button>
        <button className="btn-ghost" disabled={!opened} onClick={() => s.flashSdr("flash-fpga")}>
          FPGA В FLASH
        </button>
        <button className="btn-ghost" disabled={!opened} onClick={() => s.flashSdr("flash-fx3")}>
          FX3 / MCU
        </button>
      </div>
      {opened && (
        <div className="sdr-facts">
          <div>Открыт: {opened.name} · {opened.serial}</div>
          <div>
            Интерфейс: {opened.iface}
            {opened.nativeEthernet ? " · RJ45 на SDR" : " · RJ45 только на шлюзе"}
          </div>
          <div>FPGA: {opened.fpga}</div>
          <div>
            Аналог. BW: {opened.analogBwMhz} МГц ·{" "}
            {opened.fullDuplex ? "full-duplex RX+TX" : "half-duplex / только RX"}
          </div>
          <div>{opened.flash.notes}</div>
          {s.sdrRemote && <div>Soapy/UHD: {s.sdrRemote}</div>}
        </div>
      )}
      {s.lastFlash && (
        <p className={s.lastFlash.ok ? "status-line" : "panel-warn"}>{s.lastFlash.reason}</p>
      )}
    </section>
  );
}
