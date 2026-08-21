// LEGION — прошивка ESP32 только своим PlatformIO env. Не SDR.
import { useEffect, useMemo } from "react";

import { ESP32_ENV_INFO, planEsp32Flash } from "../flash/esp32";
import { useLegion } from "../state/store";

export function Esp32FlashPanel() {
  const s = useLegion();
  useEffect(() => {
    void s.refreshPorts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const info = ESP32_ENV_INFO.find((e) => e.env === s.esp32FlashEnv);
  const plan = useMemo(
    () =>
      planEsp32Flash({
        env: s.esp32FlashEnv,
        port: s.selectedPort,
        confirmed: s.esp32FlashConfirm,
        chip: s.esp32Chip,
        chipPort: s.esp32ChipPort,
      }),
    [s.esp32FlashEnv, s.selectedPort, s.esp32FlashConfirm, s.esp32Chip, s.esp32ChipPort],
  );
  const preview = useMemo(
    () =>
      planEsp32Flash({
        env: s.esp32FlashEnv,
        port: s.selectedPort,
        confirmed: true,
        chip: s.esp32Chip,
        chipPort: s.esp32ChipPort,
      }),
    [s.esp32FlashEnv, s.selectedPort, s.esp32Chip, s.esp32ChipPort],
  );

  return (
    <section className="panel">
      <span className="panel-title">ПРОШИВКА ESP32 // PLATFORMIO LEGION</span>
      <p className="panel-note">
        Сюда не принимаем файл SDR (`.rbf` / `.img` / `.frm`) и не принимаем чужой
        `.bin`. Пишется только `firmware/` через `pio run -e … --target upload`.
        Env native / native_fuzz на железо не идут. Сначала ПРОБЕ ЧИПА.
      </p>
      <p className="flash-brick">
        Неверный env на чужой кристалл кирпичит ESP32. S3 ≠ C3 ≠ classic.
        Хост перед записью сам ещё раз снимет chip_id.
      </p>
      <div className="corr-grid">
        <label>
          ПЛАТА / ENV
          <select
            aria-label="PlatformIO env ESP32"
            value={s.esp32FlashEnv}
            onChange={(e) => s.setEsp32FlashEnv(e.target.value as typeof s.esp32FlashEnv)}
          >
            {ESP32_ENV_INFO.map((e) => (
              <option key={e.env} value={e.env}>
                {e.title} — {e.warn}
              </option>
            ))}
          </select>
        </label>
        <label>
          USB-UART
          <input
            list="legion-flash-ports"
            aria-label="Serial-порт для прошивки ESP32"
            placeholder="/dev/ttyUSB0"
            value={s.selectedPort}
            onChange={(e) => s.setSelectedPort(e.target.value)}
            spellCheck={false}
          />
          <datalist id="legion-flash-ports">
            {s.ports.map((p) => (
              <option key={p.path} value={p.path} />
            ))}
          </datalist>
        </label>
      </div>
      {info && (
        <p className="panel-note">
          Ожидаем чип {info.chip}. {info.warn}.
        </p>
      )}
      <div className="power-row">
        <button
          className="btn-primary"
          type="button"
          disabled={s.flashBusy}
          onClick={() => void s.probeEsp32Chip()}
        >
          {s.flashBusy ? "ЖДИТЕ…" : "ПРОБЕ ЧИПА"}
        </button>
        <button className="btn-ghost" type="button" onClick={() => void s.refreshPorts()}>
          ПОРТЫ
        </button>
      </div>
      <p className={s.esp32Chip ? "status-line" : "panel-warn"}>
        {s.esp32Chip
          ? `чип ${s.esp32Chip} на ${s.esp32ChipPort}`
          : s.esp32ChipRaw
            ? `чип не разобран: ${s.esp32ChipRaw}`
            : "чип ещё не снят — запись закрыта"}
      </p>
      <p className={preview.ok ? "status-line" : "panel-warn"}>
        {preview.ok ? `будет запущено: ${preview.reason}` : preview.reason}
      </p>
      <label className="check-row">
        <input
          type="checkbox"
          checked={s.esp32FlashConfirm}
          onChange={(e) => s.setEsp32FlashConfirm(e.target.checked)}
        />
        Подтверждаю: на порту {s.selectedPort || "—"} чип {s.esp32Chip || "?"} = env{" "}
        {s.esp32FlashEnv}. Не образ SDR.
      </label>
      <div className="power-row">
        <button
          className="btn-danger"
          type="button"
          disabled={!plan.ok || s.flashBusy}
          onClick={() => void s.flashEsp32()}
        >
          {s.flashBusy ? "ПИШЕМ…" : "ЗАПИСАТЬ В ESP32"}
        </button>
      </div>
      {s.lastEsp32Flash && (
        <p className={s.lastEsp32Flash.written ? "status-line" : "panel-warn"}>
          {s.lastEsp32Flash.written ? "записано: " : "не записано: "}
          {s.lastEsp32Flash.reason}
        </p>
      )}
    </section>
  );
}
