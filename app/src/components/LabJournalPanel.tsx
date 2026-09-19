// LEGION — журнал стенда: полка 120 с, события, iperf/BPER/JSR, playlist.
// Не стартует ARM. Не подменяет гейт. STA/SMA в export — FAIL-closed.
import { useEffect, useState } from "react";

import { LAB_BASELINE_DEFAULT_SEC, baselineElapsedSec } from "../sense/labPsd";
import { useLegion } from "../state/store";

function downloadJournal(): void {
  const file = useLegion.getState().exportLabJournal();
  const blob = new Blob([JSON.stringify(file, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `legion-lab-xa4-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function LabJournalPanel() {
  const s = useLegion();
  const [iperfText, setIperfText] = useState("");
  const [playlistText, setPlaylistText] = useState(
    '{"name":"lab-xa4","steps":[{"name":"uhf","centerMhz":433,"lookMhz":2,"dwellMs":0.4,"wave":"awgn"},{"name":"c","centerMhz":5800,"lookMhz":10,"dwellMs":1,"wave":"tone"}]}',
  );
  const [bperOk, setBperOk] = useState("0");
  const [bperBad, setBperBad] = useState("0");
  const [jsr, setJsr] = useState("");
  const [eSig, setESig] = useState("");
  const [pJ, setPJ] = useState("");
  const [, setTick] = useState(0);
  const elapsed = baselineElapsedSec(s.labPsd, Date.now());
  const target = s.labPsd.baselineTargetSec || LAB_BASELINE_DEFAULT_SEC;
  const collecting = s.labPsd.baselineStartedMs != null && !s.labPsd.baselineFrozen;
  useEffect(() => {
    if (!collecting) return;
    const id = window.setInterval(() => setTick((n) => n + 1), 250);
    return () => window.clearInterval(id);
  }, [collecting]);

  return (
    <div className="lab-journal">
      <span className="panel-title">ЖУРНАЛ СТЕНДА · xA4 · не гейт FPGA</span>
      <p className="sens-hint">
        Полка {target} с как у bladerf-jamming-poc. Событие в лог после {s.labMinDurationSec} с (rtl-sdr-analyzer) —
        гейт платы не ждёт. iperf3 --json и BPER — ваш прогон, цифры не подставляются. STA/SMA FAIL-closed.
      </p>

      <div className="lab-progress" aria-label="Сбор полки">
        <div
          className="lab-progress-fill"
          style={{ width: `${Math.min(100, ((elapsed ?? 0) / target) * 100)}%` }}
        />
      </div>
      <p className="sens-hint">
        {s.labPsd.baselineStartedMs == null
          ? "полка не запущена"
          : s.labPsd.baselineFrozen
            ? `полка заморожена · ${(elapsed ?? 0).toFixed(1)} с`
            : `сбор полки ${(elapsed ?? 0).toFixed(1)} / ${target} с`}
      </p>
      <div className="power-row">
        <button type="button" className="btn-primary" onClick={() => s.startLabBaseline()} disabled={collecting}>
          ПОЛКА {target} с
        </button>
        <button type="button" className="btn-ghost" onClick={() => s.freezeLabBaseline()} disabled={s.labPsd.baselineStartedMs == null}>
          ЗАМОРОЗИТЬ
        </button>
        <button type="button" className="btn-ghost" onClick={() => s.clearLabPsd()}>
          ОЧИСТИТЬ PSD
        </button>
        <button type="button" className="btn-ghost" onClick={downloadJournal}>
          СКАЧАТЬ JSON
        </button>
      </div>

      <div className="corr-grid">
        <label>
          KNOWN МГц
          <input
            aria-label="Известные частоты"
            value={s.labKnown}
            onChange={(e) => s.setLabKnown(e.target.value)}
            placeholder="433 915 5800"
          />
        </label>
        <label>
          IGNORE МГц
          <input
            aria-label="Игнорировать частоты"
            value={s.labIgnore}
            onChange={(e) => s.setLabIgnore(e.target.value)}
            placeholder="не писать в журнал"
          />
        </label>
        <label>
          MIN ДЛИТ. с
          <input
            aria-label="Минимальная длительность события в журнале"
            type="number"
            min={0}
            step={0.05}
            value={s.labMinDurationSec}
            onChange={(e) => s.setLabMinDurationSec(parseFloat(e.target.value))}
          />
        </label>
        <label>
          MIN ШИРИНА МГц
          <input
            aria-label="Минимальная 3 дБ ширина для журнала"
            type="number"
            min={0}
            step={0.05}
            value={s.labMinWidthMhz}
            onChange={(e) => s.setLabMinWidthMhz(parseFloat(e.target.value))}
          />
        </label>
      </div>

      <table className="det-table">
        <thead>
          <tr>
            <th>ИСТОЧНИК</th>
            <th>МГц</th>
            <th>дБм</th>
            <th>СНР</th>
            <th>ШИРИНА</th>
            <th>с</th>
            <th>DUTY</th>
          </tr>
        </thead>
        <tbody>
          {s.labEvents.length === 0 && (
            <tr>
              <td colSpan={7}>нет событий ≥ {s.labMinDurationSec} с — короткий гейт FPGA сюда может не попасть</td>
            </tr>
          )}
          {s.labEvents
            .slice()
            .reverse()
            .slice(0, 16)
            .map((ev) => (
              <tr key={ev.id} className={ev.source === "fpga-gate" ? "det-row-fwd" : "det-row-hit"}>
                <td>{ev.source === "fpga-gate" ? "FPGA" : "Welch"}</td>
                <td>{ev.freqMhz.toFixed(3)}</td>
                <td>{ev.powerDbm == null ? "—" : ev.powerDbm.toFixed(1)}</td>
                <td>{ev.snrDb == null ? "—" : ev.snrDb.toFixed(1)}</td>
                <td>
                  {ev.widthMhz.toFixed(2)} {ev.widthKind === "look" ? "look" : "3дБ"}
                </td>
                <td>{ev.durationSec.toFixed(2)}</td>
                <td>{ev.duty.toFixed(2)}</td>
              </tr>
            ))}
        </tbody>
      </table>

      <label className="file-row">
        PLAYLIST JSON (CleverJAM-шаг: параметры, не ARM)
        <textarea
          aria-label="Playlist JSON"
          className="lab-textarea"
          rows={4}
          value={playlistText}
          onChange={(e) => setPlaylistText(e.target.value)}
        />
      </label>
      <div className="power-row">
        <button type="button" className="btn-primary" onClick={() => s.applyPlaylistJson(playlistText)}>
          ПРИМЕНИТЬ PLAYLIST
        </button>
        <button
          type="button"
          className="btn-ghost"
          disabled={!s.labPlaylist || s.labPlaylistIdx >= s.labPlaylist.steps.length - 1}
          onClick={() => s.applyPlaylistStep(s.labPlaylistIdx + 1)}
        >
          СЛЕДУЮЩИЙ ШАГ
        </button>
        {s.labPlaylist && (
          <span className="sens-hint">
            {s.labPlaylist.name} · {s.labPlaylistIdx + 1}/{s.labPlaylist.steps.length} · Старт сами
          </span>
        )}
      </div>

      <label className="file-row">
        iperf3 --json (lost_percent + bytes, как jamrf)
        <textarea
          aria-label="iperf3 JSON"
          className="lab-textarea"
          rows={3}
          value={iperfText}
          onChange={(e) => setIperfText(e.target.value)}
          placeholder='{"end":{"sum":{"lost_percent":0.75,"bytes":1250000}}}'
        />
      </label>
      <div className="power-row">
        <button type="button" className="btn-ghost" onClick={() => s.setLabIperfJson(iperfText)}>
          ЗАПИСАТЬ IPERF
        </button>
        <span className="sens-hint">
          {s.labIperf
            ? `lost ${s.labIperf.lostPercent} % · ${s.labIperf.bytes} байт`
            : "нет отчёта — не выдумываем 80 %"}
        </span>
      </div>

      <div className="corr-grid">
        <label>
          BPER OK
          <input aria-label="Батчи без ошибки" value={bperOk} onChange={(e) => setBperOk(e.target.value)} />
        </label>
        <label>
          BPER BAD
          <input aria-label="Плохие батчи" value={bperBad} onChange={(e) => setBperBad(e.target.value)} />
        </label>
        <label>
          JSR лин.
          <input aria-label="JSR линейный" value={jsr} onChange={(e) => setJsr(e.target.value)} placeholder="Pj/Esig" />
        </label>
        <label>
          Esig
          <input aria-label="Esig" value={eSig} onChange={(e) => setESig(e.target.value)} />
        </label>
        <label>
          Pj
          <input aria-label="Pj" value={pJ} onChange={(e) => setPJ(e.target.value)} />
        </label>
      </div>
      <div className="power-row">
        <button
          type="button"
          className="btn-ghost"
          onClick={() => s.setLabBper(parseFloat(bperOk), parseFloat(bperBad))}
        >
          ЗАПИСАТЬ BPER
        </button>
        <button
          type="button"
          className="btn-ghost"
          onClick={() =>
            s.setLabJsr({
              jsr: jsr === "" ? undefined : parseFloat(jsr),
              eSig: eSig === "" ? undefined : parseFloat(eSig),
              pJ: pJ === "" ? undefined : parseFloat(pJ),
            })
          }
        >
          ЗАПИСАТЬ JSR
        </button>
        <button type="button" className="btn-ghost" onClick={() => s.clearLabJournal()}>
          СБРОС ЖУРНАЛА
        </button>
        <span className="sens-hint">
          {s.labBper ? `BPER ${s.labBper.bper.toFixed(3)}` : "BPER —"}
          {s.labJsr ? ` · JSR ${s.labJsr.jsr} (${s.labJsr.jsrDb.toFixed(1)} дБ)` : " · JSR —"}
        </span>
      </div>
    </div>
  );
}
