import { useEffect, useRef, useState } from "react";

import type { DemoModeId } from "./modes";
import type { CaptureView } from "./recording";

function mhz(hz: number): string {
  return (hz / 1e6).toLocaleString("ru-RU", {
    minimumFractionDigits: 3,
    maximumFractionDigits: 3,
  });
}

function heat(db: number): [number, number, number] {
  const t = Math.max(0, Math.min(1, (db + 2) / 28));
  const a: [number, number, number] = t < 0.45 ? [8, 14, 28] : [14, 116, 144];
  const b: [number, number, number] = t < 0.45 ? [14, 116, 144] : [233, 238, 247];
  const u = t < 0.45 ? t / 0.45 : (t - 0.45) / 0.55;
  return [
    Math.round(a[0] + (b[0] - a[0]) * u),
    Math.round(a[1] + (b[1] - a[1]) * u),
    Math.round(a[2] + (b[2] - a[2]) * u),
  ];
}

function Ruler({
  lo,
  hi,
  hz,
  markHz,
  caption,
}: {
  lo: number;
  hi: number;
  hz: number;
  markHz?: number;
  caption: string;
}) {
  const span = hi - lo || 1;
  const at = (value: number) => `${Math.min(100, Math.max(0, ((value - lo) / span) * 100))}%`;
  return (
    <div className="demo-stage-pad">
      <p className="demo-big">{mhz(hz)} МГц</p>
      <div className="demo-rule" aria-hidden="true">
        {markHz !== undefined && <span className="demo-mark" style={{ left: at(markHz) }} />}
        <span className="demo-caret" style={{ left: at(hz) }} />
      </div>
      <div className="demo-rule-scale">
        <span>{mhz(lo)}</span>
        <span>{mhz((lo + hi) / 2)}</span>
        <span>{mhz(hi)}</span>
      </div>
      <p className="demo-caption">{caption}</p>
    </div>
  );
}

function hopHz(step: number, lo: number, hi: number): number {
  let x = 1;
  for (let i = 0; i <= step; i++) x = (Math.imul(x, 1103515245) + 12345) >>> 0;
  return lo + ((x % 1000) / 1000) * (hi - lo);
}

export function SeekStage({ capture, progress }: { capture: CaptureView; progress: number }) {
  const hz = capture.loHz + (capture.hiHz - capture.loHz) * progress;
  return (
    <Ruler
      lo={capture.loHz}
      hi={capture.hiHz}
      hz={hz}
      markHz={capture.meta.centerHz}
      caption="Метка — центр снимка. На остальных частотах файла нет."
    />
  );
}

