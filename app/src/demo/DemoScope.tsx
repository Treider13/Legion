import { useEffect, useRef, useState } from "react";

import type { CaptureView } from "./recording";

export function DemoScope({
  f1,
  f2,
  capture,
  showTrace,
  scanning,
  markerMhz,
}: {
  f1: number;
  f2: number;
  capture: CaptureView | null;
  showTrace: boolean;
  scanning: boolean;
  markerMhz?: number | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const markerRef = useRef(markerMhz);
  markerRef.current = markerMhz;
  const [readout, setReadout] = useState("наведите — частота и относительный уровень");
  const [peakOn, setPeakOn] = useState(true);
  const [minOn, setMinOn] = useState(false);
  const [persistOn, setPersistOn] = useState(true);
  const [shelfOn, setShelfOn] = useState(true);
  const [subOn, setSubOn] = useState(false);
  const [rtsaOn, setRtsaOn] = useState(true);
  const [efisOn, setEfisOn] = useState(true);
  const [spurOn, setSpurOn] = useState(true);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let raf = 0;
    const draw = () => {
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
      const padL = 62;
      const padR = 22;
      const padT = 16;
      const padB = 28;
      const plotW = Math.max(1, cssW - padL - padR);
      const plotH = Math.max(1, cssH - padT - padB);
      ctx.strokeStyle = "rgba(232,228,220,0.14)";
      ctx.lineWidth = 1;
      ctx.font = "11px ui-monospace, monospace";
      ctx.fillStyle = "rgba(198,210,219,0.75)";
      ctx.textAlign = "right";
      for (let i = 0; i <= 4; i++) {
        const y = padT + (plotH * i) / 4;
        ctx.beginPath();
        ctx.moveTo(padL, y);
        ctx.lineTo(padL + plotW, y);
        ctx.stroke();
        ctx.fillText(`${(30 - i * 10).toFixed(0)}`, padL - 6, y + 4);
      }
      ctx.textAlign = "center";
      const span = f2 - f1 || 1;
      for (let i = 0; i <= 4; i++) {
        const x = padL + (plotW * i) / 4;
        ctx.beginPath();
        ctx.moveTo(x, padT);
        ctx.lineTo(x, padT + plotH);
        ctx.stroke();
        ctx.fillText((f1 + (span * i) / 4).toFixed(0), x, padT + plotH + 16);
      }
      ctx.fillText("Частота (МГц)", padL + plotW / 2, cssH - 4);
      if (showTrace && capture) {
        const n = capture.avgDb.length;
        ctx.beginPath();
        let started = false;
        for (let i = 0; i < n; i++) {
          const hz = capture.meta.centerHz + (i - n / 2) * (capture.meta.sampleRate / n);
          const mhz = hz / 1e6;
          if (mhz < f1 || mhz > f2) {
            started = false;
            continue;
          }
          const x = padL + ((mhz - f1) / span) * plotW;
          const t = Math.max(0, Math.min(1, (capture.avgDb[i] + 6) / 36));
          const y = padT + (1 - t) * plotH;
          if (!started) {
            ctx.moveTo(x, y);
            started = true;
          } else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = "#2dd4bf";
        ctx.lineWidth = 1.6;
        ctx.stroke();
        if (peakOn) {
          const px = padL + ((capture.peakHz / 1e6 - f1) / span) * plotW;
          ctx.strokeStyle = "#f5c16c";
          ctx.beginPath();
          ctx.moveTo(px, padT);
          ctx.lineTo(px, padT + plotH);
          ctx.stroke();
        }
      }
      const mark = markerRef.current;
      if (!showTrace && mark != null && Number.isFinite(mark) && mark >= f1 && mark <= f2) {
        const px = padL + ((mark - f1) / span) * plotW;
        ctx.strokeStyle = "#f5c16c";
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(px, padT);
        ctx.lineTo(px, padT + plotH);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [capture, f1, f2, peakOn, showTrace]);

  const onMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const padL = 62;
    const plotW = Math.max(1, rect.width - 84);
    const t = (event.clientX - rect.left - padL) / plotW;
    if (t < 0 || t > 1) return;
    const mhz = f1 + t * (f2 - f1);
    setReadout(`${mhz.toFixed(3)} МГц · относительный уровень`);
  };

  const peak =
    showTrace && capture
      ? `пик ${ (capture.peakHz / 1e6).toFixed(3) } · ${capture.peakDb.toFixed(1)} дБ (отн.) · −6 дБ ${(capture.widthHz / 1e6).toFixed(2)} МГц`
      : "пик —";

  return (
    <div className="scope-wrap" aria-label="Анализатор спектра xA4">
      <div className="scope-toolbar">
        <span className={scanning ? "scope-live on" : "scope-live"}>{scanning ? "Welch · хост" : "холст"}</span>
        <label><input type="checkbox" checked={peakOn} onChange={(e) => setPeakOn(e.target.checked)} /> peak</label>
        <label><input type="checkbox" checked={minOn} onChange={(e) => setMinOn(e.target.checked)} /> min</label>
        <label><input type="checkbox" checked={persistOn} onChange={(e) => setPersistOn(e.target.checked)} /> persist</label>
        <label><input type="checkbox" checked={shelfOn} onChange={(e) => setShelfOn(e.target.checked)} /> полка</label>
        <label><input type="checkbox" checked={subOn} onChange={(e) => setSubOn(e.target.checked)} /> −полка</label>
        <label><input type="checkbox" checked={rtsaOn} onChange={(e) => setRtsaOn(e.target.checked)} /> RTSA</label>
        <label><input type="checkbox" checked={efisOn} onChange={(e) => setEfisOn(e.target.checked)} /> EFIS</label>
        <label><input type="checkbox" checked={spurOn} onChange={(e) => setSpurOn(e.target.checked)} /> шпоры</label>
        <button type="button" className="btn-ghost">СБРОС HOLD</button>
      </div>
      <canvas
        ref={canvasRef}
        className={scanning ? "scope-canvas attack-brush" : "scope-canvas"}
        role="img"
        aria-label="PSD · относительный уровень, дБ"
        onPointerMove={onMove}
      />
      <div className="scope-meta">
        <span>{readout}</span>
        <span title="Относительный уровень цифровых отсчётов; абсолютная мощность в дБм не подтверждена">{peak}</span>
      </div>
    </div>
  );
}

export function DemoWaterfall({
  f1,
  f2,
  capture,
  showTrace,
  read,
  live,
  markerMhz,
}: {
  f1: number;
  f2: number;
  capture: CaptureView | null;
  showTrace: boolean;
  read: string;
  live: boolean;
  markerMhz?: number | null;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const frame = useRef(0);
  const sheet = useRef<HTMLCanvasElement | null>(null);
  const markerRef = useRef(markerMhz);
  markerRef.current = markerMhz;

  useEffect(() => {
    if (!capture) {
      sheet.current = null;
      return;
    }
    const bmp = document.createElement("canvas");
    bmp.width = capture.fftSize;
    bmp.height = capture.frameCount;
    const btx = bmp.getContext("2d");
    if (!btx) return;
    const img = btx.createImageData(bmp.width, bmp.height);
    for (let row = 0; row < capture.frameCount; row++) {
      for (let i = 0; i < capture.fftSize; i++) {
        const db = capture.frames[row * capture.fftSize + i];
        const t = Math.max(0, Math.min(1, (db + 2) / 28));
        const p = (row * bmp.width + i) * 4;
        img.data[p] = Math.round(8 + t * 210);
        img.data[p + 1] = Math.round(16 + t * 200);
        img.data[p + 2] = Math.round(22 + t * 190);
        img.data[p + 3] = 255;
      }
    }
    btx.putImageData(img, 0, 0);
    sheet.current = bmp;
  }, [capture]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let raf = 0;
    let last = 0;
    const draw = (now: number) => {
      if (showTrace && capture && now - last > 48) {
        last = now;
        frame.current = (frame.current + 1) % capture.frameCount;
      }
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const cssW = canvas.clientWidth || 600;
      const cssH = canvas.clientHeight || 116;
      const w = Math.floor(cssW * dpr);
      const h = Math.floor(cssH * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = "#07080c";
      ctx.fillRect(0, 0, cssW, cssH);
      const bmp = sheet.current;
      if (showTrace && capture && bmp) {
        const span = Math.max(1e-6, f2 - f1);
        const x0 = ((capture.loHz / 1e6 - f1) / span) * cssW;
        const x1 = ((capture.hiHz / 1e6 - f1) / span) * cssW;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(bmp, x0, 0, Math.max(1, x1 - x0), cssH);
        const y = ((frame.current + 0.5) / capture.frameCount) * cssH;
        ctx.strokeStyle = "#e9eef7";
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(cssW, y);
        ctx.stroke();
      }
      const mark = markerRef.current;
      if (!showTrace && mark != null && Number.isFinite(mark)) {
        const span = Math.max(1e-6, f2 - f1);
        const x = ((mark - f1) / span) * cssW;
        ctx.strokeStyle = "#f5c16c";
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, cssH);
        ctx.stroke();
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [capture, f1, f2, showTrace]);

  return (
    <section className="cinema-field" aria-label="Водопад частот">
      <canvas ref={ref} className="cinema-field-canvas" role="img" aria-label="Водопад" />
      <div className="cinema-field-meta">
        <span>{f1} МГц</span>
        <span className={live ? "cinema-field-read live" : "cinema-field-read"}>{read}</span>
        <span>{f2} МГц</span>
      </div>
    </section>
  );
}
