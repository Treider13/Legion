// LEGION — режим SDR: антенна RX, усилитель на RF out. ESP32 не вызывается.
import {
  autoDispatchOptionRu,
  FPGA_AIR_MODE_RU,
  FPGA_AIR_MODE_RU_CAPS,
  FPGA_AIR_MODE_START_RU,
  FPGA_AIR_MODE_ACCEPT_RU,
  HOST_ATTACK_MODE_RU_CAPS,
  DIGITAL_MODE_RU_CAPS,
  isDigitalPattern,
  isFpgaAirLive,
  isFpgaAirPattern,
  isFpgaTaskLive,
  patternOptionRu,
  detectorListens,
  scannerParticipates,
  type AutoDispatch,
} from "../sense/modes";
import { airTractParams, fpgaAirSupported, fpgaObserveLine, parseLocaleNumber, parkSpanMhz } from "../sense/fpgaFastpath";
import type { ScanPattern } from "../sense/scan";
import { SMART_CORRIDOR_MHZ, SMART_JAM_MHZ, SMART_LOOK_EVERY_MS, SMART_LOOK_FOR_MS, SMART_SHIFT_HZ, rxFields, stopRx } from "../sense/rxTest";
import { catalogCaps } from "../sdr/hostClient";
import { parseSdrRxBand } from "../sdr/catalog";
import { WAVE_CATALOG, clampParams, waveMeta, type WaveKind } from "../sdr/waveforms";
import { waveFillsSoloWindow } from "../sense/fpgaSoloWalk";
import { ATTACK_SILENT_HINT, atlasForTracks } from "../sense/attackAtlas";
import type { AttackRow } from "../sense/attackScene";
import { lookRu } from "../sense/attackLook";
import { droneBandLabel, droneSurveyLine } from "../sense/droneBands";
import { RfClassCard } from "./RfClassCard";
import { ATTACK_LISTEN_ANALOG_MHZ } from "../sense/attackListen";
import {
  ATTACK_HOLD_MAX_MS,
  ATTACK_HOLD_MIN_MS,
  ATTACK_TX_MAX_MHZ,
  paintCenterMhz,
  paintRefuseReason,
  paintSpanMhz,
} from "../sense/attackPaint";
import { attackShelfHint, clipShelfToCorridor } from "../sense/attackShelfTx";
import { clampShelfMhz } from "../sense/txShelf";
import { TxGainControl } from "./TxGainControl";
import { useLegion } from "../state/store";
import { LabJournalPanel } from "./LabJournalPanel";
import { SpectrumScope } from "./SpectrumScope";
import { SmartAttackFields } from "./cinema/SmartAttackStrip";
import { DigitalFields } from "./cinema/DigitalStrip";

