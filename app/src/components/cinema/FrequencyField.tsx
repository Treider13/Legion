import { useEffect, useRef } from "react";

import { prefersReducedMotion } from "../../hooks/useDeviceTier";
import { finiteDbm } from "../../sense/labPsd";
import {
  WATERFALL_COLS,
  WATERFALL_ROWS,
  dbmToUnit,
  heatRgb,
  nextWaterfallRow,
  shouldPushWaterfallRow,
  waterfallBandChanged,
} from "../../sense/waterfall";
import { useLegion } from "../../state/store";
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
    const history: Float32Array[] = Array.from({ length: WATERFALL_ROWS }, () => new Float32Array(WATERFALL_COLS));
    let composite: Float32Array | null = null;
    let receivedSpectrum = false;
    let lastPush = 0;
    let lastKey = "";
    let lastLo = Number.NaN;
    let lastHi = Number.NaN;
    let heatDirty = true;
    let raf = 0;
    let alive = true;
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
        raf = requestAnimationFrame(draw);
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
        for (let i = 0; i < WATERFALL_ROWS; i++) history.push(new Float32Array(WATERFALL_COLS));
        composite = null;
        receivedSpectrum = false;
        lastKey = "";
        lastPush = 0;
        heatDirty = true;
      }

      const lookMhz = Math.max(parseFloat(st.fpgaAirBwMhz) || 2, 0.2);
      const fpgaMhz = st.fpgaStatus?.freq_mhz ?? st.lastForwardMhz;
      const det = st.fpgaStatus?.det_active === true;
      const key = st.fpgaArmed
        ? `f:${fpgaMhz ?? 0}:${det}:${st.fpgaStatus?.det_count ?? 0}`
        : `b:${st.scanBins.length}:${st.scanBins[0]?.powerDbm ?? 0}:${st.scanCenterMhz ?? 0}`;
      if (shouldPushWaterfallRow(t - lastPush, 70, st.scanRunning || st.fpgaArmed, key !== lastKey)) {
        const row = nextWaterfallRow(
          composite,
          {
            bins: st.scanBins,
            fpgaArmed: st.fpgaArmed,
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
      }

      if (st.scanBins.some(b => finiteDbm(b.powerDbm))) receivedSpectrum = true;
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
              const [cr, cg, cb] = heatRgb(src[c] ?? 0);
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

      const strokeDbm = (bins: { freqMhz: number; powerDbm: number }[], color: string, width: number, dash: number[] = []) => {
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.setLineDash(dash);
        ctx.beginPath();
        let started = false;
        for (const b of bins) {
          if (!finiteDbm(b.powerDbm)) {
            started = false;
            continue;
          }
          const x = xOf(b.freqMhz);
          const y = baseY - dbmToUnit(b.powerDbm) * specH;
          if (!started) {
            ctx.moveTo(x, y);
            started = true;
          } else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.setLineDash([]);
      };

      const latest = rows.length > 0 ? rows[rows.length - 1] : null;
      if (latest && receivedSpectrum) {
        ctx.beginPath();
        for (let c = 0; c < latest.length; c++) {
          const mhz = lo + ((c + 0.5) / latest.length) * span;
          const y = baseY - latest[c] * specH;
          const x = xOf(mhz);
          if (c === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = "rgba(236, 230, 218, 0.7)";
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }
      if (st.labShowPeak && st.labPsd.peakHold.length) {
        strokeDbm(st.labPsd.peakHold, "rgba(245, 193, 108, 0.85)", 1.1);
      }
      if (st.labShowBaseline && st.labPsd.baseline.some((b) => finiteDbm(b.powerDbm))) {
        strokeDbm(st.labPsd.baseline, "rgba(232, 228, 220, 0.4)", 1, [3, 3]);
      }

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

      raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
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
