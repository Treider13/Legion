// LEGION — анализатор спектра коридора. Ось F1…F2, не растянутое текущее окно.
// Следы: live Welch, peak/min (qspectrumanalyzer), persistence (линейный fade),
// полка 120 с (poc). FPGA даёт взгляд+гейт, не выдуманный FFT.
import { useEffect, useRef, useState } from "react";

import { allocAtMhz, bandsInSpan } from "../sense/labAlloc";
import { PersistentDisplay } from "../sense/labPersist2d";
import { finiteDbm, strongestFinite, subtractBaseline, width3dbMhz } from "../sense/labPsd";
import { normalizePaint } from "../sense/attackPaint";
import { focusAdvisorTrack, trackUnderMhz } from "./graphite/advisorFocus";
import { angelRgb } from "../sense/angelPalette";
import { requestSpectrumPaint } from "../sense/spectrumPaintClient";
import { SDRANGEL_FRAME_MS } from "../sense/spectrumPaint";
import { SDRANGEL_TRACE, sdrangelColorIndex, type SdrangelScale } from "../sense/waterfall";
import { useLegion, visibleDetectMhz } from "../state/store";
import { displayRange, displayRangeNotice, formatDisplayRange, formatFrequency, frequencyTicks } from "./displayRange";

function yOf(dbm: number, lo: number, hi: number, top: number, h: number): number {
  const t = (dbm - lo) / Math.max(hi - lo, 1e-6);
  return top + (1 - Math.min(1, Math.max(0, t))) * h;
}

