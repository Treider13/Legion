import { useEffect, useRef } from "react";

import { prefersReducedMotion } from "../../hooks/useDeviceTier";
import { useLegion } from "../../state/store";

function bandEdges(s: {
  sdrBands: Array<{ f1Mhz: number; f2Mhz: number }>;
  sdrF1: string;
  sdrF2: string;
  corrF1: string;
  corrF2: string;
  workspace: string;
}): { f1: number; f2: number } {
  const sdr = s.workspace === "sdr" || s.workspace === "scan" || s.workspace === "signal" || s.workspace === "sdrFlash";
  if (sdr) {
    const f1 = s.sdrBands.length ? Math.min(...s.sdrBands.map((b) => b.f1Mhz)) : parseFloat(s.sdrF1) || 2400;
    const f2 = s.sdrBands.length ? Math.max(...s.sdrBands.map((b) => b.f2Mhz)) : parseFloat(s.sdrF2) || 2500;
    return { f1, f2 };
  }
  return { f1: parseFloat(s.corrF1) || 2400, f2: parseFloat(s.corrF2) || 2500 };
}

export function FrequencyField() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const f1 = useLegion((s) => bandEdges(s).f1);
  const f2 = useLegion((s) => bandEdges(s).f2);
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
    let raf = 0;
    let alive = true;

    const draw = (t: number) => {
      if (!alive) return;
      const st = useLegion.getState();
      const { f1: lo, f2: hi } = bandEdges(st);
      const span = Math.max(hi - lo, 1e-6);
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

      const pad = 18;
      const plotW = cssW - pad * 2;
      const baseY = cssH - 22;
      const plotH = cssH - 36;

      ctx.strokeStyle = "rgba(232, 228, 220, 0.08)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(pad, baseY);
      ctx.lineTo(pad + plotW, baseY);
      ctx.stroke();

      const step = span > 400 ? 100 : span > 80 ? 20 : 10;
      const first = Math.ceil(lo / step) * step;
      for (let f = first; f <= hi + 1e-9; f += step) {
        const x = pad + ((f - lo) / span) * plotW;
        ctx.strokeStyle = "rgba(232, 228, 220, 0.05)";
        ctx.beginPath();
        ctx.moveTo(x, 8);
        ctx.lineTo(x, baseY);
        ctx.stroke();
      }

      const bins = st.scanBins;
      const xOf = (mhz: number) => pad + ((mhz - lo) / span) * plotW;
      const yOf = (dbm: number) => {
        const n = Math.min(1, Math.max(0, (dbm + 100) / 58));
        return baseY - n * plotH;
      };

      if (st.scanCenterMhz != null && st.scanRunning) {
        const half = (parseFloat(st.scanWindowMhz) || 20) / 2;
        const x0 = Math.max(pad, xOf(st.scanCenterMhz - half));
        const x1 = Math.min(pad + plotW, xOf(st.scanCenterMhz + half));
        ctx.fillStyle = "rgba(232, 228, 220, 0.045)";
        ctx.fillRect(x0, 8, Math.max(x1 - x0, 2), baseY - 8);
      }

      if (bins.length > 0) {
        ctx.beginPath();
        let started = false;
        for (const b of bins) {
          if (b.freqMhz < lo || b.freqMhz > hi) continue;
          const x = xOf(b.freqMhz);
          const y = yOf(b.powerDbm);
          if (!started) {
            ctx.moveTo(x, baseY);
            ctx.lineTo(x, y);
            started = true;
          } else {
            ctx.lineTo(x, y);
          }
        }
        if (started) {
          ctx.lineTo(xOf(bins[bins.length - 1].freqMhz), baseY);
          ctx.closePath();
          ctx.fillStyle = "rgba(214, 208, 196, 0.16)";
          ctx.fill();
          ctx.strokeStyle = "rgba(236, 230, 218, 0.55)";
          ctx.lineWidth = 1.25;
          ctx.stroke();
        }
      } else if (!quiet) {
        ctx.beginPath();
        for (let i = 0; i <= 96; i++) {
          const mhz = lo + (span * i) / 96;
          const breathe = Math.sin(mhz * 0.11 + t * 0.0007) * 4;
          const y = baseY - (10 + breathe);
          const x = xOf(mhz);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = "rgba(232, 228, 220, 0.14)";
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      for (const d of st.detections) {
        if (d.freqMhz < lo || d.freqMhz > hi) continue;
        const x = xOf(d.freqMhz);
        ctx.strokeStyle = d.forwarded ? "rgba(255, 176, 148, 0.85)" : "rgba(236, 230, 218, 0.7)";
        ctx.beginPath();
        ctx.moveTo(x, 10);
        ctx.lineTo(x, baseY);
        ctx.stroke();
      }

      if (st.lastForwardMhz != null) {
        const x = xOf(st.lastForwardMhz);
        ctx.strokeStyle = "rgba(255, 168, 136, 0.95)";
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

      raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
    };
  }, []);

  const live = scanRunning || transmitArmed || corridorRunning || fpgaArmed;
  const read =
    lastForward != null
      ? `${lastForward.toFixed(3)} МГц`
      : lastHit != null
        ? `${lastHit.toFixed(3)} МГц`
        : telem != null
          ? `${telem.toFixed(3)} МГц`
          : center != null
            ? `${center.toFixed(3)} МГц`
            : "—";

  return (
    <section className="cinema-field" aria-label="Полоса частот">
      <canvas ref={canvasRef} className="cinema-field-canvas" />
      <div className="cinema-field-meta">
        <span>{f1.toFixed(0)}</span>
        <span className={live ? "cinema-field-read live" : "cinema-field-read"}>
          {read}
          {fpgaArmed && fpgaPath === "air" ? " · эфир+FPGA" : ""}
          {fpgaArmed && fpgaPath === "solo" ? " · FPGA" : ""}
          {transmitArmed && hostUs != null ? ` · ${hostUs} µs host` : ""}
          {scanRunning && !transmitArmed && !fpgaArmed ? " · слушает" : ""}
          {transmitArmed && !fpgaArmed ? " · на усилитель" : ""}
          {corridorRunning ? " · коридор" : ""}
        </span>
        <span>{f2.toFixed(0)}</span>
      </div>
    </section>
  );
}
