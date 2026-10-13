import { useEffect, useRef } from "react";

import { prefersReducedMotion } from "../../hooks/useDeviceTier";
import { angelRgb } from "../../sense/angelPalette";
import { requestSpectrumPaint } from "../../sense/spectrumPaintClient";
import { SDRANGEL_FRAME_MS } from "../../sense/spectrumPaint";
import type { SdrangelScale } from "../../sense/waterfall";
import {
  WATERFALL_COLS,
  WATERFALL_ROWS,
  heatRgb,
  nextWaterfallRow,
  SDRANGEL_TRACE,
  shouldPushWaterfallRow,
  waterfallBandChanged,
} from "../../sense/waterfall";
import { useLegion, visibleDetectMhz } from "../../state/store";
import { displayRange, displayRangeNotice, formatDisplayRange, formatFrequency, frequencyTicks } from "../displayRange";

export function FrequencyField() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const f1 = useLegion((s) => displayRange(s)?.f1 ?? null);
  const f2 = useLegion((s) => displayRange(s)?.f2 ?? null);
  const scanRunning = useLegion((s) => s.scanRunning);
  const transmitArmed = useLegion((s) => s.transmitArmed);
  const corridorRunning = useLegion((s) => s.corridorRunning);
  const lastForward = useLegion((s) => s.lastForwardMhz);
  const lastHit = useLegion((s) => s.lastInterceptMhz);
  const center = useLegion((s) => s.scanCenterMhz);
  const hostUs = useLegion((s) => s.lastSdrTxUs);
  const telem = useLegion((s) => s.telemFreq);
  const fpgaArmed = useLegion((s) => s.fpgaArmed);
  const fpgaPath = useLegion((s) => s.fpgaPath);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const quiet = prefersReducedMotion();
    const history: Float32Array[] = Array.from({ length: WATERFALL_ROWS }, () => {
      const row = new Float32Array(WATERFALL_COLS);
      row.fill(Number.NaN);
      return row;
    });
    let composite: Float32Array | null = null;
    let receivedSpectrum = false;
    let lastPush = 0;
    let lastKey = "";
    let lastSweepSeq = 0;
    let lastLo = Number.NaN;
    let lastHi = Number.NaN;
    let heatDirty = true;
    let pictureHost = false;
    let timer = 0;
    let alive = true;
    const hold: {
      job: number;
      trace: readonly { freqMhz: number; powerDbm: number }[] | null;
      peak: readonly { freqMhz: number; powerDbm: number }[] | null;
      base: readonly { freqMhz: number; powerDbm: number }[] | null;
      geom: string;
      scale: SdrangelScale;
      live: Float32Array | null;
      peakCols: Float32Array | null;
      baseCols: Float32Array | null;
    } = {
      job: 0,
      trace: null,
      peak: null,
      base: null,
      geom: "",
      scale: { refDb: 0, rangeDb: 100, floorDb: -100 },
      live: null,
      peakCols: null,
      baseCols: null,
    };
    const off = document.createElement("canvas");
    off.width = WATERFALL_COLS;
    off.height = WATERFALL_ROWS;
    const offCtx = off.getContext("2d");

    const draw = (t: number) => {
      if (!alive) return;
      const st = useLegion.getState();
      const range = displayRange(st);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const cssW = canvas.clientWidth;
      const cssH = canvas.clientHeight;
      const w = Math.max(1, Math.floor(cssW * dpr));
      const h = Math.max(1, Math.floor(cssH * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);
      ctx.fillStyle = "#07080c";
      ctx.fillRect(0, 0, cssW, cssH);

      const notice = displayRangeNotice(range);
      if (!range || notice) {
        lastLo = Number.NaN;
        lastHi = Number.NaN;
        ctx.fillStyle = "rgba(187, 201, 210, 0.7)";
        ctx.font = "11px ui-monospace, monospace";
        ctx.textAlign = "center";
        ctx.fillText(notice ?? "Укажите корректные F1 и F2", cssW / 2, cssH / 2);
        return;
      }
      const { f1: lo, f2: hi } = range;
      const span = hi - lo;

      const pad = 18;
      const plotW = cssW - pad * 2;
      const wfH = Math.max(48, cssH - 56);
      const specH = 28;
      const specTop = 8 + wfH + 4;
      const baseY = specTop + specH;
      const xOf = (mhz: number) => pad + ((mhz - lo) / span) * plotW;

      if (waterfallBandChanged(lastLo, lastHi, lo, hi)) {
        lastLo = lo;
        lastHi = hi;
        history.length = 0;
        for (let i = 0; i < WATERFALL_ROWS; i++) {
          const row = new Float32Array(WATERFALL_COLS);
          row.fill(Number.NaN);
          history.push(row);
        }
        composite = null;
        receivedSpectrum = false;
        lastKey = "";
        lastPush = 0;
        heatDirty = true;
        hold.trace = null;
        hold.geom = "";
        hold.live = null;
        hold.peakCols = null;
        hold.baseCols = null;
      }

      const hostPicture = !st.fpgaArmed;
      if (hostPicture !== pictureHost) {
        pictureHost = hostPicture;
        history.length = 0;
        for (let i = 0; i < WATERFALL_ROWS; i++) {
          const row = new Float32Array(WATERFALL_COLS);
          row.fill(Number.NaN);
          history.push(row);
        }
        composite = null;
        receivedSpectrum = false;
        lastKey = "";
        lastPush = 0;
        heatDirty = true;
        hold.trace = null;
        hold.geom = "";
        hold.live = null;
        hold.peakCols = null;
        hold.baseCols = null;
      }

      const lookMhz = Math.max(parseFloat(st.fpgaAirBwMhz) || 2, 0.2);
      const fpgaMhz = st.fpgaStatus?.freq_mhz ?? st.lastForwardMhz;
      const det = st.fpgaStatus?.det_active === true;
      const sweepReady = st.scanSweepBins.length > 0 && st.scanSweepSeq !== lastSweepSeq;
      const key = st.fpgaArmed
        ? `f:${fpgaMhz ?? 0}:${det}:${st.fpgaStatus?.det_count ?? 0}`
        : `b:${st.scanBins.length}:${st.scanBins[0]?.powerDbm ?? 0}:${st.scanCenterMhz ?? 0}`;
      const pushLive = shouldPushWaterfallRow(t - lastPush, 70, st.scanRunning || st.fpgaArmed, key !== lastKey);
      const useSweep = !st.fpgaArmed && sweepReady;
      const useLive = !st.fpgaArmed && st.scanSweepBins.length === 0;
      // QSpectrumAnalyzer: пока проход не закрыт — живое окно, затем одна строка на коридор.
      if (pushLive && st.fpgaArmed) {
        const row = nextWaterfallRow(
          composite,
          {
            bins: [],
            fpgaArmed: true,
            fpgaFreqMhz: fpgaMhz,
            lookMhz,
            detActive: det,
          },
          lo,
          hi,
          WATERFALL_COLS,
        );
        composite = row;
        if (!quiet) {
          history.push(row);
          while (history.length > WATERFALL_ROWS) history.shift();
        } else {
          history.length = 0;
          history.push(row);
        }
        lastKey = key;
        lastPush = t;
        heatDirty = true;
        receivedSpectrum = true;
      }
      if (hostPicture) {
        const traceBins = st.scanSweepBins.length ? st.scanSweepBins : st.scanBins;
        const cols = Math.max(64, Math.min(1600, Math.round(plotW)));
        const geom = `${lo}:${hi}:${cols}`;
        const peak = st.labPsd.peakHold;
        const base = st.labPsd.baseline;
        const wantWf = pushLive && (useSweep || useLive);
        const traceSame = traceBins === hold.trace && peak === hold.peak && base === hold.base && geom === hold.geom;
        if (!traceSame || wantWf) {
          const prevPush = lastPush;
          const prevSeq = lastSweepSeq;
          const prevKey = lastKey;
          if (wantWf) {
            lastPush = t;
            lastKey = key;
            if (useSweep) lastSweepSeq = st.scanSweepSeq;
          }
          const wfBins = useSweep ? st.scanSweepBins : st.scanBins;
          hold.trace = traceBins;
          hold.peak = peak;
          hold.base = base;
          hold.geom = geom;
          const id = requestSpectrumPaint(
            {
              f1: lo,
              f2: hi,
              cols,
              traces: [traceBins, peak, base],
              waterfall: wantWf ? { bins: wfBins, cols: WATERFALL_COLS } : null,
            },
            (result) => {
              if (!alive || hold.job !== id) return;
              if (!result) {
                if (hold.trace === traceBins && hold.geom === geom) {
                  hold.trace = null;
                  hold.geom = "";
                }
                if (wantWf) {
                  lastPush = prevPush;
                  lastSweepSeq = prevSeq;
                  lastKey = prevKey;
                }
                return;
              }
              if (result.scales[0]) hold.scale = result.scales[0];
              hold.live = result.columns[0] ?? null;
              hold.peakCols = result.columns[1] ?? null;
              hold.baseCols = result.columns[2] ?? null;
              receivedSpectrum = true;
              if (result.waterfall) {
                const row = result.waterfall;
                composite = row;
                if (!quiet) {
                  history.push(row);
                  while (history.length > WATERFALL_ROWS) history.shift();
                } else {
                  history.length = 0;
                  history.push(row);
                }
                heatDirty = true;
              }
            },
          );
          hold.job = id;
        }
      }
      const rows = history.length > 0 ? history : [];
      if (receivedSpectrum && rows.length > 0 && offCtx) {
        if (off.height !== rows.length) {
          off.height = rows.length;
          heatDirty = true;
        }
        if (heatDirty) {
          const img = offCtx.createImageData(WATERFALL_COLS, rows.length);
          for (let r = 0; r < rows.length; r++) {
            const src = rows[r];
            for (let c = 0; c < WATERFALL_COLS; c++) {
              const sample = src[c] ?? Number.NaN;
              const [cr, cg, cb] = hostPicture
                ? angelRgb(Number.isFinite(sample) ? sample : 0)
                : heatRgb(sample);
              const o = (r * WATERFALL_COLS + c) * 4;
              img.data[o] = cr;
              img.data[o + 1] = cg;
              img.data[o + 2] = cb;
              img.data[o + 3] = 255;
            }
          }
          offCtx.putImageData(img, 0, 0);
          heatDirty = false;
        }
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(off, pad, 8, plotW, wfH);
      }

      const hostScale = hostPicture ? hold.scale : null;
      const yOfPower = (dbm: number) => {
        if (!hostScale) return baseY - Math.min(1, Math.max(0, (dbm + 110) / 70)) * specH;
        const tPow = (hostScale.refDb - dbm) / hostScale.rangeDb;
        return specTop + Math.min(1, Math.max(0, tPow)) * specH;
      };

      const strokeCols = (col: Float32Array | null, color: string, width: number, dash: number[] = []) => {
        if (!col) return;
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.setLineDash(dash);
        ctx.beginPath();
        let started = false;
        const n = col.length;
        for (let i = 0; i < n; i++) {
          const db = col[i]!;
          if (!Number.isFinite(db)) {
            started = false;
            continue;
          }
          const x = pad + ((i + 0.5) / n) * plotW;
          const y = yOfPower(db);
          if (!started) {
            ctx.moveTo(x, y);
            started = true;
          } else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.setLineDash([]);
      };

      const latest = rows.length > 0 ? rows[rows.length - 1] : null;
      if (hostPicture && receivedSpectrum && hold.live) {
        strokeCols(hold.live, SDRANGEL_TRACE, 1.2);
      } else if (latest && receivedSpectrum) {
        ctx.beginPath();
        for (let c = 0; c < latest.length; c++) {
          const sample = latest[c] ?? Number.NaN;
          if (!Number.isFinite(sample)) continue;
          const mhz = lo + ((c + 0.5) / latest.length) * span;
          const y = baseY - Math.min(1, Math.max(0, sample)) * specH;
          const x = xOf(mhz);
          if (c === 0 || !Number.isFinite(latest[c - 1] ?? Number.NaN)) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = "rgba(236, 230, 218, 0.7)";
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }
      const detectMhz = visibleDetectMhz(st.smartGridAccepted, st.attackTracks);
      if (detectMhz.length > 0 && receivedSpectrum) {
        ctx.strokeStyle = SDRANGEL_TRACE;
        ctx.lineWidth = 1;
        for (const mhz of detectMhz) {
          if (mhz < lo || mhz > hi) continue;
          const x = xOf(mhz);
          ctx.beginPath();
          ctx.moveTo(x, 8);
          ctx.lineTo(x, baseY);
          ctx.stroke();
        }
      }
      if (hostPicture && st.labShowPeak) strokeCols(hold.peakCols, "rgba(245, 193, 108, 0.85)", 1.1);
      if (hostPicture && st.labShowBaseline) strokeCols(hold.baseCols, "rgba(232, 228, 220, 0.4)", 1, [3, 3]);

      if (st.fpgaArmed && fpgaMhz != null) {
        const half = lookMhz / 2;
        const x0 = Math.max(pad, xOf(fpgaMhz - half));
        const x1 = Math.min(pad + plotW, xOf(fpgaMhz + half));
        ctx.fillStyle = det ? "rgba(255, 168, 136, 0.12)" : "rgba(232, 228, 220, 0.05)";
        ctx.fillRect(x0, 8, Math.max(x1 - x0, 2), wfH);
      } else if (st.scanCenterMhz != null && st.scanRunning) {
        const bins = st.scanBins;
        const fromBins = bins.length >= 2 ? (bins[bins.length - 1].freqMhz - bins[0].freqMhz) / 2 : 0;
        const half = fromBins > 0 ? fromBins : (parseFloat(st.scanWindowMhz) || 20) / 2;
        const x0 = Math.max(pad, xOf(st.scanCenterMhz - half));
        const x1 = Math.min(pad + plotW, xOf(st.scanCenterMhz + half));
        ctx.fillStyle = "rgba(232, 228, 220, 0.045)";
        ctx.fillRect(x0, 8, Math.max(x1 - x0, 2), wfH);
      }

      ctx.strokeStyle = "rgba(232, 228, 220, 0.08)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(pad, baseY);
      ctx.lineTo(pad + plotW, baseY);
      ctx.stroke();

      ctx.fillStyle = "rgba(232, 228, 220, 0.28)";
      ctx.font = "10px ui-sans-serif, system-ui, sans-serif";
      for (const f of frequencyTicks(range, plotW)) {
        const x = xOf(f);
        ctx.strokeStyle = "rgba(232, 228, 220, 0.05)";
        ctx.beginPath();
        ctx.moveTo(x, 8);
        ctx.lineTo(x, baseY);
        ctx.stroke();
      }

      if (st.lastForwardMhz != null) {
        const x = xOf(st.lastForwardMhz);
        ctx.strokeStyle = det && st.fpgaArmed ? "rgba(255, 168, 136, 0.95)" : "rgba(255, 168, 136, 0.75)";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x, 6);
        ctx.lineTo(x, baseY);
        ctx.stroke();
      }

      if (st.telemFreq != null && st.corridorRunning) {
        const x = xOf(st.telemFreq);
        ctx.strokeStyle = "rgba(236, 230, 218, 0.8)";
        ctx.beginPath();
        ctx.moveTo(x, 6);
        ctx.lineTo(x, baseY);
        ctx.stroke();
      }

      if (!receivedSpectrum) {
        ctx.fillStyle = "rgba(187, 201, 210, 0.7)";
        ctx.font = "11px ui-monospace, monospace";
        ctx.textAlign = "center";
        ctx.fillText("Ожидание данных", cssW / 2, Math.max(24, wfH / 2));
        ctx.textAlign = "start";
      }

    };

    const frame = (now: number) => {
      if (!alive) return;
      draw(now);
      if (alive) timer = window.setTimeout(() => frame(performance.now()), SDRANGEL_FRAME_MS);
    };
    timer = window.setTimeout(() => frame(performance.now()), 0);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, []);

  const live = scanRunning || transmitArmed || corridorRunning || fpgaArmed;
  const read = fpgaArmed
    ? lastForward != null
      ? `${lastForward.toFixed(3)} МГц`
      : "—"
    : lastForward != null
      ? `${lastForward.toFixed(3)} МГц`
      : lastHit != null
        ? `${lastHit.toFixed(3)} МГц`
        : telem != null
          ? `${telem.toFixed(3)} МГц`
          : center != null
            ? `${center.toFixed(3)} МГц`
            : "—";

  return (
    <section className="cinema-field" aria-label="Водопад частот">
      <canvas ref={canvasRef} className="cinema-field-canvas" role="img" aria-label={`Водопад · ${formatDisplayRange(f1 != null && f2 != null ? { f1, f2 } : null)}`} />
      <div className="cinema-field-meta">
        <span>{formatFrequency(f1)}</span>
        <span className={live ? "cinema-field-read live" : "cinema-field-read"}>
          {read}
          {fpgaArmed && fpgaPath === "air" ? " · взгляд+гейт, не спектр" : ""}
          {fpgaArmed && fpgaPath === "solo" ? " · FPGA" : ""}
          {transmitArmed && hostUs != null ? ` · ${hostUs} µs host` : ""}
          {scanRunning && !transmitArmed && !fpgaArmed ? " · водопад · слушает" : ""}
          {transmitArmed && !fpgaArmed ? " · на усилитель" : ""}
          {corridorRunning ? " · коридор" : ""}
        </span>
        <span>{formatFrequency(f2)}</span>
      </div>
    </section>
  );
}
