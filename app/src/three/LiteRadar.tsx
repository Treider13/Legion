// ============================================================================
// LEGION — LiteRadar: Canvas2D-запасной вариант RF-СФЕРЫ для lite-сборки
// (ESP32 LittleFS ≤500 КБ — без three.js) и слабых устройств.
// Тот же визуальный язык: круг, луч с хвостом, кольцо коридора, маркер.
// ============================================================================
import { useEffect, useRef } from "react";

import { freqTo01, rfVisual } from "./rfVisual";

export function LiteRadar() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    const dpr = Math.min(2, window.devicePixelRatio || 1);

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
    };
    resize();
    window.addEventListener("resize", resize);

    const draw = (t: number) => {
      const w = canvas.width;
      const h = canvas.height;
      const cx = w / 2;
      const cy = h / 2;
      const R = Math.min(w, h) * 0.42;
      const v = rfVisual;
      const freq =
        v.corridorActive && v.telemFreqMhz !== null ? v.telemFreqMhz : v.freqMhz;

      ctx.clearRect(0, 0, w, h);

      // Концентрические круги
      ctx.strokeStyle = "rgba(212,160,23,0.18)";
      ctx.lineWidth = 1 * dpr;
      for (let i = 1; i <= 4; i++) {
        ctx.beginPath();
        ctx.arc(cx, cy, (R * i) / 4, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Луч с хвостом
      const speed = v.corridorActive ? 2.2 : 0.35;
      const beam = (t / 1000) * speed;
      for (let i = 0; i < 40; i++) {
        const a = beam - i * 0.02;
        const alpha = Math.exp(-i * 0.09) * 0.5;
        ctx.strokeStyle = `rgba(212,160,23,${alpha})`;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
        ctx.stroke();
      }

      // Кольцо коридора
      if (v.corridorActive) {
        const a0 = freqTo01(v.corrF1) * Math.PI * 2 - Math.PI / 2;
        const a1 = freqTo01(v.corrF2) * Math.PI * 2 - Math.PI / 2;
        ctx.strokeStyle = "rgba(212,160,23,0.55)";
        ctx.lineWidth = 3 * dpr;
        ctx.beginPath();
        ctx.arc(cx, cy, R * 1.08, a0, a1);
        ctx.stroke();
      }

      // Маркер частоты
      const am = freqTo01(freq) * Math.PI * 2 - Math.PI / 2;
      const col = v.lock ? "124,255,107" : "212,160,23";
      ctx.strokeStyle = `rgba(${col},0.95)`;
      ctx.lineWidth = 2.5 * dpr;
      ctx.shadowColor = `rgba(${col},0.8)`;
      ctx.shadowBlur = 12 * dpr;
      ctx.beginPath();
      ctx.arc(cx, cy, R * 1.08, am - 0.012, am + 0.012);
      ctx.stroke();
      ctx.shadowBlur = 0;

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return <canvas ref={canvasRef} className="lite-radar" />;
}
