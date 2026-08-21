// ============================================================================
// LEGION — вкладка ТИП СИГНАЛА: выбор baseband-волны, предпросмотр
// (спектр / время / созвездие) и «ЗАШИТЬ НА SDR» — TX в нагрузку 50 Ом.
// Синтез на хосте (tools/sdr_worker.py), здесь — только превью и команда.
// ============================================================================
import { useEffect, useMemo, useRef } from "react";

import {
  WAVE_CATALOG,
  WAVE_FS,
  WAVE_PREVIEW_N,
  clampParams,
  constellationPoints,
  previewWaveform,
  spectrumDb,
  waveMeta,
  type WaveKind,
} from "../sdr/waveforms";
import { useLegion } from "../state/store";

const ACCENT = "#2dd4bf";
const VIOLET = "#7c6cf0";
const DIM = "#5c6780";
const GRID = "rgba(255, 255, 255, 0.08)";

function drawGrid(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.strokeStyle = GRID;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 1; i < 4; i++) {
    ctx.moveTo(0, (h / 4) * i);
    ctx.lineTo(w, (h / 4) * i);
  }
  ctx.moveTo(w / 2, 0);
  ctx.lineTo(w / 2, h);
  ctx.stroke();
}

function drawSpectrum(canvas: HTMLCanvasElement, db: Float64Array): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const { width: w, height: h } = canvas;
  ctx.clearRect(0, 0, w, h);
  drawGrid(ctx, w, h);
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of db) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const floor = Math.max(lo, hi - 70);
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i < db.length; i++) {
    const x = (i / (db.length - 1)) * w;
    const y = h - ((db[i] - floor) / (hi - floor || 1)) * (h - 8) - 4;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.fillStyle = DIM;
  ctx.font = "10px monospace";
  ctx.fillText(`−${(WAVE_FS / 2e6).toFixed(1)}`, 4, h - 4);
  ctx.fillText("0", w / 2 - 4, h - 4);
  ctx.fillText(`+${(WAVE_FS / 2e6).toFixed(1)} МГц`, w - 64, h - 4);
}

function drawTime(canvas: HTMLCanvasElement, re: Float64Array, im: Float64Array): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const { width: w, height: h } = canvas;
  ctx.clearRect(0, 0, w, h);
  drawGrid(ctx, w, h);
  const n = Math.min(512, re.length);
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(re[i]), Math.abs(im[i]));
  const scale = (h / 2 - 6) / (peak || 1);
  const trace = (data: Float64Array, color: string) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * w;
      const y = h / 2 - data[i] * scale;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  };
  trace(re, ACCENT);
  trace(im, VIOLET);
  ctx.fillStyle = DIM;
  ctx.font = "10px monospace";
  ctx.fillText("I", 4, 12);
  ctx.fillStyle = VIOLET;
  ctx.fillText("Q", 16, 12);
}

function drawConstellation(canvas: HTMLCanvasElement, pts: { i: number; q: number }[]): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const { width: w, height: h } = canvas;
  ctx.clearRect(0, 0, w, h);
  drawGrid(ctx, w, h);
  ctx.fillStyle = ACCENT;
  for (const p of pts) {
    const x = w / 2 + p.i * (w / 2 - 10);
    const y = h / 2 - p.q * (h / 2 - 10);
    ctx.beginPath();
    ctx.arc(x, y, 2.2, 0, 2 * Math.PI);
    ctx.fill();
  }
}

