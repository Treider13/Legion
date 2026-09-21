// LEGION — режим SDR: антенна RX, усилитель на RF out. ESP32 не вызывается.
import {
  autoDispatchOptionRu,
  FPGA_AIR_MODE_RU,
  FPGA_AIR_MODE_RU_CAPS,
  FPGA_AI_OPTION_RU,
  FPGA_AIR_MODE_START_RU,
  HOST_ATTACK_MODE_RU_CAPS,
  fpgaInnerDispatch,
  isFpgaAirLive,
  isFpgaAirPattern,
  isFpgaTaskLive,
  patternOptionRu,
  scannerParticipates,
  type AutoDispatch,
} from "../sense/modes";
import { airTractParams, fpgaAirSupported, fpgaObserveLine, fpgaSurveyPeriodClamp, fpgaTurnDwellClamp, parseLocaleNumber, parkSpanMhz } from "../sense/fpgaFastpath";
import type { ScanPattern } from "../sense/scan";
import { catalogCaps } from "../sdr/hostClient";
import { parseSdrRxBand } from "../sdr/catalog";
import { WAVE_CATALOG, waveMeta, type WaveKind } from "../sdr/waveforms";
import { ATTACK_SILENT_HINT, atlasForTracks } from "../sense/attackAtlas";
import { lookRu } from "../sense/attackLook";
import { ATTACK_LISTEN_ANALOG_MHZ } from "../sense/attackListen";
import {
  ATTACK_HOLD_MAX_MS,
  ATTACK_HOLD_MIN_MS,
  ATTACK_TX_MAX_MHZ,
  paintCenterMhz,
  paintRefuseReason,
  paintSpanMhz,
  paintWaveHint,
} from "../sense/attackPaint";
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
            ? `РЕЖИМ SDR // ${FPGA_AIR_MODE_RU_CAPS} · РЕТРАНСЛЯЦИЯ В FPGA`
            : airLive
              ? "РЕЖИМ SDR // FPGA · АВТОНОМНЫЙ ЭФИР (БЕЗ СКАНЕРА)"
              : `РЕЖИМ SDR // ${HOST_ATTACK_MODE_RU_CAPS} ИЛИ TX С НОУТБУКА`}
      </span>
      <p className="panel-note">
        {taskLive
          ? `Идёт FPGA-задача с вкладки ТИП СИГНАЛА (генерация/постоянная ретрансляция). Это не ${FPGA_AIR_MODE_RU.toLowerCase()} и не хост-скан. Стоп — там или кнопкой ниже.`
          : fpgaAir
            ? `${FPGA_AIR_MODE_RU}: после Старта хозяин — SDR. Антенна на RX1 / RX SMA, усилитель на TX1 / TX SMA. ИИ: глухой обзор коридора, окно на всплеск, внутри — обычный или приоритет с выдержкой, затем снова обзор. Гейт в текущем взгляде — микросекунды. USB не в круге «увидел → усилитель». Ноутбук — коридор, два времени, Старт/Стоп и наблюдение. Порог — поле ниже (не полка USB-IQ).`
            : airLive
              ? `Автономный эфир: детектор в FPGA, ретрансляция RX→TX по энергии на стоянке или обходе коридора с ноутбука (tune). Это не ${FPGA_AIR_MODE_RU.toLowerCase()}. Стоп — кнопкой ниже.`
              : `${HOST_ATTACK_MODE_RU_CAPS}: слух до ${ATTACK_LISTEN_ANALOG_MHZ} МГц. Мозг помнит IQ на плате и hop-вспышки сессии, пишет разбор и подсказки по-русски. Рамка мышкой до ${ATTACK_TX_MAX_MHZ} МГц, тип волны и выдержка — кнопка «взять» ставит только то, что вы нажали; в эфир само не уходит. ПЕРЕДАТЬ заливает нарисованное. Пунктир на спектре — предложение, не рамка. Без рамки — прежний авто-handoff. Хост-скан и FPGA вместе не работают (один USB).`}
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
            <label title="Сколько миллисекунд держать усилитель на найденном сигнале внутри окна. Обычный и приоритет.">
              ВЫДЕРЖКА НА СИГНАЛ мс
              <input
                aria-label="Выдержка на сигнал внутри окна"
                type="number"
                min={0.1}
                max={60000}
                step={0.1}
                value={s.fpgaTurnDwellMs}
                onChange={(e) => s.setFpgaTurnDwellMs(e.target.value)}
                disabled={busy || s.fpgaBusy}
              />
            </label>
            <label title="Через сколько миллисекунд снова пройти глухой обзор всего коридора.">
              СКАНИРОВАНИЕ мс
              <input
                aria-label="Период сканирования коридора"
                type="number"
                min={0.1}
                max={60000}
                step={0.1}
                value={s.fpgaSurveyPeriodMs}
                onChange={(e) => s.setFpgaSurveyPeriodMs(e.target.value)}
                disabled={busy || s.fpgaBusy}
              />
            </label>
          </>
        )}
        {interceptSetup && (
          <label>
            В ОКНЕ
            <select
              aria-label="Обычный или приоритет внутри окна"
              value={fpgaInnerDispatch(s.autoDispatch)}
              onChange={(e) => s.setAutoDispatch(e.target.value as AutoDispatch)}
              disabled={busy}
            >
              <option value="turn">{autoDispatchOptionRu("turn")}</option>
              <option value="priority">{autoDispatchOptionRu("priority")}</option>
            </select>
          </label>
        )}
        {auto && (
          <label>
            {HOST_ATTACK_MODE_RU_CAPS}
            <select
              aria-label={`Приоритет или очередь ${HOST_ATTACK_MODE_RU_CAPS}`}
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
        {auto && (
          <>
            <label title="Сколько миллисекунд держать усилитель в нарисованной рамке после ПЕРЕДАТЬ.">
              TX РАМКИ мс
              <input
                aria-label="Выдержка передачи в рамке Атаки"
                type="number"
                min={ATTACK_HOLD_MIN_MS}
                max={ATTACK_HOLD_MAX_MS}
                step={100}
                value={s.attackHoldMs}
                onChange={(e) => s.setAttackHoldMs(parseFloat(e.target.value))}
                disabled={s.transmitArmed}
              />
            </label>
            <label title="Тип baseband, которым заливаем рамку. CW — узкий тон в центре.">
              ВОЛНА РАМКИ
              <select
                aria-label="Тип волны для рамки Атаки"
                value={s.txWaveKind ?? ""}
                onChange={(e) => {
                  const v = e.target.value;
                  if (!v) s.disarmTxWave();
                  else s.armTxWave(v as WaveKind);
                }}
                disabled={s.transmitArmed}
              >
                <option value="">CW тон</option>
                {WAVE_CATALOG.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.title}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
      </div>
      <p className="sens-hint">
        {taskLive
          ? `FPGA-задача с вкладки ТИП СИГНАЛА — не ${FPGA_AIR_MODE_RU.toLowerCase()} и не хост-скан`
          : fpgaAir
          ? `ретрансляция в FPGA, окно ${fpgaWindowUs.toFixed(1)} µs. Ноутбук не считает спектр и не ставит TX — только наблюдает. ${FPGA_AI_OPTION_RU}. ${
              fpgaInnerDispatch(s.autoDispatch) === "turn"
                ? `Обычный: выдержка ${fpgaTurnDwellClamp(parseLocaleNumber(s.fpgaTurnDwellMs))} мс на сигнал, сканирование каждые ${fpgaSurveyPeriodClamp(parseLocaleNumber(s.fpgaSurveyPeriodMs))} мс`
                : `Приоритет: сильнее — перескок и новая выдержка ${fpgaTurnDwellClamp(parseLocaleNumber(s.fpgaTurnDwellMs))} мс, сканирование каждые ${fpgaSurveyPeriodClamp(parseLocaleNumber(s.fpgaSurveyPeriodMs))} мс`
            }`
          : auto
            ? s.attackPaint
              ? "Атака: рамка ваша. Подсказки ниже — совет, не кнопка. ПЕРЕДАТЬ жмёте вы."
              : s.autoDispatch === "priority"
              ? "рамки нет: без обвода ПЕРЕДАТЬ возьмёт живую засечку. Приоритет — сильнее рядом."
              : s.autoDispatch === "park"
                ? "рамки нет: стоянка в узком коридоре. Широкий линк обведите мышкой сами."
                : "рамки нет: очередь засечек. Широкий линк обведите мышкой сами."
            : "без сканера: ноутбук по Ethernet ставит TX LO до стопа (качание / сплошная / случайная)"}
      </p>
      {!fpgaAir && !taskLive && (
        <p className="sens-hint">
          TX-контент:{" "}
          {s.txWaveKind !== null
            ? `зашитая волна «${waveMeta(s.txWaveKind).title}» (вкладка ТИП СИГНАЛА / волна рамки)`
            : "CW тон · сменить — волна рамки выше или вкладка ТИП СИГНАЛА"}
        </p>
      )}
      {auto && (
        <p className="sens-hint">
          {s.attackPaint
            ? `рамка ${s.attackPaint.f1Mhz.toFixed(2)}…${s.attackPaint.f2Mhz.toFixed(2)} МГц · центр ${paintCenterMhz(s.attackPaint).toFixed(3)} · ${paintSpanMhz(s.attackPaint).toFixed(2)} МГц · ${paintWaveHint(s.txWaveKind, s.attackPaint, s.txWaveParams)}`
            : "рамки нет — выделите полосу мышкой на спектре, иначе ПЕРЕДАТЬ возьмёт живую засечку как раньше"}
          {s.attackTxUntil != null && s.transmitArmed
            ? ` · TX ещё ${Math.max(0, s.attackTxUntil - Date.now())} мс`
            : ""}
          {s.attackPaint
            ? (() => {
                const refuse = paintRefuseReason(s.attackPaint, s.sdrBands, s.sdrLoadOk);
                return refuse && !s.transmitArmed ? ` · ${refuse}` : "";
              })()
            : ""}
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
              {FPGA_AIR_MODE_START_RU}
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
          {FPGA_AIR_MODE_RU}: окно {fpgaWindowUs.toFixed(1)} µs · канал {tract.bwMhz} МГц · коридор{" "}
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
              ? " · FPGA-задача · не умная атака"
              : fpgaAir
                ? ` · ${FPGA_AIR_MODE_RU.toLowerCase()} выбрана`
            : s.transmitArmed
              ? auto
                ? s.attackPaint
                  ? " · атака рамка"
                  : " · авто TX"
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
            ? s.lastCueReason || `FPGA-задача с вкладки ТИП СИГНАЛА — не ${FPGA_AIR_MODE_RU.toLowerCase()}`
            : fpgaAir
              ? s.lastCueReason ||
                (!fpgaAirSupported(s.sdrId)
                  ? `${FPGA_AIR_MODE_RU}: выберите bladeRF 2.0 micro xA4/xA9 или bladeRF 1 x40 на вкладке SDR`
                  : `${FPGA_AIR_MODE_RU}: СТАРТ — плата ищет всплеск и ставит окно, ноутбук наблюдает`)
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
        <>
          <table className="det-table">
            <thead>
              <tr>
                <th>МГц</th>
                <th title="ширина по уровню −3 дБ от пика">−3 дБ</th>
                <th title="ширина по уровню −26 дБ, как в ITU SM.443">−26 дБ</th>
                <th title="полоса, где сидит 99% энергии">99%</th>
                <th title="какая доля кадров след был жив">доля</th>
                <th>СЕМЬЯ</th>
                <th>РАЗБОР</th>
                <th>СЛЕД</th>
              </tr>
            </thead>
            <tbody>
              {s.attackTracks.length === 0 && (
                <tr>
                  <td colSpan={8}>{ATTACK_SILENT_HINT}</td>
                </tr>
              )}
              {(s.attackRows.length ? s.attackRows : atlasForTracks(s.attackTracks, analogBw))
                .slice()
                .sort((a, b) => b.powerDbm - a.powerDbm)
                .slice(0, 10)
                .map((t) => {
                  const row = "look" in t ? t : null;
                  return (
                  <tr
                    key={t.id}
                    className={
                      t.state === "held"
                        ? "det-row-held"
                        : t.state === "confirmed"
                          ? "det-row-confirmed"
                          : t.state === "cooled"
                            ? "det-row-new"
                            : "det-row-new"
                    }
                    title={t.atlas.hint}
                  >
                    <td>{t.freqMhz.toFixed(3)}</td>
                    <td>{row ? row.width3Mhz.toFixed(2) : t.widthMhz.toFixed(2)}</td>
                    <td>{row ? row.width26Mhz.toFixed(2) : "—"}</td>
                    <td>{row ? row.occ99Mhz.toFixed(2) : "—"}</td>
                    <td>{t.duty.toFixed(2)}</td>
                    <td className="attack-atlas">{t.atlas.label}</td>
                    <td className="attack-atlas">{row?.look ? lookRu(row.look) : t.atlas.hint}</td>
                    <td>
                      {t.state === "held"
                        ? "ДЕРЖИМ"
                        : t.state === "confirmed"
                          ? "ПОДТВЕРЖДЁН"
                          : t.state === "cooled"
                            ? "ОСТЫЛ"
                            : "НОВЫЙ"}
                    </td>
                  </tr>
                  );
                })}
            </tbody>
          </table>
          <div className="attack-advice">
            <p className="attack-advice-title">Что видит Атака</p>
            <p>{s.attackAdvice.scene || "Сцена ещё копится — нужен живой взгляд."}</p>
            <p className="sens-hint">{s.attackMemoryLine || "Память сессии пуста, пока не было вспышек."}</p>
            {s.attackAdvice.hints.map((h) => (
              <div key={h.kind} className="attack-hint">
                <strong>{h.title}.</strong> {h.text}
                <span className="sens-hint"> {h.why}</span>
                {h.applyLabel && (
                  <button
                    type="button"
                    className="btn-mini"
                    disabled={s.transmitArmed}
                    onClick={() => s.applyAttackHint(h.kind)}
                  >
                    {h.applyLabel}
                  </button>
                )}
              </div>
            ))}
            <p><strong>После передачи.</strong> {s.attackAdvice.after}</p>
          </div>
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
        </>
      )}
      <LabJournalPanel />
    </section>
  );
}
