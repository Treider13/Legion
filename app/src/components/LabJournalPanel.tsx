// LEGION — журнал стенда: полка 120 с, события, iperf/BPER/JSR, playlist.
// Плейлист — поля и кнопки (CleverJAM-шаг: параметры, не ARM). JSON только
// как импорт файла. Не стартует ARM. STA/SMA в export — FAIL-closed.
import { useEffect, useRef, useState } from "react";

import { LAB_PLAYLIST_PRESETS, playlistStepFromScanner, type LabPlaylistStep } from "../sense/labJournal";
import { LAB_BASELINE_DEFAULT_SEC, baselineElapsedSec } from "../sense/labPsd";
import { WAVE_CATALOG, type WaveKind } from "../sdr/waveforms";
import { useLegion } from "../state/store";

type DraftStep = {
  key: string;
  name: string;
  center: string;
  look: string;
  dwell: string;
  wave: string;
};

let draftSeq = 0;
function nextKey(): string {
  draftSeq += 1;
  return `step-${draftSeq}`;
}

function draftFromStep(step: LabPlaylistStep): DraftStep {
  return {
    key: nextKey(),
    name: step.name,
    center: String(step.centerMhz),
    look: String(step.lookMhz),
    dwell: String(step.dwellMs),
    wave: step.wave ?? "",
  };
}