export function WalkStage({
  pattern,
  capture,
}: {
  pattern: "sweep" | "band" | "hop";
  capture: CaptureView;
}) {
  const [hz, setHz] = useState(capture.loHz);
  useEffect(() => {
    const t0 = performance.now();
    let raf = 0;
    let last = 0;
    const tick = (now: number) => {
      if (now - last > 80) {
        last = now;
        const t = now - t0;
        if (pattern === "hop") {
          setHz(hopHz(Math.floor(t / 700), capture.loHz, capture.hiHz));
        } else if (pattern === "band") {
          const p = (t % 8000) / 8000;
          setHz(capture.loHz + p * (capture.hiHz - capture.loHz));
        } else {
          const p = (t % 8000) / 8000;
          const tri = p < 0.5 ? p * 2 : 2 - p * 2;
          setHz(capture.loHz + tri * (capture.hiHz - capture.loHz));
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [pattern, capture]);
  const caption =
    pattern === "sweep"
      ? "Качание: до края и обратно. Сканер выключен."
      : pattern === "band"
        ? "Сплошная: по кругу. Сканер выключен."
        : "Случайная: прыжок раз в 0,7 с. Сканер выключен.";
  return <Ruler lo={capture.loHz} hi={capture.hiHz} hz={hz} caption={caption} />;
}

export function GridStage({ capture, noun }: { capture: CaptureView; noun: string }) {
  const stops = 8;
  const [index, setIndex] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setIndex((n) => (n + 1) % stops), 700);
    return () => window.clearInterval(id);
  }, []);
  const hz = capture.loHz + (index * (capture.hiHz - capture.loHz)) / (stops - 1);
  return (
    <div className="demo-stage-pad">
      <p className="demo-big">{mhz(hz)} МГц</p>
      <div className="demo-grid" aria-hidden="true">
        {Array.from({ length: stops }, (_, i) => (
          <span key={i} className={i === index ? "on" : ""} />
        ))}
      </div>
      <p className="demo-caption">{noun}. Спектр снимка здесь не крутится.</p>
    </div>
  );
}

export function LampStage({ capture, mode }: { capture: CaptureView; mode: DemoModeId }) {
  return (
    <div className="demo-stage-pad">
      <p className="demo-kicker">{mode === "fpga" ? "Плата смотрит сама" : "Энергия канала"}</p>
      <p className="demo-big">{mhz(capture.peakHz)} МГц</p>
      <p className="demo-caption">
        {Math.round(capture.peakDb).toLocaleString("ru-RU")} дБ над серединой спектра этого файла.
        {mode === "fpga"
          ? " Сканер хоста эту ленту не ведёт."
          : " Онбордового обзора в этом режиме нет."}
      </p>
    </div>
  );
}

export function MapStage() {
  return (
    <div className="demo-stage-pad demo-map">
      <svg viewBox="0 0 360 160" role="img" aria-label="Схема пути между двумя точками">
        <path d="M36 128 C 110 24, 230 150, 324 36" />
        <circle cx="36" cy="128" r="7" />
        <circle cx="324" cy="36" r="7" />
        <text x="48" y="124">точка А</text>
        <text x="248" y="32">точка Б</text>
      </svg>
      <p className="demo-caption">Схема пути. Рельеф боевого контура отсюда не считается.</p>
    </div>
  );
}

export function TapeStage({ capture }: { capture: CaptureView }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const specRef = useRef<HTMLCanvasElement>(null);
  const fallRef = useRef<HTMLCanvasElement>(null);
  const bitmap = useRef<HTMLCanvasElement | null>(null);
  const frameRef = useRef(0);

  useEffect(() => {
    const bmp = document.createElement("canvas");
    bmp.width = capture.fftSize;
    bmp.height = capture.frameCount;
    const ctx = bmp.getContext("2d");
    if (!ctx) return;
    const img = ctx.createImageData(bmp.width, bmp.height);
    for (let frame = 0; frame < capture.frameCount; frame++) {
      for (let i = 0; i < capture.fftSize; i++) {
        const [r, g, b] = heat(capture.frames[frame * capture.fftSize + i]);
        const p = (frame * bmp.width + i) * 4;
        img.data[p] = r;
        img.data[p + 1] = g;
        img.data[p + 2] = b;
        img.data[p + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    bitmap.current = bmp;
  }, [capture]);

  useEffect(() => {
    const wrap = wrapRef.current;
    const spec = specRef.current;
    const fall = fallRef.current;
    if (!wrap || !spec || !fall) return;
    const specCtx = spec.getContext("2d");
    const fallCtx = fall.getContext("2d");
    if (!specCtx || !fallCtx) return;

    let raf = 0;
    let last = 0;
    const draw = (now: number) => {
      if (now - last > 48) {
        last = now;
        frameRef.current = (frameRef.current + 1) % capture.frameCount;
      }
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const width = wrap.clientWidth;
      const specH = 168;
      const fallH = 96;
      paintSpectrum(spec, specCtx, width, specH, dpr, capture);
      paintFall(fall, fallCtx, width, fallH, dpr, capture, bitmap.current, frameRef.current);
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [capture]);

  return (
    <div className="demo-tape" ref={wrapRef}>
      <canvas ref={specRef} className="demo-spec" />
      <canvas ref={fallRef} className="demo-fall" />
      <p className="demo-caption">
        Средний спектр и все {capture.frameCount.toLocaleString("ru-RU")} окон записи. Линия — текущее окно.
        Показ замедлен: в файле {((capture.seconds * 1000).toLocaleString("ru-RU", { maximumFractionDigits: 1 }))} мс.
      </p>
    </div>
  );
}

function fit(canvas: HTMLCanvasElement, cssW: number, cssH: number, dpr: number) {
  const w = Math.max(1, Math.floor(cssW * dpr));
  const h = Math.max(1, Math.floor(cssH * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
}

function paintSpectrum(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  cssW: number,
  cssH: number,
  dpr: number,
  capture: CaptureView,
) {
  fit(canvas, cssW, cssH, dpr);
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const yOf = (db: number) => {
    const t = Math.max(0, Math.min(1, (db + 6) / 36));
    return h - 22 * dpr - (1 - t) * (h - 36 * dpr);
  };
  ctx.beginPath();
  const n = capture.avgDb.length;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * w;
    const y = yOf(capture.avgDb[i]);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = "#2dd4bf";
  ctx.lineWidth = Math.max(1, dpr);
  ctx.stroke();

  const peakX = ((capture.peakHz - capture.loHz) / (capture.hiHz - capture.loHz)) * w;
  ctx.strokeStyle = "rgba(233,238,247,0.45)";
  ctx.beginPath();
  ctx.moveTo(peakX, 8 * dpr);
  ctx.lineTo(peakX, h - 16 * dpr);
  ctx.stroke();

  ctx.fillStyle = "#93a0b8";
  ctx.font = `${12 * dpr}px "JetBrains Mono", monospace`;
  ctx.fillText(`${mhz(capture.loHz)} МГц`, 8 * dpr, h - 6 * dpr);
  ctx.fillText(`${mhz(capture.hiHz)} МГц`, w - 92 * dpr, h - 6 * dpr);
}

function paintFall(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  cssW: number,
  cssH: number,
  dpr: number,
  capture: CaptureView,
  bitmap: HTMLCanvasElement | null,
  frame: number,
) {
  fit(canvas, cssW, cssH, dpr);
  ctx.fillStyle = "#080e1c";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (!bitmap) return;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const y = ((frame + 0.5) / capture.frameCount) * canvas.height;
  ctx.strokeStyle = "#e9eef7";
  ctx.lineWidth = Math.max(1, dpr);
  ctx.beginPath();
  ctx.moveTo(0, y);
  ctx.lineTo(canvas.width, y);
  ctx.stroke();
}
