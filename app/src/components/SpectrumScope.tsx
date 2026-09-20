// LEGION — анализатор спектра коридора. Ось F1…F2, не растянутое текущее окно.
// Следы: live Welch, peak/min (qspectrumanalyzer), persistence (линейный fade),
// полка 120 с (poc). FPGA даёт взгляд+гейт, не выдуманный FFT.
import { useEffect, useRef, useState } from "react";

import { allocAtMhz, bandsInSpan } from "../sense/labAlloc";
import { PersistentDisplay } from "../sense/labPersist2d";
import { finiteDbm, strongestFinite, subtractBaseline, width3dbMhz } from "../sense/labPsd";
import { dbmToUnit, heatRgb } from "../sense/waterfall";
import { useLegion } from "../state/store";
import { displayRange, displayRangeNotice, formatDisplayRange, formatFrequency, frequencyTicks } from "./displayRange";

function yOf(dbm: number, lo: number, hi: number, top: number, h: number): number {
  const t = (dbm - lo) / Math.max(hi - lo, 1e-6);
  return top + (1 - Math.min(1, Math.max(0, t))) * h;
}

export function SpectrumScope() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [readout, setReadout] = useState("наведите — частота и дБм");
  const readoutRef = useRef(readout);
  readoutRef.current = readout;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let raf = 0;
    let alive = true;
    let cursorX = -1;
    const rtsa = new PersistentDisplay(320, 140);
    const rtsaCanvas = document.createElement("canvas");
    rtsaCanvas.width = rtsa.width;
    rtsaCanvas.height = rtsa.height;
    const rtsaCtx = rtsaCanvas.getContext("2d");
    const rtsaImg = rtsaCtx ? rtsaCtx.createImageData(rtsa.width, rtsa.height) : null;
    let lastRtsaSrc: readonly { freqMhz: number; powerDbm: number }[] | null = null;
    let lastAxisKey = "";

    const draw = () => {
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
        if (lastAxisKey) rtsa.reset();
        lastAxisKey = "";
        lastRtsaSrc = null;
        ctx.fillStyle = "rgba(232,228,220,0.62)";
        ctx.font = "12px ui-monospace, monospace";
        ctx.textAlign = "center";
        ctx.fillText(notice ?? "Укажите корректные F1 и F2", cssW / 2, cssH / 2);
        if (readoutRef.current !== "Коридор не задан") setReadout("Коридор не задан");
        raf = requestAnimationFrame(draw);
        return;
      }
      const { f1: loF, f2: hiF } = range;
      const span = hiF - loF;
      if (readoutRef.current === "Коридор не задан") setReadout("наведите — частота и дБм");

      const padL = 62;
      const padR = 22;
      const padT = 20;
      const padB = 43;
      const plotW = Math.max(8, cssW - padL - padR);
      const plotH = Math.max(8, cssH - padT - padB);
      const xOf = (mhz: number) => padL + ((mhz - loF) / span) * plotW;

      const live = st.labSubtractBaseline
        ? subtractBaseline(st.labPsd.composite, st.labPsd.baseline)
        : st.labPsd.composite.length
          ? st.labPsd.composite
          : st.scanBins;
      const peak = st.labPsd.peakHold;
      const minH = st.labPsd.minHold;
      const persist = st.labPsd.persistence;
      const base = st.labPsd.baseline;

      const samples: number[] = [];
      for (const row of [live, peak, minH, base]) {
        for (const b of row) if (finiteDbm(b.powerDbm)) samples.push(b.powerDbm);
      }
      let dbLo = st.labSubtractBaseline ? -20 : -120;
      let dbHi = st.labSubtractBaseline ? 40 : -20;
      if (samples.length) {
        dbLo = Math.min(...samples) - 6;
        dbHi = Math.max(...samples) + 4;
        if (dbHi - dbLo < 20) dbHi = dbLo + 20;
      }

      const axisKey = `${loF}:${hiF}:${live.length}`;
      if (axisKey !== lastAxisKey) {
        rtsa.reset();
        lastAxisKey = axisKey;
        lastRtsaSrc = null;
      }
      const rtsaSrc = st.labPsd.composite.length ? st.labPsd.composite : live;
      if (st.labShowRtsa && rtsaImg && rtsaCtx && rtsaSrc.some((b) => finiteDbm(b.powerDbm))) {
        // pavsa: PersistentDisplay.drawSpectrumFloat на каждый новый DatasetSpectrum,
        // не «только если пик сменился» — иначе EMA не гаснет на стоянке.
        if (rtsaSrc !== lastRtsaSrc) {
          const y0 = st.labSubtractBaseline ? -120 : dbLo;
          const y1 = st.labSubtractBaseline ? -20 : dbHi;
          rtsa.push(rtsaSrc, y0, y1, Date.now());
          rtsa.renderRgba(rtsaImg.data);
          rtsaCtx.putImageData(rtsaImg, 0, 0);
          lastRtsaSrc = rtsaSrc;
        }
        ctx.globalAlpha = 0.88;
        ctx.drawImage(rtsaCanvas, padL, padT, plotW, plotH);
        ctx.globalAlpha = 1;
      }

      if (st.labShowPersistence && persist.length) {
        for (let i = 0; i < persist.length; i++) {
          if (!finiteDbm(persist[i].powerDbm)) continue;
          const x0 = i === 0 ? xOf(persist[i].freqMhz) : xOf((persist[i - 1].freqMhz + persist[i].freqMhz) / 2);
          const x1 =
            i + 1 < persist.length ? xOf((persist[i].freqMhz + persist[i + 1].freqMhz) / 2) : xOf(persist[i].freqMhz);
          const [cr, cg, cb] = heatRgb(dbmToUnit(persist[i].powerDbm));
          ctx.fillStyle = `rgba(${cr},${cg},${cb},0.38)`;
          const y = yOf(persist[i].powerDbm, dbLo, dbHi, padT, plotH);
          ctx.fillRect(x0, y, Math.max(x1 - x0, 1), padT + plotH - y);
        }
      }

      const gridDb = 10;
      const firstDb = Math.ceil(dbLo / gridDb) * gridDb;
      ctx.font = "10px ui-monospace, JetBrains Mono, monospace";
      for (let db = firstDb; db <= dbHi + 1e-9; db += gridDb) {
        const y = yOf(db, dbLo, dbHi, padT, plotH);
        ctx.strokeStyle = "rgba(232,228,220,0.14)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(padL, y);
        ctx.lineTo(padL + plotW, y);
        ctx.stroke();
        ctx.fillStyle = "rgba(232,228,220,0.58)";
        ctx.textAlign = "right";
        ctx.fillText(`${db.toFixed(0)}`, padL - 6, y + 3);
      }

      const leftLabel = formatFrequency(loF);
      const rightLabel = formatFrequency(hiF);
      const leftWidth = ctx.measureText(leftLabel).width;
      const rightWidth = ctx.measureText(rightLabel).width;
      for (const f of frequencyTicks(range, plotW)) {
        const x = xOf(f);
        ctx.strokeStyle = "rgba(232,228,220,0.10)";
        ctx.beginPath();
        ctx.moveTo(x, padT);
        ctx.lineTo(x, padT + plotH);
        ctx.stroke();
        ctx.fillStyle = "rgba(232,228,220,0.5)";
        ctx.textAlign = "center";
        const label = formatFrequency(f);
        const halfWidth = ctx.measureText(label).width / 2;
        if (x - halfWidth > padL + leftWidth + 10 && x + halfWidth < padL + plotW - rightWidth - 10) {
          ctx.fillText(label, x, cssH - 24);
        }
      }
      ctx.fillStyle = "rgba(232,228,220,0.7)";
      ctx.textAlign = "left";
      ctx.fillText(leftLabel, padL, cssH - 24);
      ctx.textAlign = "right";
      ctx.fillText(rightLabel, padL + plotW, cssH - 24);

      // Fine subdivisions and axis titles are presentation only.
      ctx.save();
      ctx.strokeStyle = "rgba(190,204,214,0.10)";
      ctx.setLineDash([1, 4]);
      ctx.beginPath();
      for (let i = 1; i < 50; i++) {
        const x = padL + plotW * i / 50;
        ctx.moveTo(x, padT); ctx.lineTo(x, padT + plotH);
      }
      for (let i = 1; i < 40; i++) {
        const y = padT + plotH * i / 40;
        ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y);
      }
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = "rgba(198,210,219,0.75)";
      ctx.textAlign = "center";
      ctx.fillText("Частота (МГц)", padL + plotW / 2, cssH - 7);
      ctx.save();
      ctx.translate(13, padT + plotH / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText(st.labSubtractBaseline ? "Уровень относительно полки (дБ)" : "Уровень (дБм)", 0, 0);
      ctx.restore();
      ctx.save();
      ctx.beginPath();
      ctx.rect(padL, padT, plotW, plotH);
      ctx.clip();

      if (st.labShowAlloc) {
        const allocs = bandsInSpan(loF, hiF);
        ctx.globalAlpha = 0.22;
        for (const band of allocs) {
          const x0 = Math.max(padL, xOf(band.f1Mhz));
          const x1 = Math.min(padL + plotW, xOf(band.f2Mhz));
          if (x1 - x0 < 1) continue;
          ctx.fillStyle = "rgba(245,193,108,0.35)";
          ctx.fillRect(x0, padT + plotH - 7, Math.max(x1 - x0, 1), 7);
        }
        ctx.globalAlpha = 1;
      }

      const strokeBins = (bins: typeof live, color: string, width: number, dash: number[] = []) => {
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
          const y = yOf(b.powerDbm, dbLo, dbHi, padT, plotH);
          if (!started) {
            ctx.moveTo(x, y);
            started = true;
          } else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.setLineDash([]);
      };

      if (st.labShowMin && minH.length) strokeBins(minH, "rgba(45,212,191,0.35)", 1);
      if (st.labShowBaseline && base.some((b) => finiteDbm(b.powerDbm))) {
        strokeBins(base, "rgba(232,228,220,0.45)", 1.1, [4, 3]);
      }
      ctx.fillStyle = "rgba(45,212,191,0.14)";
      ctx.beginPath();
      let fillStarted = false;
      let fillX = padL;
      for (const b of live) {
        if (!finiteDbm(b.powerDbm)) {
          if (fillStarted) {
            ctx.lineTo(fillX, padT + plotH);
            ctx.lineTo(padL, padT + plotH);
            ctx.closePath();
            ctx.fill();
            ctx.beginPath();
            fillStarted = false;
          }
          continue;
        }
        const x = xOf(b.freqMhz);
        const y = yOf(b.powerDbm, dbLo, dbHi, padT, plotH);
        if (!fillStarted) {
          ctx.moveTo(x, padT + plotH);
          ctx.lineTo(x, y);
          fillStarted = true;
          fillX = x;
        } else {
          ctx.lineTo(x, y);
          fillX = x;
        }
      }
      if (fillStarted) {
        ctx.lineTo(fillX, padT + plotH);
        ctx.closePath();
        ctx.fill();
      }
      strokeBins(live, "#2dd4bf", 1.6);
      if (st.labShowPeak && peak.length) strokeBins(peak, "#f5c16c", 1.25);

      const peakBin = strongestFinite(live);
      if (peakBin && live.length >= 3) {
        const w3 = width3dbMhz(live, peakBin.freqMhz);
        if (w3 > 0) {
          const x0 = xOf(peakBin.freqMhz - w3 / 2);
          const x1 = xOf(peakBin.freqMhz + w3 / 2);
          ctx.strokeStyle = "rgba(245,193,108,0.7)";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x0, yOf(peakBin.powerDbm - 3, dbLo, dbHi, padT, plotH));
          ctx.lineTo(x1, yOf(peakBin.powerDbm - 3, dbLo, dbHi, padT, plotH));
          ctx.stroke();
        }
      }

      for (const ev of st.labEvents.slice(-24)) {
        const x = xOf(ev.freqMhz);
        ctx.fillStyle = ev.source === "fpga-gate" ? "rgba(255,168,136,0.9)" : "rgba(94,242,160,0.85)";
        ctx.beginPath();
        ctx.moveTo(x, padT + 2);
        ctx.lineTo(x - 3, padT + 8);
        ctx.lineTo(x + 3, padT + 8);
        ctx.closePath();
        ctx.fill();
      }

      if (st.fpgaArmed) {
        const mhz = st.fpgaStatus?.freq_mhz ?? st.lastForwardMhz;
        const look = Math.max(parseFloat(st.fpgaAirBwMhz) || 2, 0.2);
        if (mhz != null) {
          const x0 = Math.max(padL, xOf(mhz - look / 2));
          const x1 = Math.min(padL + plotW, xOf(mhz + look / 2));
          ctx.fillStyle = st.fpgaStatus?.det_active ? "rgba(255,168,136,0.14)" : "rgba(232,228,220,0.06)";
          ctx.fillRect(x0, padT, Math.max(x1 - x0, 2), plotH);
        }
      } else if (st.scanCenterMhz != null && st.scanRunning) {
        const bins = st.scanBins;
        const half =
          bins.length >= 2 ? Math.abs(bins[bins.length - 1].freqMhz - bins[0].freqMhz) / 2 : (parseFloat(st.scanWindowMhz) || 20) / 2;
        const x0 = Math.max(padL, xOf(st.scanCenterMhz - half));
        const x1 = Math.min(padL + plotW, xOf(st.scanCenterMhz + half));
        ctx.fillStyle = "rgba(45,212,191,0.06)";
        ctx.fillRect(x0, padT, Math.max(x1 - x0, 2), plotH);
      }

      if (cursorX >= padL && cursorX <= padL + plotW) {
        const mhz = loF + ((cursorX - padL) / plotW) * span;
        ctx.strokeStyle = "rgba(236,230,218,0.35)";
        ctx.beginPath();
        ctx.moveTo(cursorX, padT);
        ctx.lineTo(cursorX, padT + plotH);
        ctx.stroke();
        let nearest = live.reduce<{ freqMhz: number; powerDbm: number } | null>((acc, b) => {
          if (!finiteDbm(b.powerDbm)) return acc;
          if (!acc || Math.abs(b.freqMhz - mhz) < Math.abs(acc.freqMhz - mhz)) return b;
          return acc;
        }, null);
        const dbm = nearest && Math.abs(nearest.freqMhz - mhz) < span / Math.max(live.length, 8) ? nearest.powerDbm : null;
        const alloc = st.labShowAlloc ? allocAtMhz(mhz) : null;
        const text =
          dbm != null
            ? `${formatFrequency(mhz, span / plotW)} МГц · ${dbm.toFixed(1)} дБм${alloc ? ` · ${alloc.name}` : ""}`
            : `${formatFrequency(mhz, span / plotW)} МГц · нет бина${alloc ? ` · ${alloc.name}` : ""}`;
        if (text !== readoutRef.current) setReadout(text);
      }

      ctx.restore();
      ctx.strokeStyle = "rgba(232,228,220,0.12)";
      ctx.strokeRect(padL + 0.5, padT + 0.5, plotW - 1, plotH - 1);

      if (!live.some((b) => finiteDbm(b.powerDbm))) {
        ctx.fillStyle = "rgba(232,228,220,0.62)";
        ctx.font = "12px ui-monospace, JetBrains Mono, monospace";
        ctx.textAlign = "center";
        const msg = st.fpgaArmed
          ? "Спектральные данные от источника не поступают"
          : "Ожидание данных";
        ctx.fillText(msg, padL + plotW / 2, padT + plotH / 2);
      }

      raf = requestAnimationFrame(draw);
    };

    const onMove = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      cursorX = e.clientX - r.left;
    };
    const onLeave = () => {
      cursorX = -1;
      setReadout("наведите — частота и дБм");
    };
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerleave", onLeave);
    raf = requestAnimationFrame(draw);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerleave", onLeave);
    };
  }, []);

  const st = useLegion();
  const range = displayRange(st);
  const live = st.scanRunning || st.fpgaArmed;
  const peak = strongestFinite(st.labSubtractBaseline ? subtractBaseline(st.labPsd.composite, st.labPsd.baseline) : st.labPsd.composite);
  const w3 = peak ? width3dbMhz(st.labPsd.composite, peak.freqMhz) : 0;

  return (
    <div className="scope-wrap" aria-label="Анализатор спектра xA4">
      <div className="scope-toolbar">
        <span className={live ? "scope-live on" : "scope-live"}>
          {st.fpgaArmed ? "FPGA · взгляд" : st.scanRunning ? "Welch · хост" : "холст"}
        </span>
        <label>
          <input type="checkbox" checked={st.labShowPeak} onChange={(e) => st.setLabShowPeak(e.target.checked)} />
          peak
        </label>
        <label>
          <input type="checkbox" checked={st.labShowMin} onChange={(e) => st.setLabShowMin(e.target.checked)} />
          min
        </label>
        <label>
          <input type="checkbox" checked={st.labShowPersistence} onChange={(e) => st.setLabShowPersistence(e.target.checked)} />
          persist
        </label>
        <label>
          <input type="checkbox" checked={st.labShowBaseline} onChange={(e) => st.setLabShowBaseline(e.target.checked)} />
          полка
        </label>
        <label>
          <input
            type="checkbox"
            checked={st.labSubtractBaseline}
            onChange={(e) => st.setLabSubtractBaseline(e.target.checked)}
          />
          −полка
        </label>
        <label>
          <input type="checkbox" checked={st.labShowRtsa} onChange={(e) => st.setLabShowRtsa(e.target.checked)} />
          RTSA
        </label>
        <label>
          <input type="checkbox" checked={st.labShowAlloc} onChange={(e) => st.setLabShowAlloc(e.target.checked)} />
          EFIS
        </label>
        <label>
          <input type="checkbox" checked={st.labSpurOn} onChange={(e) => st.setLabSpurOn(e.target.checked)} />
          шпоры{st.labSpurOn && !st.labSpurReady ? " · калибровка" : ""}
        </label>
        <button type="button" className="btn-ghost" onClick={() => st.resetLabHolds()}>
          СБРОС HOLD
        </button>
      </div>
      <canvas ref={canvasRef} className="scope-canvas" role="img" aria-label={`PSD · ${formatDisplayRange(range)}`} />
      <div className="scope-meta">
        <span>{displayRangeNotice(range) ?? readout}</span>
        <span>
          {peak
            ? `пик ${peak.freqMhz.toFixed(3)} · ${peak.powerDbm.toFixed(1)} дБм · 3дБ ${w3.toFixed(2)} МГц`
            : "пик —"}
          {st.labCoverage != null ? ` · занятость ${(st.labCoverage * 100).toFixed(1)} %` : ""}
        </span>
      </div>
    </div>
  );
}
