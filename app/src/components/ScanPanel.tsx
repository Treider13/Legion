// LEGION — режим SDR: антенна RX, усилитель на RF out. ESP32 не вызывается.
import {
  autoDispatchOptionRu,
  isFpgaAirLive,
  isFpgaAirPattern,
  isFpgaTaskLive,
  patternOptionRu,
  scannerParticipates,
  type AutoDispatch,
} from "../sense/modes";
import { airTractParams, fpgaAirSupported, fpgaObserveLine, fpgaTurnDwellClamp, parseLocaleNumber, parkSpanMhz } from "../sense/fpgaFastpath";
import type { ScanPattern } from "../sense/scan";
import { catalogCaps } from "../sdr/hostClient";
import { parseSdrRxBand } from "../sdr/catalog";
import { waveMeta } from "../sdr/waveforms";
import { useLegion } from "../state/store";
import { LabJournalPanel } from "./LabJournalPanel";
import { SpectrumScope } from "./SpectrumScope";

export function ScanPanel() {
  const s = useLegion();
  const f1 = s.sdrBands.length ? Math.min(...s.sdrBands.map((b) => b.f1Mhz)) : parseFloat(s.sdrF1) || 2400;
  const f2 = s.sdrBands.length ? Math.max(...s.sdrBands.map((b) => b.f2Mhz)) : parseFloat(s.sdrF2) || 2500;
  const holdSec = s.sdrHoldSince != null ? Math.floor((Date.now() - s.sdrHoldSince) / 1000) : 0;
  const fpgaAir = isFpgaAirPattern(s.scanPattern);
  const airLive = isFpgaAirLive(s.fpgaArmed, s.fpgaMode);
  const taskLive = isFpgaTaskLive(s.fpgaArmed, s.fpgaMode);
  const auto = scannerParticipates(s.scanPattern) && !taskLive && !airLive;
  const interceptSetup = fpgaAir && !taskLive && !airLive;
  const busy = s.scanRunning || s.transmitArmed || s.fpgaArmed;
  const analogBw = catalogCaps(s.sdrId).analogBwMhz;
  const fpgaBands = s.sdrBands.length
    ? s.sdrBands
    : (() => {
        const b = parseSdrRxBand(s.sdrF1, s.sdrF2, s.sdrId);
        return b ? [b] : [];
      })();
  const fpgaSpan = parkSpanMhz(fpgaBands);
  const tract = airTractParams(parseLocaleNumber(s.fpgaAirBwMhz), analogBw, s.fpgaDetShift);
  const fpgaWindowUs = tract.windowUs;

  return (
    <section className="panel">
      <span className="panel-title">
        {taskLive
          ? "РЕЖИМ SDR // FPGA · ЗАДАЧА С НОУТБУКА"
          : fpgaAir
            ? "РЕЖИМ SDR // АВТОМАТИЧЕСКИЙ ПЕРЕХВАТ · РЕТРАНСЛЯЦИЯ В FPGA"
            : airLive
              ? "РЕЖИМ SDR // FPGA · АВТОНОМНЫЙ ЭФИР (БЕЗ СКАНЕРА)"
              : "РЕЖИМ SDR // АВТО-СКАНЕР ИЛИ TX С НОУТБУКА"}
      </span>
      <p className="panel-note">
        {taskLive
          ? "Идёт FPGA-задача с вкладки ТИП СИГНАЛА (генерация/постоянная ретрансляция). Это не автоперехват и не хост-скан. Стоп — там или кнопкой ниже."
          : fpgaAir
            ? "Автоматический перехват: после Старта хозяин — SDR. Антенна на RX1 / RX SMA, усилитель на TX1 / TX SMA. Плата сама видит энергию в аналоговом окне и сама открывает TX. Гейт в текущем взгляде — микросекунды. Нашёл частоту — усилитель на выдержке (например 0.4 мс), затем следующий взгляд. USB не в круге «увидел → усилитель». Ноутбук — коридор, выдержка, Старт/Стоп и наблюдение. Порог — поле ниже (не полка USB-IQ)."
            : airLive
              ? "Автономный эфир: детектор в FPGA, ретрансляция RX→TX по энергии на стоянке или обходе коридора с ноутбука (tune). Это не автоперехват. Стоп — кнопкой ниже."
              : "АВТО + ПЕРЕДАТЬ — хост-скан (на ноутбуке), задержка миллисекунды. Микросекунды: автоматический перехват. Хост-скан и FPGA вместе не работают (один USB)."}
      </p>
      <div className="freq-hud" aria-label="Перехваченная и TX частоты">
        <div className="freq-hud-card hit">
          <span className="freq-hud-k">{airLive ? "ДЕТЕКТОР FPGA" : taskLive ? "FPGA-ЗАДАЧА" : "ПЕРЕХВАЧЕНА"}</span>
          <span className="freq-hud-v">
            {airLive
              ? s.fpgaStatus?.det_active
                ? "есть"
                : "нет"
              : taskLive
                ? s.fpgaMode
                : s.lastInterceptMhz != null
                  ? `${s.lastInterceptMhz.toFixed(3)}`
                  : "—"}
          </span>
          <span className="freq-hud-u">
            {airLive
              ? s.fpgaStatus?.det_active
                ? "энергия в окне"
                : "окно FPGA"
              : taskLive
                ? "не перехват"
                : `МГц · ${auto ? "energy" : "сканер выкл"}`}
          </span>
        </div>
        <div className={`freq-hud-card tx ${airLive ? (s.fpgaStatus?.det_active ? "live" : "") : s.lastForwardMhz != null ? "live" : ""}`}>
          <span className="freq-hud-k">{airLive ? "РЕТРАНСЛЯЦИЯ" : taskLive ? "SDR ИГРАЕТ" : "НА TX SDR"}</span>
          <span className="freq-hud-v">
            {airLive
              ? s.fpgaStatus?.det_active
                ? "TX"
                : "—"
              : taskLive
                ? "TX"
                : s.lastForwardMhz != null
                  ? `${s.lastForwardMhz.toFixed(3)}`
                  : "—"}
          </span>
          <span className="freq-hud-u">
            {airLive
              ? s.fpgaStatus?.det_active
                ? `RX→TX · ${fpgaWindowUs.toFixed(0)} µs`
                : "гейт закрыт"
              : taskLive
                ? "задача с ноутбука"
                : `МГц · ${
                    auto
                      ? s.autoDispatch === "priority"
                        ? "приоритет"
                        : "очередь"
                      : "открытый TX"
                  }${s.lastForwardMhz != null ? ` · ${holdSec} с` : ""}${
                    s.lastSdrTxUs != null ? ` · ${s.lastSdrTxUs} µs host` : ""
                  }`}
          </span>
        </div>
      </div>
      <div className="corr-grid">
        <label>
          РЕЖИМ
          <select
            aria-label="Режим работы SDR"
            value={s.scanPattern}
            onChange={(e) => s.setScanPattern(e.target.value as ScanPattern)}
            disabled={busy}
          >
            <option value="auto">{patternOptionRu("auto")}</option>
            <option value="fpga">{patternOptionRu("fpga")}</option>
            <option value="sweep">{patternOptionRu("sweep")}</option>
            <option value="band">{patternOptionRu("band")}</option>
            <option value="hop">{patternOptionRu("hop")}</option>
          </select>
        </label>
        {fpgaAir && !taskLive && (
          <>
            <label title="Минимальная энергия I²+Q², при которой открывается гейт. В перехвате порог задаёт оператор (полка USB-IQ в круге больше не меряется).">
              ПОРОГ ЧУВСТВИТЕЛЬНОСТИ
              <input
                aria-label="Порог чувствительности детектора FPGA"
                type="number"
                min={1}
                step={100}
                value={s.fpgaDetThr}
                onChange={(e) => s.setFpgaDetThr(parseFloat(e.target.value))}
                disabled={busy || s.fpgaBusy}
              />
            </label>
            <label title="Ширина одного взгляда платы и шаг сетки LO (аналоговый фильтр). Уже — соседние частоты как разные стоянки; шире потолка платы — урежется.">
              ВЗГЛЯД, МГц
              <input
                aria-label="Ширина взгляда платы (аналоговый фильтр)"
                type="number"
                min={0.2}
                max={analogBw}
                step={0.2}
                value={s.fpgaAirBwMhz}
                onChange={(e) => s.setFpgaAirBwMhz(e.target.value)}
                disabled={busy || s.fpgaBusy}
              />
            </label>
            <label title="Лабораторный параметр: за какое окно сэмплов детектор усредняет энергию (2^N сэмплов). Больше окно — стабильнее порог, но медленнее реакция. Обычно менять не нужно.">
              УСРЕДНЕНИЕ ДЕТЕКТОРА
              <input
                aria-label="Окно детектора FPGA"
                type="number"
                min={4}
                max={12}
                step={1}
                value={s.fpgaDetShift}
                onChange={(e) => s.setFpgaDetShift(parseFloat(e.target.value))}
                disabled={busy || s.fpgaBusy}
              />
            </label>
            {s.autoDispatch === "turn" && (
              <label title="Сколько миллисекунд держать усилитель на найденной частоте, затем шаг дальше (можно 0.4).">
                ВЫДЕРЖКА НА ЧАСТОТЕ мс
                <input
                  aria-label="Выдержка на частоте до переключения по очереди"
                  type="number"
                  min={0.1}
                  max={60000}
                  step={0.1}
                  value={s.fpgaTurnDwellMs}
                  onChange={(e) => s.setFpgaTurnDwellMs(e.target.value)}
                  disabled={busy || s.fpgaBusy}
                />
              </label>
            )}
          </>
        )}
        {(auto || interceptSetup) && (
          <label>
            АВТО
            <select
              aria-label="Приоритет или очередь АВТО"
              value={s.autoDispatch}
              onChange={(e) => s.setAutoDispatch(e.target.value as AutoDispatch)}
              disabled={busy}
            >
              <option value="park">{autoDispatchOptionRu("park")}</option>
              <option value="turn">{autoDispatchOptionRu("turn")}</option>
              <option value="priority">{autoDispatchOptionRu("priority")}</option>
            </select>
          </label>
        )}
        <label>
          F1 МГц
          <input
            value={s.sdrF1}
            onChange={(e) => s.setSdrAllowField("sdrF1", e.target.value)}
            disabled={busy}
          />
        </label>
        <label>
          F2 МГц
          <input
            value={s.sdrF2}
            onChange={(e) => s.setSdrAllowField("sdrF2", e.target.value)}
            disabled={busy}
          />
        </label>
        {!fpgaAir && !taskLive && (
          <>
            <label>
              {auto ? "ОКНО RX МГц" : "ШАГ TX МГц"}
              <input
                value={s.scanWindowMhz}
                onChange={(e) => s.setScanWindowMhz(e.target.value)}
                disabled={busy}
              />
            </label>
            <label>
              ВЫДЕРЖКА мс
              <input
                value={s.scanDwellMs}
                onChange={(e) => s.setScanDwellMs(e.target.value)}
                disabled={busy}
              />
            </label>
          </>
        )}
      </div>
      <p className="sens-hint">
        {taskLive
          ? "FPGA-задача с вкладки ТИП СИГНАЛА — не автоперехват и не хост-скан"
          : fpgaAir
          ? `ретрансляция в FPGA, окно ${fpgaWindowUs.toFixed(1)} µs. Ноутбук не считает спектр и не ставит TX — только наблюдает. ${
              s.autoDispatch === "park"
                ? "Стоянка: LO на середине коридора, хопы внутри взгляда — на усилитель без PLL"
                : s.autoDispatch === "turn"
                ? `По очереди: цели по кругу, выдержка ${fpgaTurnDwellClamp(parseLocaleNumber(s.fpgaTurnDwellMs))} мс на частоту`
                : "Приоритет: сильнейшая, пока жива"
            }`
          : auto
            ? s.autoDispatch === "priority"
              ? "приоритет: сильнее рядом — сразу на неё; слабее не сбивает; пропала — следующая"
              : s.autoDispatch === "park"
                ? "стоянка: один взгляд, хопы внутри цифрой"
                : "обычный: частота на выдержку, затем следующая из эфира (хост ≥ 1 мс)"
            : "без сканера: ноутбук по Ethernet ставит TX LO до стопа (качание / сплошная / случайная)"}
      </p>
      {!fpgaAir && !taskLive && (
        <p className="sens-hint">
          TX-контент:{" "}
          {s.txWaveKind !== null
            ? `зашитая волна «${waveMeta(s.txWaveKind).title}» (вкладка ТИП СИГНАЛА)`
            : "CW тон · сменить — вкладка ТИП СИГНАЛА"}
        </p>
      )}
      {auto && (
        <>
          <div className="sens-row">
            <span className="att-label">ЧУВСТВИТЕЛЬНОСТЬ ЗАСЕЧКИ</span>
            <input
              className="att-slider"
              type="range"
              min={0}
              max={100}
              step={1}
              value={s.scanSensitivity}
              onChange={(e) => s.setScanSensitivity(parseFloat(e.target.value))}
              aria-label="Чувствительность засечки"
            />
            <span className="att-value">{Math.round(s.scanThresholdDb)} дБ СНР</span>
          </div>
          <p className="sens-hint">низкая = все подряд · высокая = только сильные</p>
        </>
      )}
      <label className="check-row">
        <input
          type="checkbox"
          checked={s.sdrLoadOk}
          onChange={(e) => s.setSdrLoad(e.target.checked)}
        />
        Нагрузка 50 Ом на выходе усилителя SDR
      </label>
      <div className="power-row">
        <button className="btn-primary" onClick={() => s.addSdrBand()} disabled={busy}>
          ДОБАВИТЬ ПОЛОСУ
        </button>
        <button className="btn-ghost" onClick={() => s.clearSdrBands()} disabled={busy}>
          ОЧИСТИТЬ
        </button>
        {auto && (
          <button className="btn-ghost" onClick={() => s.injectDemoTone()}>
            ДЕМО-НЕСУЩАЯ
          </button>
        )}
        {fpgaAir || taskLive ? (
          s.fpgaArmed ? (
            <button className="btn-danger" disabled={s.fpgaBusy} onClick={() => void s.stopFpgaAir()}>
              СТОП FPGA
            </button>
          ) : fpgaAir && s.fpgaBusy ? (
            <button className="btn-danger" onClick={() => void s.stopFpgaAir()}>
              СТОП (отмена старта)
            </button>
          ) : (
            <button
              className="btn-primary"
              disabled={s.fpgaBusy || !fpgaAirSupported(s.sdrId)}
              onClick={() => void s.startScan()}
              title="Плата смотрит эфир сама и открывает TX. Ноутбук — рубильник."
            >
              СТАРТ ПЕРЕХВАТА
            </button>
          )
        ) : (
          <>
            {auto &&
              (s.scanRunning ? (
                <button className="btn-danger" onClick={() => s.stopScan()}>
                  СТОП СКАН
                </button>
              ) : (
                <button className="btn-primary" onClick={() => s.startScan()}>
                  СКАНИРОВАТЬ
                </button>
              ))}
            {s.transmitArmed ? (
              <button className="btn-danger" onClick={() => void s.stopTransmit()}>
                СТОП ПЕРЕДАЧУ
              </button>
            ) : (
              <button className="btn-primary" onClick={() => void s.startTransmit()}>
                ПЕРЕДАТЬ
              </button>
            )}
            <button
              className="btn-ghost"
              disabled={s.lastForwardMhz == null}
              onClick={() => void s.resetSdrLock()}
            >
              СБРОСИТЬ
            </button>
          </>
        )}
      </div>
      {fpgaAir && !taskLive && (
        <p className="sens-hint">
          Автоперехват: окно {fpgaWindowUs.toFixed(1)} µs · канал {tract.bwMhz} МГц · коридор{" "}
          {fpgaSpan > 0 ? fpgaSpan.toFixed(1) : "—"} / analog {analogBw} МГц
          {!fpgaAirSupported(s.sdrId)
            ? " — нужен bladeRF 2.0 micro xA4/xA9 или bladeRF 1 x40 на вкладке SDR"
            : " — плата шагает LO сама · USB не в круге увидел→усилитель · Стоп и watchdog гасят TX"}
        </p>
      )}
      {fpgaAir && s.fpgaLegion === false && (
        <p className="panel-warn">
          шлюз видит hosted, не legion (0x80 молчит) — ARM не взведётся. Вкладка КАСТОМ FPGA:
          СОБРАТЬ → ПРОШИТЬ; при следующем acquire шлюз сам перечитает ревизию.
        </p>
      )}
      <ul className="allow-list">
        {s.sdrBands.length === 0 && <li>полоса из F1…F2 при старте, либо добавьте вручную</li>}
        {s.sdrBands.map((b, i) => (
          <li key={`${b.f1Mhz}-${b.f2Mhz}-${i}`}>
            {b.f1Mhz} … {b.f2Mhz} МГц
          </li>
        ))}
      </ul>

      <SpectrumScope />
      <div className="range-labels">
        <span>{f1}</span>
        <span className="range-cur">
          {s.lastForwardMhz != null
            ? `${s.lastForwardMhz.toFixed(3)} МГц`
            : s.scanCenterMhz != null
              ? `${s.scanCenterMhz.toFixed(3)} МГц`
              : "—"}
          {airLive
            ? " · ретрансляция в FPGA · ноутбук наблюдает"
            : taskLive
              ? " · FPGA-задача · не перехват"
              : fpgaAir
                ? " · автоперехват выбран"
            : s.transmitArmed
              ? auto
                ? " · авто TX"
                : " · TX с ноутбука"
              : auto && s.scanRunning
                ? " · слушает"
                : ""}
        </span>
        <span>{f2}</span>
      </div>
      <p className="status-line">
        {airLive
          ? fpgaObserveLine(s.fpgaStatus) || s.lastCueReason
          : taskLive
            ? s.lastCueReason || "FPGA-задача с вкладки ТИП СИГНАЛА — не автоперехват"
            : fpgaAir
              ? s.lastCueReason ||
                (!fpgaAirSupported(s.sdrId)
                  ? "Автоперехват: выберите bladeRF 2.0 micro xA4/xA9 или bladeRF 1 x40 на вкладке SDR"
                  : "Автоперехват: СТАРТ — сканер ищет сигнал, FPGA ретранслирует, ноутбук наблюдает")
              : s.lastCueReason || "режим и ПЕРЕДАТЬ — решение оператора"}
      </p>
      {airLive && s.fpgaStatus && (
        <div className="sdr-facts">
          <div>
            {s.fpgaStatus.ok
              ? `наблюдение · детектор: ${s.fpgaStatus.det_active ? "энергия" : "тишина"} · окон с энергией: ${s.fpgaStatus.det_count ?? 0} · сторож: ${s.fpgaStatus.wd_fired ? "СРАБОТАЛ" : "жив"} · буфер FPGA: ${s.fpgaStatus.lb_level ?? 0}`
              : `наблюдение недоступно: ${s.fpgaStatus.reason ?? "?"}`}
          </div>
        </div>
      )}
      {auto && (
        <table className="det-table">
          <thead>
            <tr>
              <th>МГц</th>
              <th>дБм</th>
              <th>СНР</th>
              <th>СТАТУС</th>
            </tr>
          </thead>
          <tbody>
            {s.detections.length === 0 && (
              <tr>
                <td colSpan={4}>нет засечек — СКАНИРОВАТЬ, затем ПЕРЕДАТЬ</td>
              </tr>
            )}
            {s.detections
              .slice()
              .sort((a, b) => b.ts - a.ts)
              .slice(0, 10)
              .map((d, i) => (
                <tr
                  key={`${d.ts}-${d.freqMhz}-${i}`}
                  className={d.forwarded ? "det-row-fwd" : "det-row-hit"}
                >
                  <td>{d.freqMhz.toFixed(3)}</td>
                  <td>{d.powerDbm.toFixed(1)}</td>
                  <td>{d.snrDb.toFixed(1)}</td>
                  <td>{d.forwarded ? "НА TX SDR" : "ПЕРЕХВАЧЕНА"}</td>
                </tr>
              ))}
          </tbody>
        </table>
      )}
      <LabJournalPanel />
    </section>
  );
}
