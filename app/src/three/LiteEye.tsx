// ============================================================================
// LEGION — LiteEye: ПРОСТОЙ глаз на Canvas2D для lite-сборки (ESP32, LittleFS
// ≤500 КБ, без three.js) и слабых устройств. Никаких эффектов/свечения —
// только белок, радужка, зрачок, блик; в боевом режиме краснеет и бегает.
// ============================================================================
import { useEffect, useRef } from "react";

import { rfVisual } from "./rfVisual";

export function LiteEye() {
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

    // Состояние взгляда (простое, без физики)
    const s = { x: 0, y: 0, tx: 0, ty: 0, next: 0 };

    const draw = (tms: number) => {
      const t = tms / 1000;
      const w = canvas.width;
      const h = canvas.height;
      const cx = w / 2;
      const cy = h / 2;
      const R = Math.min(w, h) * 0.32;
      const alert = rfVisual.corridorActive;

      // выбор новой цели взгляда
      if (t > s.next) {
        const range = alert ? 0.5 : 0.18;
        s.tx = (Math.random() * 2 - 1) * range;
        s.ty = (Math.random() * 2 - 1) * range * 0.7;
        s.next = t + (alert ? 0.25 + Math.random() * 0.35 : 1.6 + Math.random() * 2.0);
      }
      const sp = alert ? 0.25 : 0.06;
      s.x += (s.tx - s.x) * sp;
      s.y += (s.ty - s.y) * sp;

      ctx.clearRect(0, 0, w, h);

      // белок
      ctx.fillStyle = "#0c1017";
      ctx.fillRect(0, 0, w, h);
      ctx.beginPath();
      ctx.ellipse(cx, cy, R * 1.55, R * 1.05, 0, 0, Math.PI * 2);
      ctx.fillStyle = "#c9ccd2";
      ctx.fill();

      // радужка
      const ix = cx + s.x * R;
      const iy = cy + s.y * R;
      const iris = alert ? "#d81f14" : "#2dbfb0";
      ctx.beginPath();
      ctx.arc(ix, iy, R * 0.62, 0, Math.PI * 2);
      ctx.fillStyle = iris;
      ctx.fill();

      // лимбальное кольцо
      ctx.lineWidth = Math.max(1, R * 0.05);
      ctx.strokeStyle = alert ? "#6b0d08" : "#0f5b54";
      ctx.stroke();

      // зрачок (в бою сужается)
      ctx.beginPath();
      ctx.arc(ix, iy, R * (alert ? 0.2 : 0.3), 0, Math.PI * 2);
      ctx.fillStyle = "#050608";
      ctx.fill();

      // блик
      ctx.beginPath();
      ctx.arc(ix - R * 0.18, iy - R * 0.2, R * 0.09, 0, Math.PI * 2);
      ctx.fillStyle = "#ffffff";
      ctx.fill();

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