function draftsToSteps(drafts: readonly DraftStep[]): LabPlaylistStep[] {
  return drafts.map((d, i) => ({
    name: d.name.trim() || `step-${i + 1}`,
    centerMhz: Number(d.center.replace(",", ".")),
    lookMhz: Number(d.look.replace(",", ".")),
    dwellMs: Number(d.dwell.replace(",", ".")),
    wave: (d.wave || null) as WaveKind | null,
  }));
}

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
  const playlistFileRef = useRef<HTMLInputElement>(null);
  const iperfFileRef = useRef<HTMLInputElement>(null);
  const [plName, setPlName] = useState("стенд");
  const [drafts, setDrafts] = useState<DraftStep[]>([]);
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

  const patchDraft = (key: string, part: Partial<DraftStep>) => {
    setDrafts((rows) => rows.map((row) => (row.key === key ? { ...row, ...part } : row)));
  };

  const moveDraft = (index: number, dir: -1 | 1) => {
    setDrafts((rows) => {
      const j = index + dir;
      if (j < 0 || j >= rows.length) return rows;
      const next = rows.slice();
      const tmp = next[index];
      next[index] = next[j];
      next[j] = tmp;
      return next;
    });
  };

  const applyDrafts = (): boolean => s.applyPlaylist({ name: plName, steps: draftsToSteps(drafts) });

  const readPickedFile = (file: File | undefined, onText: (text: string) => void) => {
    if (!file) return;
    void file.text().then(onText);
  };

  return (
    <div className="lab-journal">
      <span className="panel-title">ЖУРНАЛ СТЕНДА · xA4 · не гейт FPGA</span>
      <p className="sens-hint">
        Полка {target} с как у bladerf-jamming-poc. Событие в лог после {s.labMinDurationSec} с (rtl-sdr-analyzer) —
        гейт платы не ждёт. Шаги плейлиста — поля, не скобки. iperf3 — прогон CLI или файл с другого ПК. STA/SMA
        FAIL-closed.
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
          СКАЧАТЬ ЖУРНАЛ
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

      <span className="panel-title">ШАГИ СТЕНДА · поля, не JSON</span>
      <p className="sens-hint">
        Выставляет коридор, взгляд и волну. Старт / ARM сами. 433 / 2442 / 5800 — те же частоты, что уже были в
        журнале и демо-несущей.
      </p>
      <div className="corr-grid">
        <label>
          ИМЯ НАБОРА
          <input aria-label="Имя набора шагов" value={plName} onChange={(e) => setPlName(e.target.value)} />
        </label>
      </div>
      <div className="power-row">
        {LAB_PLAYLIST_PRESETS.map((pre) => (
          <button
            key={pre.name}
            type="button"
            className="btn-ghost"
            onClick={() => setDrafts((rows) => [...rows, draftFromStep(pre)])}
          >
            + {pre.name} {pre.centerMhz}
          </button>
        ))}
        <button
          type="button"
          className="btn-ghost"
          onClick={() => setDrafts((rows) => [...rows, draftFromStep(playlistStepFromScanner(useLegion.getState()))])}
        >
          КАК СЕЙЧАС НА СКАНЕРЕ
        </button>
        <button
          type="button"
          className="btn-ghost"
          onClick={() =>
            setDrafts((rows) => [
              ...rows,
              { key: nextKey(), name: `шаг ${rows.length + 1}`, center: "", look: "2", dwell: "1", wave: "" },
            ])
          }
        >
          + ШАГ
        </button>
      </div>

      {drafts.length === 0 && <p className="sens-hint">нет шагов — нажмите UHF / 2.4 / 5.8 или «как на сканере»</p>}

      {drafts.map((d, i) => (
        <div key={d.key} className="lab-step">
          <div className="lab-step-head">
            <span>
              ШАГ {i + 1}
              {s.labPlaylist && s.labPlaylistIdx === i ? " · сейчас" : ""}
            </span>
            <span className="lab-step-tools">
              <button type="button" className="btn-ghost" aria-label="Шаг вверх" disabled={i === 0} onClick={() => moveDraft(i, -1)}>
                ↑
              </button>
              <button
                type="button"
                className="btn-ghost"
                aria-label="Шаг вниз"
                disabled={i === drafts.length - 1}
                onClick={() => moveDraft(i, 1)}
              >
                ↓
              </button>
              <button
                type="button"
                className="btn-ghost"
                aria-label="Удалить шаг"
                onClick={() => setDrafts((rows) => rows.filter((row) => row.key !== d.key))}
              >
                ✕
              </button>
            </span>
          </div>
          <div className="corr-grid">
            <label>
              ИМЯ
              <input aria-label={`Имя шага ${i + 1}`} value={d.name} onChange={(e) => patchDraft(d.key, { name: e.target.value })} />
            </label>
            <label>
              ЦЕНТР МГц
              <input
                aria-label={`Центр шага ${i + 1}`}
                inputMode="decimal"
                value={d.center}
                onChange={(e) => patchDraft(d.key, { center: e.target.value })}
              />
            </label>
            <label>
              ВЗГЛЯД МГц
              <input
                aria-label={`Взгляд шага ${i + 1}`}
                inputMode="decimal"
                value={d.look}
                onChange={(e) => patchDraft(d.key, { look: e.target.value })}
              />
            </label>
            <label>
              ВЫДЕРЖКА мс
              <input
                aria-label={`Выдержка шага ${i + 1}`}
                inputMode="decimal"
                value={d.dwell}
                onChange={(e) => patchDraft(d.key, { dwell: e.target.value })}
              />
            </label>
            <label>
              ВОЛНА
              <select aria-label={`Волна шага ${i + 1}`} value={d.wave} onChange={(e) => patchDraft(d.key, { wave: e.target.value })}>
                <option value="">копия IQ / CW</option>
                {WAVE_CATALOG.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.title}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
      ))}

      <div className="power-row">
        <button type="button" className="btn-primary" onClick={() => applyDrafts()}>
          ПРИМЕНИТЬ ШАГИ
        </button>
        <button
          type="button"
          className="btn-ghost"
          disabled={!s.labPlaylist || s.labPlaylistIdx >= s.labPlaylist.steps.length - 1}
          onClick={() => s.applyPlaylistStep(s.labPlaylistIdx + 1)}
        >
          СЛЕДУЮЩИЙ ШАГ
        </button>
        <button type="button" className="btn-ghost" onClick={() => playlistFileRef.current?.click()}>
          ФАЙЛ JSON
        </button>
        <input
          ref={playlistFileRef}
          type="file"
          accept="application/json,.json"
          hidden
          aria-label="Импорт плейлиста JSON"
          onChange={(e) => {
            const input = e.currentTarget;
            readPickedFile(input.files?.[0], (text) => {
              if (s.applyPlaylistJson(text)) {
                const pl = useLegion.getState().labPlaylist;
                if (pl) {
                  setPlName(pl.name);
                  setDrafts(pl.steps.map(draftFromStep));
                }
              }
              input.value = "";
            });
          }}
        />
        {s.labPlaylist && (
          <span className="sens-hint">
            {s.labPlaylist.name} · {s.labPlaylistIdx + 1}/{s.labPlaylist.steps.length} · Старт сами
          </span>
        )}
      </div>

      <div className="corr-grid">
        <label>
          IPERF ХОСТ
          <input
            aria-label="Адрес iperf3 сервера стенда"
            value={s.labIperfHost}
            onChange={(e) => s.setLabIperfHost(e.target.value)}
            placeholder="192.168.1.10"
          />
        </label>
        <label>
          ПОРТ
          <input aria-label="Порт iperf3" value={s.labIperfPort} onChange={(e) => s.setLabIperfPort(e.target.value)} />
        </label>
        <label>
          СЕК
          <input aria-label="Длительность iperf3" value={s.labIperfSec} onChange={(e) => s.setLabIperfSec(e.target.value)} />
        </label>
        <label>
          ПРОГОНЫ
          <input aria-label="Число прогонов iperf3" value={s.labIperfLoops} onChange={(e) => s.setLabIperfLoops(e.target.value)} />
        </label>
        <label>
          <input type="checkbox" checked={s.labIperfUdp} onChange={(e) => s.setLabIperfUdp(e.target.checked)} />
          UDP
        </label>
      </div>
      <div className="power-row">
        <button type="button" className="btn-primary" onClick={() => void s.runLabIperf()} disabled={s.labIperfBusy}>
          {s.labIperfBusy ? "IPERF…" : "ПРОГНАТЬ IPERF3"}
        </button>
        <button type="button" className="btn-ghost" onClick={() => iperfFileRef.current?.click()}>
          ФАЙЛ IPERF3
        </button>
        <input
          ref={iperfFileRef}
          type="file"
          accept="application/json,.json"
          hidden
          aria-label="Файл iperf3 --json с другого ПК"
          onChange={(e) => {
            const input = e.currentTarget;
            readPickedFile(input.files?.[0], (text) => {
              s.setLabIperfJson(text);
              input.value = "";
            });
          }}
        />
        <span className="sens-hint">
          {s.labIperf
            ? `lost ${s.labIperf.lostPercent} % · ${s.labIperf.bytes} байт`
            : "нет отчёта — не выдумываем 80 %. Потери руками не ставить"}
        </span>
      </div>

      <div className="corr-grid">
        <label>
          БАТЧИ ОК
          <input aria-label="Батчи без ошибки" value={bperOk} onChange={(e) => setBperOk(e.target.value)} />
        </label>
        <label>
          БАТЧИ ПЛОХИЕ
          <input aria-label="Плохие батчи" value={bperBad} onChange={(e) => setBperBad(e.target.value)} />
        </label>
        <label>
          JSR = Pj/Esig
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