export function SpectrumScope() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [readout, setReadout] = useState("наведите — частота и относительный уровень");
  const readoutRef = useRef(readout);
  readoutRef.current = readout;
  const geomRef = useRef({ padL: 62, plotW: 1, loF: 0, span: 1 });
  const brushRef = useRef<{ down: boolean; a: number }>({ down: false, a: 0 });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let timer = 0;
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
    const persistCanvas = document.createElement("canvas");
    const persistCtx = persistCanvas.getContext("2d");
    let lastPersistGeom = "";
    const emptyScale: SdrangelScale = { refDb: 0, rangeDb: 100, floorDb: -100 };
    const cache: {
      gen: number;
      scale: SdrangelScale;
      live: Float32Array | null;
      peak: Float32Array | null;
      min: Float32Array | null;
      base: Float32Array | null;
      persist: Float32Array | null;
      peakBin: { freqMhz: number; powerDbm: number } | null;
      w3: number;
      range: string;
    } = {
      gen: 0,
      scale: emptyScale,
      live: null,
      peak: null,
      min: null,
      base: null,
      persist: null,
      peakBin: null,
      w3: 0,
      range: "",
    };
    const none: readonly { freqMhz: number; powerDbm: number }[] = [];
    let postedLive = none;
    let postedPeak = none;
    let postedMin = none;
    let postedBase = none;
    let postedPersist = none;
    let postedGeom = "";
    let inflightLive = none;
    let inflightPeak = none;
    let inflightMin = none;
    let inflightBase = none;
    let inflightPersist = none;
    let inflightGeom = "";
    let subSrc: readonly { freqMhz: number; powerDbm: number }[] | null = null;
    let subBase: readonly { freqMhz: number; powerDbm: number }[] | null = null;
    let subLive: readonly { freqMhz: number; powerDbm: number }[] = none;

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
        return;
      }
      const { f1: loF, f2: hiF } = range;
      const span = hiF - loF;
      if (readoutRef.current === "Коридор не задан") setReadout("наведите — частота и относительный уровень");

      const padL = 62;
      const padR = 22;
      const padT = 20;
      const padB = 43;
      const plotW = Math.max(8, cssW - padL - padR);
      const plotH = Math.max(8, cssH - padT - padB);
      const xOf = (mhz: number) => padL + ((mhz - loF) / span) * plotW;
      geomRef.current = { padL, plotW, loF, span };

      const liveSrc = st.labPsd.composite.length ? st.labPsd.composite : st.scanBins;
      const peak = st.labPsd.peakHold;
      const minH = st.labPsd.minHold;
      const persist = st.labPsd.persistence;
      const base = st.labPsd.baseline;
      let live: readonly { freqMhz: number; powerDbm: number }[] = liveSrc;
      if (st.labSubtractBaseline) {
        if (liveSrc !== subSrc || base !== subBase) {
          subLive = subtractBaseline(liveSrc, base);
          subSrc = liveSrc;
          subBase = base;
        }
        live = subLive;
      }
      const cols = Math.max(64, Math.min(1600, Math.round(plotW)));
      const geomToken = `${loF}:${hiF}:${cols}:${st.labSubtractBaseline ? 1 : 0}`;
      const isPosted =
        live === postedLive &&
        peak === postedPeak &&
        minH === postedMin &&
        base === postedBase &&
        persist === postedPersist &&
        geomToken === postedGeom;
      const isInflight =
        live === inflightLive &&
        peak === inflightPeak &&
        minH === inflightMin &&
        base === inflightBase &&
        persist === inflightPersist &&
        geomToken === inflightGeom;
      if (!isPosted && !isInflight) {
        inflightLive = live;
        inflightPeak = peak;
        inflightMin = minH;
        inflightBase = base;
        inflightPersist = persist;
        inflightGeom = geomToken;
        const liveHas = live.some((b) => finiteDbm(b.powerDbm));
        const scaleSrc = liveHas ? live : [...peak, ...minH, ...base];
        const traces = liveHas ? [live, peak, minH, base, persist] : [scaleSrc, live, peak, minH, base, persist];
        const liveAt = liveHas ? 0 : 1;
        const sentLive = live;
        const sentPeak = strongestFinite(sentLive);
        const sentW3 = sentPeak && sentLive.length >= 3 ? width3dbMhz(sentLive, sentPeak.freqMhz) : 0;
        requestSpectrumPaint({ f1: loF, f2: hiF, cols, traces, waterfall: null }, (result) => {
          if (!alive || inflightGeom !== geomToken || inflightLive !== sentLive) return;
          if (!result || !result.scales[0]) {
            inflightGeom = "";
            return;
          }
          postedLive = sentLive;
          postedPeak = peak;
          postedMin = minH;
          postedBase = base;
          postedPersist = persist;
          postedGeom = geomToken;
          cache.gen += 1;
          cache.scale = result.scales[0];
          cache.live = result.columns[liveAt] ?? null;
          cache.peak = result.columns[liveAt + 1] ?? null;
          cache.min = result.columns[liveAt + 2] ?? null;
          cache.base = result.columns[liveAt + 3] ?? null;
          cache.persist = result.columns[liveAt + 4] ?? null;
          cache.peakBin = sentPeak;
          cache.w3 = sentW3;
          cache.range = `${loF}:${hiF}`;
        });
      }
      if (cache.range !== `${loF}:${hiF}`) {
        cache.live = null;
        cache.peak = null;
        cache.min = null;
        cache.base = null;
        cache.persist = null;
      }
      const scale = cache.scale;
      let dbLo = scale.floorDb;
      let dbHi = scale.refDb;

      const axisKey = `${loF}:${hiF}:${live.length}`;
      if (axisKey !== lastAxisKey) {
        rtsa.reset();
        lastAxisKey = axisKey;
        lastRtsaSrc = null;
      }
      const rtsaSrc = st.labPsd.composite.length ? st.labPsd.composite : live;
      if (st.labShowRtsa && rtsaImg && rtsaCtx) {
        // pavsa: PersistentDisplay.drawSpectrumFloat на каждый новый DatasetSpectrum,
        // не «только если пик сменился» — иначе EMA не гаснет на стоянке.
        if (rtsaSrc !== lastRtsaSrc) {
          lastRtsaSrc = rtsaSrc;
          if (rtsaSrc.some((b) => finiteDbm(b.powerDbm))) {
            const y0 = st.labSubtractBaseline ? -120 : dbLo;
            const y1 = st.labSubtractBaseline ? -20 : dbHi;
            rtsa.push(rtsaSrc, y0, y1, Date.now());
            rtsa.renderRgba(rtsaImg.data);
            rtsaCtx.putImageData(rtsaImg, 0, 0);
          }
        }
        ctx.globalAlpha = 0.88;
        ctx.drawImage(rtsaCanvas, padL, padT, plotW, plotH);
        ctx.globalAlpha = 1;
      }

      const persistCols = cache.persist;
      if (st.labShowPersistence && persistCols && persistCtx) {
        const pw = Math.max(1, Math.floor(plotW * dpr));
        const ph = Math.max(1, Math.floor(plotH * dpr));
        const geom = `${cache.gen}:${loF}:${hiF}:${pw}:${ph}:${dbLo}:${dbHi}`;
        if (geom !== lastPersistGeom) {
          if (persistCanvas.width !== pw || persistCanvas.height !== ph) {
            persistCanvas.width = pw;
            persistCanvas.height = ph;
          }
          persistCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
          persistCtx.clearRect(0, 0, plotW, plotH);
          const n = persistCols.length;
          for (let i = 0; i < n; i++) {
            const db = persistCols[i]!;
            if (!Number.isFinite(db)) continue;
            const x0 = (i / n) * plotW;
            const x1 = ((i + 1) / n) * plotW;
            const [cr, cg, cb] = angelRgb(sdrangelColorIndex(db, dbHi, dbHi - dbLo));
            persistCtx.fillStyle = `rgba(${cr},${cg},${cb},0.38)`;
            const y = yOf(db, dbLo, dbHi, 0, plotH);
            persistCtx.fillRect(x0, y, Math.max(x1 - x0, 1), Math.max(plotH - y, 0));
          }
          lastPersistGeom = geom;
        }
        ctx.drawImage(persistCanvas, padL, padT, plotW, plotH);
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
      ctx.fillText(st.labSubtractBaseline ? "Уровень относительно полки (дБ)" : "Относительный уровень (дБ)", 0, 0);
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
          const x = padL + ((i + 0.5) / n) * plotW;
          const y = yOf(db, dbLo, dbHi, padT, plotH);
          if (!started) {
            ctx.moveTo(x, y);
            started = true;
          } else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.setLineDash([]);
      };

      if (st.labShowMin) strokeCols(cache.min, "rgba(45,212,191,0.35)", 1);
      if (st.labShowBaseline) strokeCols(cache.base, "rgba(232,228,220,0.45)", 1.1, [4, 3]);
      strokeCols(cache.live, SDRANGEL_TRACE, 1.4);
      const detectMhz = visibleDetectMhz(st.smartGridAccepted, st.attackTracks);
      if (detectMhz.length > 0) {
        ctx.lineWidth = 1;
        ctx.font = "10px ui-monospace, JetBrains Mono, monospace";
        ctx.textAlign = "center";
        for (const mhz of detectMhz) {
          if (mhz < loF || mhz > hiF) continue;
          const x = xOf(mhz);
          ctx.strokeStyle = SDRANGEL_TRACE;
          ctx.beginPath();
          ctx.moveTo(x, padT);
          ctx.lineTo(x, padT + plotH);
          ctx.stroke();
          if (detectMhz.length <= 12) {
            ctx.fillStyle = SDRANGEL_TRACE;
            ctx.fillText(mhz.toFixed(3), x, padT + 11);
          }
        }
      }
      if (st.labShowPeak) strokeCols(cache.peak, "#f5c16c", 1.25);

      const peakBin = cache.peakBin;
      if (peakBin && cache.w3 > 0) {
        const w3 = cache.w3;
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

      if (st.scanPattern === "auto") {
        for (const t of st.attackTracks) {
          if (t.state === "cooled") continue;
          const x0 = Math.max(padL, xOf(t.fLowMhz));
          const x1 = Math.min(padL + plotW, xOf(t.fHighMhz));
          ctx.fillStyle =
            t.state === "held"
              ? "rgba(245,193,108,0.16)"
              : t.state === "confirmed"
                ? "rgba(94,242,160,0.12)"
                : "rgba(232,228,220,0.06)";
          ctx.fillRect(x0, padT, Math.max(x1 - x0, 2), plotH);
        }
        const paint = st.attackPaintDraft ?? st.attackPaint;
        const suggest = !st.attackPaintDraft && !st.attackPaint ? st.attackSuggestPaint : null;
        if (suggest) {
          const x0 = Math.max(padL, xOf(suggest.f1Mhz));
          const x1 = Math.min(padL + plotW, xOf(suggest.f2Mhz));
          ctx.strokeStyle = "rgba(245,193,108,0.7)";
          ctx.lineWidth = 1.2;
          ctx.setLineDash([4, 4]);
          ctx.strokeRect(x0 + 0.5, padT + 0.5, Math.max(x1 - x0, 3) - 1, plotH - 1);
          ctx.setLineDash([]);
        }
        if (paint) {
          const x0 = Math.max(padL, xOf(paint.f1Mhz));
          const x1 = Math.min(padL + plotW, xOf(paint.f2Mhz));
          ctx.fillStyle = st.attackPaintDraft ? "rgba(255,168,136,0.10)" : "rgba(255,168,136,0.18)";
          ctx.fillRect(x0, padT, Math.max(x1 - x0, 3), plotH);
          ctx.strokeStyle = "rgba(255,168,136,0.85)";
          ctx.lineWidth = 1.4;
          ctx.setLineDash(st.attackPaintDraft ? [5, 4] : []);
          ctx.strokeRect(x0 + 0.5, padT + 0.5, Math.max(x1 - x0, 3) - 1, plotH - 1);
          ctx.setLineDash([]);
        }
      }

      if (cursorX >= padL && cursorX <= padL + plotW) {
        const mhz = loF + ((cursorX - padL) / plotW) * span;
        ctx.strokeStyle = "rgba(236,230,218,0.35)";
        ctx.beginPath();
        ctx.moveTo(cursorX, padT);
        ctx.lineTo(cursorX, padT + plotH);
        ctx.stroke();
        const liveCols = cache.live;
        let dbm: number | null = null;
        if (liveCols && liveCols.length > 0) {
          const i = Math.min(liveCols.length - 1, Math.max(0, Math.floor(((mhz - loF) / span) * liveCols.length)));
          const sample = liveCols[i]!;
          if (Number.isFinite(sample)) dbm = sample;
        }
        const alloc = st.labShowAlloc ? allocAtMhz(mhz) : null;
        const text =
          dbm != null
            ? `${formatFrequency(mhz, span / plotW)} МГц · ${dbm.toFixed(1)} дБ (отн.)${alloc ? ` · ${alloc.name}` : ""}`
            : `${formatFrequency(mhz, span / plotW)} МГц · нет бина${alloc ? ` · ${alloc.name}` : ""}`;
        if (text !== readoutRef.current) setReadout(text);
      }

      ctx.restore();
      ctx.strokeStyle = "rgba(232,228,220,0.12)";
      ctx.strokeRect(padL + 0.5, padT + 0.5, plotW - 1, plotH - 1);

      if (!cache.live || !cache.live.some((db) => Number.isFinite(db))) {
        ctx.fillStyle = "rgba(232,228,220,0.62)";
        ctx.font = "12px ui-monospace, JetBrains Mono, monospace";
        ctx.textAlign = "center";
        const msg = st.fpgaArmed
          ? "Спектральные данные от источника не поступают"
          : "Ожидание данных";
        ctx.fillText(msg, padL + plotW / 2, padT + plotH / 2);
      }
    };

    const mhzAt = (clientX: number): number => {
      const r = canvas.getBoundingClientRect();
      const x = clientX - r.left;
      const g = geomRef.current;
      const t = g.plotW > 0 ? (x - g.padL) / g.plotW : 0;
      return g.loF + Math.min(1, Math.max(0, t)) * g.span;
    };
    const onMove = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      cursorX = e.clientX - r.left;
      const st = useLegion.getState();
      if (brushRef.current.down) {
        if (st.scanPattern === "auto") {
          st.setAttackPaintDraft(normalizePaint(brushRef.current.a, mhzAt(e.clientX)));
        }
        return;
      }
      if (st.scanPattern !== "auto") return;
      const g = geomRef.current;
      if (cursorX < g.padL || cursorX > g.padL + g.plotW) return;
      const pxPerMhz = g.span > 0 ? g.plotW / g.span : 0;
      const hit = trackUnderMhz(st.attackTracks, mhzAt(e.clientX), pxPerMhz, 2);
      if (hit) focusAdvisorTrack(hit.id, hit.freqMhz);
    };
    const onDown = (e: PointerEvent) => {
      const st = useLegion.getState();
      if (st.scanPattern !== "auto" || st.fpgaArmed || st.transmitArmed) return;
      if (e.button !== 0) return;
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      const a = mhzAt(e.clientX);
      brushRef.current = { down: true, a };
      st.setAttackPaintDraft(normalizePaint(a, a));
    };
    const onUp = (e: PointerEvent) => {
      if (!brushRef.current.down) return;
      const st = useLegion.getState();
      brushRef.current.down = false;
      if (st.scanPattern === "auto") {
        st.setAttackPaint(normalizePaint(brushRef.current.a, mhzAt(e.clientX)));
      }
      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch {
        /* capture already gone */
      }
    };
    const onLeave = () => {
      if (brushRef.current.down) return;
      cursorX = -1;
      setReadout("наведите — частота и относительный уровень");
    };
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);
    canvas.addEventListener("pointerleave", onLeave);
    const frame = () => {
      if (!alive) return;
      draw();
      if (alive) timer = window.setTimeout(frame, SDRANGEL_FRAME_MS);
    };
    timer = window.setTimeout(frame, 0);
    return () => {
      alive = false;
      window.clearTimeout(timer);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      canvas.removeEventListener("pointerleave", onLeave);
    };
  }, []);

  // displayRange() builds a new object per call; zustand v5 selectors must return stable values.
  const f1 = useLegion((s) => displayRange(s)?.f1 ?? null);
  const f2 = useLegion((s) => displayRange(s)?.f2 ?? null);
  const range = f1 != null && f2 != null ? { f1, f2 } : null;
  const st = {
    scanRunning: useLegion((s) => s.scanRunning),
    fpgaArmed: useLegion((s) => s.fpgaArmed),
    scanPattern: useLegion((s) => s.scanPattern),
    labPsd: useLegion((s) => s.labPsd),
    labCoverage: useLegion((s) => s.labCoverage),
    labShowPeak: useLegion((s) => s.labShowPeak),
    labShowMin: useLegion((s) => s.labShowMin),
    labShowPersistence: useLegion((s) => s.labShowPersistence),
    labShowBaseline: useLegion((s) => s.labShowBaseline),
    labSubtractBaseline: useLegion((s) => s.labSubtractBaseline),
    labShowRtsa: useLegion((s) => s.labShowRtsa),
    labShowAlloc: useLegion((s) => s.labShowAlloc),
    labSpurOn: useLegion((s) => s.labSpurOn),
    labSpurReady: useLegion((s) => s.labSpurReady),
    setLabShowPeak: useLegion((s) => s.setLabShowPeak),
    setLabShowMin: useLegion((s) => s.setLabShowMin),
    setLabShowPersistence: useLegion((s) => s.setLabShowPersistence),
    setLabShowBaseline: useLegion((s) => s.setLabShowBaseline),
    setLabSubtractBaseline: useLegion((s) => s.setLabSubtractBaseline),
    setLabShowRtsa: useLegion((s) => s.setLabShowRtsa),
    setLabShowAlloc: useLegion((s) => s.setLabShowAlloc),
    setLabSpurOn: useLegion((s) => s.setLabSpurOn),
    resetLabHolds: useLegion((s) => s.resetLabHolds),
  };
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
      <canvas
        ref={canvasRef}
        className={st.scanPattern === "auto" ? "scope-canvas attack-brush" : "scope-canvas"}
        role="img"
        aria-label={`PSD · относительный уровень, дБ · ${formatDisplayRange(range)}${st.scanPattern === "auto" ? " · рамка Атаки мышкой" : ""}`}
      />
      <div className="scope-meta">
        <span>{displayRangeNotice(range) ?? readout}</span>
        <span title="Относительный уровень цифровых отсчётов; абсолютная мощность в дБм не подтверждена">
          {peak
            ? `пик ${peak.freqMhz.toFixed(3)} · ${peak.powerDbm.toFixed(1)} дБ (отн.) · 3дБ ${w3.toFixed(2)} МГц`
            : "пик —"}
          {st.labCoverage != null ? ` · занятость ${(st.labCoverage * 100).toFixed(1)} %` : ""}
        </span>
      </div>
    </div>
  );
}