export function ScanPanel() {
  const s = useLegion();
  const f1 = s.sdrBands.length ? Math.min(...s.sdrBands.map((b) => b.f1Mhz)) : parseFloat(s.sdrF1) || 2400;
  const f2 = s.sdrBands.length ? Math.max(...s.sdrBands.map((b) => b.f2Mhz)) : parseFloat(s.sdrF2) || 2500;
  const holdSec = s.sdrHoldSince != null ? Math.floor((Date.now() - s.sdrHoldSince) / 1000) : 0;
  const fpgaAir = isFpgaAirPattern(s.scanPattern);
  const digital = isDigitalPattern(s.scanPattern);
  const airLive = isFpgaAirLive(s.fpgaArmed, s.fpgaMode);
  const taskLive = isFpgaTaskLive(s.fpgaArmed, s.fpgaMode);
  const listenLive = s.smartListenLive;
  const auto = scannerParticipates(s.scanPattern) && !taskLive && !airLive;
  const classLive = (detectorListens(s.scanPattern) || listenLive) && !taskLive && !airLive;
  const busy = s.scanRunning || s.transmitArmed || s.fpgaArmed || listenLive || s.digitalLive;
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
  const cssParams = s.txWaveKind === "css" ? clampParams("css", s.signalParams) : null;
  const shelfByGlance = fpgaAir && !taskLive;
  const shelfField = (
    <label
      className="shelf-mark"
      title="Ширина горба на анализаторе: часы и фильтр TX одним числом. Гауссов шум занимает полку целиком. QPSK и тон остаются узкими. Шаг только переносит центр. Умная атака и эфир копируют антенну — их ширину задаёт ВЗГЛЯД или канал, не это поле."
    >
      ПОЛКА МГц
      <input
        aria-label="Полка передачи, МГц"
        value={s.txShelfMhz}
        onChange={(e) => s.setTxShelfMhz(e.target.value)}
        disabled={busy && !s.transmitArmed}
      />
    </label>
  );

  if (digital && !taskLive) {
    return (
      <section className="panel" aria-label="Настройки цифрового режима">
        <span className="panel-title">{DIGITAL_MODE_RU_CAPS}</span>
        <p className="panel-note">
          Коридоры любые, каждый не шире 56 МГц. Ширина окна — из профиля подавления
          (по умолчанию 7 МГц). Плата скачет по снятым профилям и шлёт выбранный сигнал.
          Умная атака и обычная сюда не входят.
        </p>
        <DigitalFields />
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
              <option value="digital">{patternOptionRu("digital")}</option>
              <option value="sweep">{patternOptionRu("sweep")}</option>
              <option value="band">{patternOptionRu("band")}</option>
              <option value="hop">{patternOptionRu("hop")}</option>
            </select>
          </label>
        </div>
      </section>
    );
  }

  if (fpgaAir && !taskLive) {
    return (
      <section className="panel" aria-label="Настройки умной атаки">
        <span className="panel-title">УМНАЯ АТАКА</span>
        <p className="panel-note">
          Коридор любой, ширина всегда {SMART_CORRIDOR_MHZ} МГц. Принять находит скачок,
          DRFM со сдвигом бьёт {SMART_JAM_MHZ} МГц до Стоп. Антенна на RX1 / RX SMA, усилитель на TX1 / TX SMA.
        </p>
        <SmartAttackFields />
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
              <option value="digital">{patternOptionRu("digital")}</option>
              <option value="sweep">{patternOptionRu("sweep")}</option>
              <option value="band">{patternOptionRu("band")}</option>
              <option value="hop">{patternOptionRu("hop")}</option>
            </select>
          </label>
        </div>
      </section>
    );
  }

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
            ? `${FPGA_AIR_MODE_RU}: коридор любой, ширина всегда ${SMART_CORRIDOR_MHZ} МГц. Принять находит скачок, DRFM со сдвигом ${SMART_SHIFT_HZ} Гц бьёт ${SMART_JAM_MHZ} МГц до Стоп. TX молчит каждые ${SMART_LOOK_EVERY_MS} мс на ${SMART_LOOK_FOR_MS} мс. Антенна на RX1 / RX SMA, усилитель на TX1 / TX SMA. USB не в круге «увидел → усилитель».`
            : airLive
              ? `Автономный эфир: детектор в FPGA, ретрансляция RX→TX по энергии на стоянке или обходе коридора с ноутбука (tune). Это не ${FPGA_AIR_MODE_RU.toLowerCase()}. Стоп — кнопкой ниже.`
              : `${HOST_ATTACK_MODE_RU_CAPS}: без рамки слух до ${ATTACK_LISTEN_ANALOG_MHZ} МГц. Рамка мышкой — коридор (может быть шире ${ATTACK_TX_MAX_MHZ} МГц; одно окно USB FD ≤${ATTACK_TX_MAX_MHZ}). Полка — горб на найденном, тип волны — чем заливаем полку. Выдержка — на каждой засечке, сессию гасит только Стоп передачу. Пунктир — предложение, не рамка. Без рамки — авто-handoff живой засечки той же полкой. Хост-скан и FPGA вместе не работают (один USB).`}
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
                : `МГц · ${auto ? "energy" : classLive ? "слух классов" : "сканер выкл"}`}
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
            <option value="digital">{patternOptionRu("digital")}</option>
            <option value="sweep">{patternOptionRu("sweep")}</option>
            <option value="band">{patternOptionRu("band")}</option>
            <option value="hop">{patternOptionRu("hop")}</option>
          </select>
        </label>
        {fpgaAir && !taskLive && (
          <>
            <label title="Ширина коридора умной атаки. Всегда 56 МГц.">
              КОРИДОР, МГц
              <input aria-label="Ширина коридора умной атаки" value={String(SMART_CORRIDOR_MHZ)} readOnly />
            </label>
            <label title="Сдвиг DRFM. 15000 Гц.">
              СДВИГ DRFM, Гц
              <input
                aria-label="Сдвиг DRFM в герцах"
                inputMode="numeric"
                defaultValue={String(rxFields.shiftHz)}
                onChange={(e) => {
                  const n = parseFloat(e.target.value.replace(",", "."));
                  if (Number.isFinite(n) && n >= 0) rxFields.shiftHz = n;
                }}
                disabled={busy}
              />
            </label>
            <label title="Ширина удара по найденному скачку.">
              УДАР, МГц
              <input aria-label="Ширина удара" value={String(SMART_JAM_MHZ)} readOnly />
            </label>
            <label title="Как часто TX молчит, чтобы RX увидел энергию.">
              ВЗГЛЯД КАЖДЫЕ, мс
              <input
                aria-label="Пауза TX для взгляда, период"
                inputMode="decimal"
                defaultValue={String(rxFields.lookEveryMs)}
                onChange={(e) => {
                  const n = parseFloat(e.target.value.replace(",", "."));
                  if (Number.isFinite(n) && n > 0) rxFields.lookEveryMs = n;
                }}
                disabled={busy}
              />
            </label>
            <label title="Сколько миллисекунд TX молчит во время взгляда.">
              ВЗГЛЯД, мс
              <input
                aria-label="Длительность взгляда"
                inputMode="decimal"
                defaultValue={String(rxFields.lookForMs)}
                onChange={(e) => {
                  const n = parseFloat(e.target.value.replace(",", "."));
                  if (Number.isFinite(n) && n > 0) rxFields.lookForMs = n;
                }}
                disabled={busy}
              />
            </label>
          </>
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
        {!shelfByGlance && shelfField}
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
        {!fpgaAir && !taskLive && !auto && (
          <label title="Вшивается во все режимы передачи, кроме умной атаки. В эфир уходит по ПЕРЕДАТЬ.">
            ТИП ПОМЕХИ
            <select
              aria-label="Тип помехи"
              value={s.txWaveKind ?? ""}
              onChange={(e) => {
                const v = e.target.value;
                if (!v) s.disarmTxWave();
                else s.armTxWave(v as WaveKind);
              }}
              disabled={busy}
            >
              <option value="">CW тон</option>
              {WAVE_CATALOG.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.title}
                </option>
              ))}
            </select>
          </label>
        )}
        {auto && (
          <>
            <label title="Сколько миллисекунд держать полку на одной засечке, потом следующая в коридоре. Сессию не гасит.">
              TX РАМКИ мс
              <input
                aria-label="Выдержка полки на засечке Атаки"
                type="number"
                min={ATTACK_HOLD_MIN_MS}
                max={ATTACK_HOLD_MAX_MS}
                step={100}
                value={s.attackHoldMs}
                onChange={(e) => s.setAttackHoldMs(parseFloat(e.target.value))}
                disabled={s.transmitArmed}
              />
            </label>
            <label title="Тип baseband на полке засечки. CW — узкий тон в центре полки, не коридора.">
              ВОЛНА ПОЛКИ
              <select
                aria-label="Тип волны полки Атаки"
                value={s.txWaveKind ?? ""}
                onChange={(e) => {
                  const v = e.target.value;
                  if (!v) s.disarmTxWave();
                  else s.armTxWave(v as WaveKind);
                }}
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
        {s.txWaveKind === "css" &&
          waveMeta("css")
            .params.filter((p) => p.key === "sf" || p.key === "bwKhz")
            .map((p) => (
              <label
                key={p.key}
                title={
                  p.key === "sf"
                    ? "Spreading factor. ELRS 2.4 LoRa 250 Гц — SF6; 500 Гц LoRa — SF5 (common.cpp)"
                    : "Полоса LoRa. ELRS 2.4 — 812.5 кГц (SX1280 BW_0800). 500 кГц — SX127x 900"
                }
              >
                {p.label}
                {p.unit ? ` (${p.unit})` : ""}
                <input
                  aria-label={`CSS ${p.label}`}
                  type="number"
                  min={p.min}
                  max={p.max}
                  step={p.step}
                  value={cssParams?.[p.key] ?? p.def}
                  onChange={(e) => s.setSignalParam(p.key, parseFloat(e.target.value))}
                  disabled={s.transmitArmed}
                />
              </label>
            ))}
      </div>
      <p className="sens-hint">
        {taskLive
          ? `FPGA-задача с вкладки ТИП СИГНАЛА — не ${FPGA_AIR_MODE_RU.toLowerCase()} и не хост-скан`
          : fpgaAir
          ? `коридор ${SMART_CORRIDOR_MHZ} МГц, DRFM сдвиг ${SMART_SHIFT_HZ} Гц, удар ${SMART_JAM_MHZ} МГц, взгляд каждые ${SMART_LOOK_EVERY_MS} мс на ${SMART_LOOK_FOR_MS} мс, до Стоп`
          : auto
            ? s.attackPaint
              ? "Атака: рамка — где ищем. Полка и волна — что уходит на найденное. ПЕРЕДАТЬ жмёте вы."
              : s.autoDispatch === "priority"
              ? "рамки нет: без обвода ПЕРЕДАТЬ возьмёт живую засечку. Приоритет — сильнее рядом."
              : s.autoDispatch === "park"
                ? "рамки нет: стоянка в узком коридоре. Широкий линк обведите мышкой сами."
                : "рамки нет: очередь засечек. Широкий линк обведите мышкой сами."
            : `СКАНИРОВАТЬ — слух классов (аналог и цифра). ПЕРЕДАТЬ — TX до стопа, класс на тех же часах полки. Шаг двигает центр. Полка ${s.txShelfMhz} МГц — ширина горба${
                s.txWaveKind && waveFillsSoloWindow(s.txWaveKind)
                  ? ", шум займёт её целиком"
                  : ". Тон и QPSK уже полки — горб останется узким"
              }`}
      </p>
      {!fpgaAir && !taskLive && (
        <p className="sens-hint">
          TX-контент:{" "}
          {s.txWaveKind !== null
            ? `зашитая волна «${waveMeta(s.txWaveKind).title}» (вкладка ТИП СИГНАЛА / волна полки)`
            : "CW тон · сменить — волна полки выше или вкладка ТИП СИГНАЛА"}
        </p>
      )}
      {auto && (
        <p className="sens-hint">
          {s.attackPaint
            ? (() => {
                const analog = catalogCaps(s.sdrId).analogBwMhz;
                const shelf = clampShelfMhz(parseLocaleNumber(s.txShelfMhz), analog);
                const mid = paintCenterMhz(s.attackPaint);
                const clip = clipShelfToCorridor(mid, shelf, s.attackPaint, analog);
                const occ = clip?.occupyMhz ?? shelf;
                return `коридор ${s.attackPaint.f1Mhz.toFixed(2)}…${s.attackPaint.f2Mhz.toFixed(2)} МГц · ${paintSpanMhz(s.attackPaint).toFixed(2)} МГц · полка ${occ.toFixed(2)} МГц · ${attackShelfHint(s.txWaveKind, occ, s.attackPaint)}`;
              })()
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
      {classLive && (
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
      <TxGainControl />
      <p className="sens-hint">
        дБ тракта TX, не дБи антенны. На bladeRF 60 дБ ≈ 0 дБм на SMA. Авто — 40% диапазона, как раньше.
      </p>
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
        <button
          className="btn-ghost"
          onClick={() => s.applyDroneSurvey()}
          disabled={busy}
          title={droneSurveyLine(s.sdrId)}
        >
          ПОЛОСЫ ДРОНОВ
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
          ) : listenLive ? (
            <>
              <button className="btn-danger" onClick={() => { s.stopScan(); void stopRx(); }}>
                СТОП СЛУХ
              </button>
              <button
                className="btn-ghost"
                disabled={s.fpgaBusy || !fpgaAirSupported(s.sdrId)}
                onClick={() => void s.startLocalFpgaGateway()}
                title="Поднять legion_gateway на этом ПК (127.0.0.1:5531). Soapy отпустит USB."
              >
                ШЛЮЗ
              </button>
              <button
                className="btn-primary"
                disabled={s.fpgaBusy || !fpgaAirSupported(s.sdrId)}
                onClick={() => void s.acceptSmartGridAndArm()}
                title="Коридор 56 МГц. DRFM со сдвигом, удар 0,5 МГц до Стоп."
              >
                {FPGA_AIR_MODE_ACCEPT_RU}
              </button>
            </>
          ) : (
            <>
              <button
                className="btn-primary"
                disabled={s.fpgaBusy || !fpgaAirSupported(s.sdrId)}
                onClick={() => void s.startScan()}
                title="Коридор 56 МГц. Принять находит скачок и бьёт 0,5 МГц до Стоп."
              >
                {FPGA_AIR_MODE_START_RU}
              </button>
              <button
                className="btn-ghost"
                disabled={s.fpgaBusy || !fpgaAirSupported(s.sdrId)}
                onClick={() => void s.acceptSmartGridAndArm()}
                title="Коридор 56 МГц. DRFM со сдвигом, удар 0,5 МГц до Стоп."
              >
                {FPGA_AIR_MODE_ACCEPT_RU}
              </button>
            </>
          )
        ) : (
          <>
            {classLive && (auto || !s.transmitArmed) &&
              (s.scanRunning ? (
                <button className="btn-danger" onClick={() => { s.stopScan(); void stopRx(); }}>
                  СТОП СКАН
                </button>
              ) : (
                <button
                  className="btn-primary"
                  onClick={() => s.startScan()}
                  title={
                    auto
                      ? "Слух Атаки"
                      : "Слух классов на analog платы. Во время ПЕРЕДАТЬ — на часах полки, эту кнопку не крутим"
                  }
                >
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
          {FPGA_AIR_MODE_RU}: коридор {SMART_CORRIDOR_MHZ} МГц, удар {SMART_JAM_MHZ} МГц, до Стоп. Коридор{" "}
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
        {s.sdrBands.map((b, i) => {
          const tag = droneBandLabel(b);
          return (
            <li key={`${b.f1Mhz}-${b.f2Mhz}-${i}`}>
              {tag ? <span className="band-chip">{tag}</span> : null}
              {b.f1Mhz} … {b.f2Mhz} МГц
            </li>
          );
        })}
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
              : classLive && s.scanRunning
                ? " · слушает"
                : classLive && s.transmitArmed && !auto
                  ? " · слух на полке"
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
                  : `${FPGA_AIR_MODE_RU}: коридор 56 МГц, DRFM, удар 0,5 МГц до Стоп`)
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
      {(classLive || airLive) && (
        <RfClassCard
          rows={
            s.attackRows.length
              ? s.attackRows
              : atlasForTracks(s.attackTracks, analogBw).map(
                  (t): AttackRow => ({
                    ...t,
                    width3Mhz: t.widthMhz,
                    width26Mhz: t.widthMhz,
                    occ99Mhz: t.widthMhz,
                    look: undefined,
                    familyId: null,
                    infoRu: "",
                  }),
                )
          }
          pattern={s.scanPattern}
          fpga={airLive ? s.fpgaClass : null}
          persistOcc={s.fhssPersistOcc}
          persistListen={s.fhssPersistListen}
          persistLine={s.fhssPersistLine}
        />
      )}
      {(auto || listenLive) && (
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
                <th>ИНФОРМАЦИЯ</th>
                <th>РАЗБОР</th>
                <th>СЛЕД</th>
              </tr>
            </thead>
            <tbody>
              {s.attackTracks.length === 0 && (
                <tr>
                  <td colSpan={9}>{ATTACK_SILENT_HINT}</td>
                </tr>
              )}
              {(s.attackRows.length
                ? s.attackRows
                : atlasForTracks(s.attackTracks, analogBw).map(
                    (t): AttackRow => ({
                      ...t,
                      width3Mhz: t.widthMhz,
                      width26Mhz: t.widthMhz,
                      occ99Mhz: t.widthMhz,
                      look: undefined,
                      familyId: null,
                      infoRu: "",
                    }),
                  )
              )
                .slice()
                .sort((a, b) => b.powerDbm - a.powerDbm)
                .slice(0, 10)
                .map((t) => {
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
                    <td>{t.width3Mhz.toFixed(2)}</td>
                    <td>{t.width26Mhz.toFixed(2)}</td>
                    <td>{t.occ99Mhz.toFixed(2)}</td>
                    <td>{t.duty.toFixed(2)}</td>
                    <td className="attack-atlas">{t.atlas.label}</td>
                    <td className="attack-atlas">{t.infoRu || "—"}</td>
                    <td className="attack-atlas">{t.look ? lookRu(t.look) : t.atlas.hint}</td>
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
            <p className="attack-advice-title">Помощник</p>
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
            <p><strong>Отчёт сессии.</strong> {s.attackAdvice.after}</p>
          </div>
          <table className="det-table">
            <thead>
              <tr>
                <th>МГц</th>
                <th title="Относительный цифровой уровень; абсолютная мощность в дБм не подтверждена">дБ (отн.)</th>
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