export function SignalPanel() {
  const s = useLegion();
  const meta = waveMeta(s.signalKind);
  const params = useMemo(
    () => clampParams(s.signalKind, s.signalParams),
    [s.signalKind, s.signalParams],
  );
  const specRef = useRef<HTMLCanvasElement>(null);
  const timeRef = useRef<HTMLCanvasElement>(null);

  const constellation = useMemo(
    () => constellationPoints(s.signalKind, params),
    [s.signalKind, params],
  );

  useEffect(() => {
    const { re, im } = previewWaveform(s.signalKind, params, WAVE_PREVIEW_N);
    if (specRef.current) drawSpectrum(specRef.current, spectrumDb(re, im));
    if (timeRef.current) {
      if (constellation) drawConstellation(timeRef.current, constellation);
      else drawTime(timeRef.current, re, im);
    }
  }, [s.signalKind, params, constellation]);

  const busy = s.transmitArmed || s.scanRunning;

  return (
    <section className="panel">
      <span className="panel-title">ТИП СИГНАЛА // BASEBAND → SDR</span>
      <p className="panel-note">
        Волна синтезируется на ноутбуке (fs {WAVE_FS / 1e6} МГц, буфер 65536 I/Q) и
        непрерывно стримится в SDR по USB/Ethernet: SDR — это ЦАП + RF-тракт, он волну
        НЕ хранит. Отключили ноутбук/программу — TX остановился (буфер SDR пустеет за
        миллисекунды). «Зашить» = выбрать контент потока, а не прошить FPGA.
        Предпросмотр — точная модель спектра. ЗАШИТЬ — только при подтверждённой
        нагрузке 50 Ом (вкладка СКАН + TX SDR) и полосе allowlist.
        ESP32 в этом тракте не участвует.
      </p>
      <div className="corr-grid">
        <label>
          ТИП СИГНАЛА
          <select
            aria-label="Тип сигнала"
            value={s.signalKind}
            onChange={(e) => s.setSignalKind(e.target.value as WaveKind)}
            disabled={busy}
          >
            {WAVE_CATALOG.map((w) => (
              <option key={w.id} value={w.id}>
                {w.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          ЧАСТОТА RF МГц
          <input
            aria-label="Центральная частота RF для сигнала"
            value={s.signalFreqMhz}
            onChange={(e) => s.setSignalFreqMhz(e.target.value)}
            disabled={busy}
            spellCheck={false}
          />
        </label>
        {meta.params
          .filter((p) => p.key !== "amp")
          .map((p) => (
            <label key={p.key}>
              {p.label}
              {p.unit ? ` (${p.unit})` : ""}
              <input
                aria-label={`${meta.title} ${p.label}`}
                type="number"
                min={p.min}
                max={p.max}
                step={p.step}
                value={params[p.key] ?? p.def}
                onChange={(e) => s.setSignalParam(p.key, parseFloat(e.target.value))}
                disabled={busy}
              />
            </label>
          ))}
        <label>
          АМПЛИТУДА (ЦАП)
          <input
            aria-label="Амплитуда сигнала"
            type="number"
            min={0.05}
            max={0.9}
            step={0.05}
            value={params.amp ?? 0.25}
            onChange={(e) => s.setSignalParam("amp", parseFloat(e.target.value))}
            disabled={busy}
          />
        </label>
      </div>
      <p className="sens-hint">{meta.desc}</p>
      <div className="wave-preview">
        <div className="wave-plot">
          <span className="wave-plot-k">СПЕКТР (дБ, ось 0 = центр RF)</span>
          <canvas ref={specRef} width={560} height={150} />
        </div>
        <div className="wave-plot">
          <span className="wave-plot-k">{constellation ? "СОЗВЕЗДИЕ (идеал)" : "ВРЕМЯ (I/Q)"}</span>
          <canvas ref={timeRef} width={560} height={150} />
        </div>
      </div>
      <div className="power-row">
        {s.signalTxActive ? (
          <button className="btn-danger" onClick={() => void s.stopTransmit()}>
            СТОП TX
          </button>
        ) : (
          <button className="btn-primary" onClick={() => void s.signalFlash()} disabled={busy}>
            ЗАШИТЬ НА SDR
          </button>
        )}
        {s.txWaveKind !== null && (
          <button className="btn-ghost" type="button" onClick={() => s.disarmTxWave()}>
            СБРОС НА CW
          </button>
        )}
        <button className="btn-ghost" type="button" onClick={() => s.setWorkspace("scan")}>
          СКАН + TX SDR →
        </button>
      </div>
      <p className="sens-hint">
        {s.txWaveKind !== null
          ? `Зашита волна «${waveMeta(s.txWaveKind).title}» — её используют все TX-режимы: АВТО/ПРИОРИТЕТ (сканер → цель) и без сканера (качание/сплошная/случайная). Поток идёт с ноутбука — SDR сам по себе волну не хранит.`
          : "TX-контент: CW тон (по умолчанию). ЗАШИТЬ — и выбранная волна уйдёт во все TX-режимы."}
      </p>
      {s.lastCueReason && <p className="sens-hint">{s.lastCueReason}</p>}

      <div className="fpga-block">
        <span className="panel-title">FPGA (bladeRF 1 x40) // АВТОНОМНЫЙ ТРАКТ</span>
        <p className="panel-note">
          Ревизия legion: волна/тон/loopback играют ВНУТРИ FPGA (ноутбук не в тракте
          данных). Управление и мониторинг — по Ethernet через агент шлюза
          (legion_gateway.py). Watchdog: пропал heartbeat ~1 с → TX гаснет сам.
          Требует прошивки ревизии legion (fpga/README.md). Пока FPGA в режиме
          PLAYER/NCO/LOOPBACK, мультиплексор FPGA перекрывает хост-стрим
          (стрим идёт в режиме PASS). Загрузка волны в RAM: режим PASS +
          capture_arm + обычная ЗАШИТЬ (стрим и capture одновременно).
        </p>
        <div className="corr-grid">
          <label>
            РЕЖИМ FPGA
            <select
              aria-label="Режим FPGA"
              value={s.fpgaMode}
              onChange={(e) => s.setFpgaMode(e.target.value as typeof s.fpgaMode)}
              disabled={s.fpgaArmed || s.fpgaBusy}
            >
              <option value="player">PLAYER — волна из RAM FPGA</option>
              <option value="nco">NCO — тон DDS из FPGA</option>
              <option value="lb_gated">LOOPBACK по детектору (RX→TX)</option>
              <option value="lb_always">LOOPBACK постоянный (RX→TX)</option>
            </select>
          </label>
        </div>
        <div className="power-row">
          {s.fpgaArmed ? (
            <button className="btn-danger" disabled={s.fpgaBusy} onClick={() => void s.fpgaDisarm()}>
              ОСТАНОВИТЬ FPGA
            </button>
          ) : (
            <button className="btn-primary" disabled={s.fpgaBusy} onClick={() => void s.fpgaArm()}>
              ЗАПУСТИТЬ FPGA
            </button>
          )}
          <button className="btn-ghost" onClick={() => void s.fpgaPollStatus()}>
            СТАТУС
          </button>
        </div>
        {s.fpgaStatus && (
          <div className="sdr-facts">
            <div>
              {s.fpgaStatus.ok
                ? `playing=${s.fpgaStatus.playing ? "да" : "нет"} · capture_done=${s.fpgaStatus.capture_done ? "да" : "нет"} · det=${s.fpgaStatus.det_active ? "активен" : "нет"} · watchdog=${s.fpgaStatus.wd_fired ? "СРАБОТАЛ" : "жив"} · детектов=${s.fpgaStatus.det_count ?? 0} · lb_fifo=${s.fpgaStatus.lb_level ?? 0}`
                : `статус недоступен: ${s.fpgaStatus.reason ?? "?"}`}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
