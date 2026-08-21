// LEGION — только официальный образ SDR. Не ESP32 и не чужой jam.
import { useMemo } from "react";

import { inspectSdrWrite } from "../flash/sdrWrite";
import { catalogById } from "../sdr/catalog";
import { imagesFor } from "../sdr/official";
import { useLegion, type SdrFlashAction } from "../state/store";

const ACTIONS: Array<{ id: SdrFlashAction; title: string; hint: string }> = [
  { id: "load-fpga", title: "FPGA В RAM", hint: "временная загрузка, после питания пропадёт" },
  { id: "flash-fpga", title: "FPGA В FLASH", hint: "autoload, останется после питания" },
  { id: "flash-fx3", title: "FX3 / MCU", hint: "самый опасный: неверный .img кирпичит USB" },
];

export function SdrFlashPanel() {
  const s = useLegion();
  const row = catalogById(s.sdrId);
  const images = imagesFor(s.sdrId);
  const imagePath = (s.sdrImagePath || s.sdrFlashName).trim();
  const inspect = useMemo(
    () =>
      inspectSdrWrite({
        job: {
          deviceId: s.sdrOpened?.id ?? s.sdrId,
          filename: imagePath || s.sdrFlashName,
          byteLength: s.sdrImageBytes,
          action: s.sdrFlashAction,
        },
        imagePath,
        gateway: s.sdrGateway,
      }),
    [s.sdrOpened?.id, s.sdrId, imagePath, s.sdrFlashName, s.sdrImageBytes, s.sdrFlashAction, s.sdrGateway],
  );
  const canWrite = inspect.ok && s.sdrFlashConfirm && !s.flashBusy;

  return (
    <section className="panel">
      <span className="panel-title">ПРОШИВКА SDR // ОФИЦ. ОБРАЗ ВЕНДОРА</span>
      <p className="panel-note">
        Сюда не шьётся ESP32 и не шьётся чужой jam (RF-Clown / BlueJammer / nRF24).
        Ethernet и открытие SDR — вкладка SDR. Запись идёт вендорским CLI
        (bladeRF-cli / uhd_image_loader / hackrf_spiflash). Pluto — только mass-storage.
      </p>
      <p className="flash-brick">
        Неверный файл на этот SDR может закирпичить плату. Только официальный образ
        для {row?.name ?? s.sdrId}.
      </p>
      <div className="corr-grid">
        <label>
          УСТРОЙСТВО
          <select aria-label="Тип SDR для прошивки" value={s.sdrId} onChange={(e) => s.setSdrId(e.target.value)}>
            {s.sdrDevices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          ДЕЙСТВИЕ
          <select
            aria-label="Действие прошивки SDR"
            value={s.sdrFlashAction}
            onChange={(e) => s.setSdrFlashAction(e.target.value as SdrFlashAction)}
          >
            {ACTIONS.map((a) => (
              <option key={a.id} value={a.id}>
                {a.title} — {a.hint}
              </option>
            ))}
          </select>
        </label>
        <label>
          АБСОЛЮТНЫЙ ПУТЬ
          <input
            aria-label="Абсолютный путь к образу SDR"
            value={s.sdrFlashName}
            onChange={(e) => s.setSdrFlashName(e.target.value)}
            spellCheck={false}
            placeholder="/tmp/fw/hostedxA4.rbf"
          />
        </label>
      </div>
      <label className="file-row">
        Файл с сайта вендора
        <input
          type="file"
          aria-label="Файл прошивки SDR с сайта вендора"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) {
              const path =
                "path" in f && typeof (f as File & { path?: string }).path === "string"
                  ? (f as File & { path: string }).path
                  : "";
              s.setSdrImageFile(f.name, f.size, path);
            }
          }}
        />
        <span className="panel-note">
          {s.sdrImageBytes > 0
            ? `${s.sdrFlashName} · ${s.sdrImageBytes} байт${s.sdrImagePath ? "" : " · нет абсолютного пути — вставьте путь выше"}`
            : "нужен абсолютный путь. Имя без каталога CLI ищет в cwd — так не шьём."}
        </span>
      </label>
      {images.length > 0 && (
        <ul className="allow-list">
          {images.map((im) => (
            <li key={im.kind}>
              {im.names[0]} · {im.tool} ·{" "}
              <a href={im.url} target="_blank" rel="noreferrer">
                скачать у вендора
              </a>
            </li>
          ))}
        </ul>
      )}
      {s.sdrId === "plutosdr" && (
        <p className="panel-warn">
          Pluto: скопируйте pluto.frm на mass-storage и извлеките том. CLI из LEGION не запускаем.
        </p>
      )}
      {s.sdrFlashAction === "flash-fx3" && (
        <p className="panel-warn">FX3/MCU: неверный .img часто необратим. Это не FPGA bitstream.</p>
      )}
      <p className={inspect.ok ? "status-line" : "panel-warn"}>
        {inspect.ok ? `будет запущено: ${inspect.argv.join(" ")}` : inspect.reason}
      </p>
      <label className="check-row">
        <input
          type="checkbox"
          checked={s.sdrFlashConfirm}
          onChange={(e) => s.setSdrFlashConfirm(e.target.checked)}
        />
        Подтверждаю: файл — официальный образ вендора для {row?.name ?? s.sdrId}. Не ESP32.
      </label>
      <div className="power-row">
        <button className="btn-ghost" type="button" onClick={() => s.setWorkspace("sdr")}>
          ← ВКЛАДКА SDR
        </button>
        <button
          className="btn-danger"
          type="button"
          disabled={!canWrite}
          onClick={() => void s.flashSdr()}
        >
          {s.flashBusy ? "ПИШЕМ…" : "ЗАПИСАТЬ В SDR"}
        </button>
      </div>
      {s.lastFlash && (
        <p className={s.lastFlash.written ? "status-line" : "panel-warn"}>
          {s.lastFlash.written ? "записано: " : "не записано: "}
          {s.lastFlash.reason}
        </p>
      )}
    </section>
  );
}
