// LEGION — режим SDR: Ethernet + открытие. Прошивка — отдельная вкладка.
import { useEffect } from "react";

import { imagesFor, planEthernet } from "../sdr/official";
import { useLegion } from "../state/store";

export function SdrPanel() {
  const s = useLegion();
  useEffect(() => {
    void s.probeSdr();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const opened = s.sdrOpened;
  const plan = planEthernet(s.sdrId, s.sdrGateway);
  const images = imagesFor(s.sdrId);

  return (
    <section className="panel">
      <span className="panel-title">SDR // ETHERNET · ОФИЦ. FPGA</span>
      <p className="panel-note">
        Отдельный режим от синтезатора ESP32. Ethernet-кабель — по схеме ниже.
        На SDR — только официальный hosted-образ вендора (RX-скан + TX LO).
        Запись образа — вкладка ПРОШИВКА SDR, не сюда. На шлюзе: SoapySDRServer
        --bind и python3-soapysdr + SoapyRemote.
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
      </div>
      <div className="sdr-facts">
        <div>
          Хост Soapy: {s.sdrHostReady ? "готов" : "нет"}
          {s.sdrHostDetail ? ` · ${s.sdrHostDetail}` : ""}
        </div>
        <div>Кабель: {plan.cableText}</div>
        <div>{plan.serverHint}</div>
        {plan.openArgs && <div>Открытие: {plan.openArgs}</div>}
        {images.length > 0 && (
          <div>
            Офиц. файлы (писать на вкладке ПРОШИВКА SDR):{" "}
            {images.map((im) => (
              <span key={im.kind}>
                {im.names[0]} ({im.tool}){" "}
              </span>
            ))}
          </div>
        )}
      </div>
      <label className="check-row">
        <input
          type="checkbox"
          checked={s.sdrEmulation}
          onChange={(e) => s.setSdrEmulation(e.target.checked)}
        />
        Эмуляция SDR (IQ/TX — модель хоста, не кабель). Снимите, если есть Soapy/CLI.
      </label>
      <div className="power-row">
        <button className="btn-ghost" onClick={() => void s.probeSdr()}>
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
        <button className="btn-ghost" type="button" onClick={() => s.setWorkspace("sdrFlash")}>
          ПРОШИВКА SDR →
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
    </section>
  );
}
