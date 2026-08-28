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
import { detectorWindowUs, fpgaAirSupported, fpgaObserveLine, parkSpanMhz } from "../sense/fpgaFastpath";
import type { ScanPattern } from "../sense/scan";
import { catalogCaps } from "../sdr/hostClient";
import { parseBand } from "../policy/allowlist";
import { waveMeta } from "../sdr/waveforms";
import { useLegion } from "../state/store";

export function ScanPanel() {
  const s = useLegion();
  const f1 = s.sdrBands.length ? Math.min(...s.sdrBands.map((b) => b.f1Mhz)) : parseFloat(s.sdrF1) || 2400;
  const f2 = s.sdrBands.length ? Math.max(...s.sdrBands.map((b) => b.f2Mhz)) : parseFloat(s.sdrF2) || 2500;
  const span = Math.max(f2 - f1, 1e-6);
  const holdSec = s.sdrHoldSince != null ? Math.floor((Date.now() - s.sdrHoldSince) / 1000) : 0;
  const fpgaAir = isFpgaAirPattern(s.scanPattern);
  const airLive = isFpgaAirLive(s.fpgaArmed, s.fpgaMode);
  const taskLive = isFpgaTaskLive(s.fpgaArmed, s.fpgaMode);
  const auto = scannerParticipates(s.scanPattern) && !taskLive && !airLive;
  const busy = s.scanRunning || s.transmitArmed || s.fpgaArmed;
  const analogBw = catalogCaps(s.sdrId).analogBwMhz;
  const fpgaBands = s.sdrBands.length
    ? s.sdrBands
    : (() => {
        const b = parseBand(s.sdrF1, s.sdrF2);
        return b ? [b] : [];
      })();
  const fpgaSpan = parkSpanMhz(fpgaBands);
  const fpgaWindowUs = detectorWindowUs(s.fpgaDetShift);

  return (
    <section className="panel">
      <span className="panel-title">
        {taskLive
          ? "РЕЖИМ SDR // FPGA · ЗАДАЧА С НОУТБУКА"
          : fpgaAir || airLive
            ? "РЕЖИМ SDR // FPGA+СКАНЕР · КОНВЕЙЕР НА SDR"
            : "РЕЖИМ SDR // АВТО-СКАНЕР ИЛИ TX С НОУТБУКА"}
      </span>
      <p className="panel-note">
        {taskLive
          ? "Идёт FPGA-задача с вкладки ТИП СИГНАЛА (PLAYER/NCO/LOOPBACK). Это не конвейер I²+Q² и не хост-скан. Стоп — там или кнопкой ниже."
          : fpgaAir
            ? "Сканер (Welch-8, 40 MSPS) находит пик → LO паркуется на него (2 MSPS) → порог от шумовой полки → FPGA ретранслирует RX→TX за микросекунды. Энергия пропала, watchdog или СТОП — возврат к скану. ПЕРЕДАТЬ не нужен: цикл автономный."
            : "АВТО + ПЕРЕДАТЬ — хост-скан (Welch-8 на ноутбуке), задержка миллисекунды. Микросекунды: режим FPGA+СКАНЕР. Хост-скан и FPGA вместе не работают (один USB)."}
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
                ? "не конвейер"
                : `МГц · ${auto ? "energy" : "сканер выкл"}`}
          </span>
        </div>
        <div className={`freq-hud-card tx ${airLive ? (s.fpgaStatus?.det_active ? "live" : "") : s.lastForwardMhz != null ? "live" : ""}`}>
          <span className="freq-hud-k">{airLive ? "КОНВЕЙЕР SDR" : taskLive ? "SDR ИГРАЕТ" : "НА TX SDR"}</span>
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
            <label>
              ПОРОГ DET
              <input
                aria-label="Порог детектора FPGA"
                type="number"
                min={1}
                step={100}
                value={s.fpgaDetThr}
                onChange={(e) => s.setFpgaDetThr(parseFloat(e.target.value))}
                disabled={busy || s.fpgaBusy}
              />
            </label>
            <label>
              ОКНО SHIFT
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
          </>
        )}
        {auto && (
          <label>
            АВТО
            <select
              aria-label="Приоритет или очередь АВТО"
              value={s.autoDispatch}
              onChange={(e) => s.setAutoDispatch(e.target.value as AutoDispatch)}
              disabled={busy}
            >
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
          ? "FPGA-задача с вкладки ТИП СИГНАЛА — не конвейер I²+Q² и не хост-скан"
          : fpgaAir
          ? `конвейер на SDR, окно ${fpgaWindowUs.toFixed(1)} µs. Ноутбук не считает FFT и не ставит TX — только наблюдает`
          : auto
            ? s.autoDispatch === "priority"
              ? "приоритет: сильнее рядом — сразу на неё; слабее не сбивает; пропала — следующая"
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
            // Handoff в полёте (парк/захват/USB/ARM — на micro до секунд на
            // первом подъёме): отмена по поколению, handoff откатится сам.
            <button className="btn-danger" onClick={() => void s.stopFpgaAir()}>
              СТОП (отмена handoff)
            </button>
          ) : s.scanRunning && fpgaAir ? (
            <button className="btn-danger" onClick={() => s.stopScan()}>
              СТОП СКАН
            </button>
          ) : (
            <button
              className="btn-primary"
              disabled={s.fpgaBusy || !fpgaAirSupported(s.sdrId)}
              onClick={() => void s.startScan()}
            >
              СТАРТ FPGA+СКАНЕР
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
          FPGA+сканер: окно {fpgaWindowUs.toFixed(1)} µs · полоса{" "}
          {fpgaSpan > 0 ? fpgaSpan.toFixed(1) : "—"} / analog {analogBw} МГц
          {!fpgaAirSupported(s.sdrId)
            ? " — нужен bladeRF 2.0 micro xA4/xA9 или bladeRF 1 x40 на вкладке SDR"
            : " — скан → парковка пика → ARM lb_gated · пропала энергия/watchdog → возврат к скану"}
        </p>
      )}
      {fpgaAir && s.fpgaLegion === false && (
        <p className="panel-warn">
          шлюз видит hosted, не legion (0x80 молчит) — ARM не взведётся. Вкладка КАСТОМ FPGA:
          СОБРАТЬ → ПРОШИТЬ, затем рестарт шлюза.
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

      <div className="spectrum-wrap" aria-label="Спектр скана">
        {auto && s.scanBins.length > 0 ? (
          <svg className="spectrum-svg" viewBox="0 0 640 88" preserveAspectRatio="none" role="img">
            {s.scanBins
              .filter((b) => b.freqMhz >= f1 && b.freqMhz <= f2)
              .map((b, i) => {
                // Позиция по РЕАЛЬНОЙ частоте бина: раньше x брался по индексу —
                // содержимое окна растягивалось на всю полосу (аудит N2).
                const x = ((b.freqMhz - f1) / span) * 640;
                const n = 88;
                const h = Math.min(n, Math.max(2, ((b.powerDbm + 100) / 70) * n));
                const hit = s.detections.some((d) => Math.abs(d.freqMhz - b.freqMhz) < 0.3);
                const tx =
                  s.lastForwardMhz != null && Math.abs(b.freqMhz - s.lastForwardMhz) < 0.3;
                return (
                  <rect
                    key={`${b.freqMhz}-${i}`}
                    x={x}
                    y={88 - h}
                    width={Math.max(640 / s.scanBins.length - 0.4, 1)}
                    height={h}
                    fill={tx ? "#ff6b73" : hit ? "#5eead4" : "rgba(45,212,191,0.28)"}
                  />
                );
              })}
          </svg>
        ) : (
          <div className="spectrum-strip">
            <div className="spectrum-fill" />
          </div>
        )}
        {s.scanCenterMhz !== null && auto && (
          <div
            className="spectrum-center"
            style={{ left: `${Math.min(100, Math.max(0, ((s.scanCenterMhz - f1) / span) * 100))}%` }}
          />
        )}
      </div>
      <div className="range-labels">
        <span>{f1}</span>
        <span className="range-cur">
          {s.lastForwardMhz != null
            ? `${s.lastForwardMhz.toFixed(3)} МГц`
            : s.scanCenterMhz != null
              ? `${s.scanCenterMhz.toFixed(3)} МГц`
              : "—"}
          {airLive
            ? " · FPGA конвейер · ноутбук наблюдает"
            : taskLive
              ? " · FPGA-задача · не конвейер"
              : fpgaAir
                ? " · FPGA+сканер выбран"
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
            ? s.lastCueReason || "FPGA-задача с вкладки ТИП СИГНАЛА — не конвейер сканера"
            : fpgaAir
              ? s.lastCueReason ||
                (!fpgaAirSupported(s.sdrId)
                  ? "FPGA+сканер: выберите bladeRF 2.0 micro xA4/xA9 или bladeRF 1 x40 на вкладке SDR"
                  : "FPGA+сканер: СТАРТ — сканер ищет пик, FPGA ретранслирует, ноутбук наблюдает")
              : s.lastCueReason || "режим и ПЕРЕДАТЬ — решение оператора"}
      </p>
      {airLive && s.fpgaStatus && (
        <div className="sdr-facts">
          <div>
            {s.fpgaStatus.ok
              ? `наблюдение · det=${s.fpgaStatus.det_active ? "энергия" : "тишина"} · окон с энергией=${s.fpgaStatus.det_count ?? 0} · watchdog=${s.fpgaStatus.wd_fired ? "СРАБОТАЛ" : "жив"} · lb_fifo=${s.fpgaStatus.lb_level ?? 0}`
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
    </section>
  );
}
