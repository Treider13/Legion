// ============================================================================
// LEGION — Фаза 5: дизайн-система LEGION.
// Консоль = кинематографичный HUD-инструмент: 3D RF-СФЕРА как герой,
// дайл-энкодер в скобках LOCK, панели управления, журнал-телетайп.
// (Лендинг-скролл для инструмента заменён на hero-интеграцию в консоль —
//  осознанное решение: это рабочий пульт, а не промо-сайт.)
// ============================================================================
import { lazy, Suspense, useEffect, useState } from "react";
import Lenis from "lenis";

import "./App.css";

import { BootSequence } from "./components/boot/BootSequence";
import { ConnectBar } from "./components/ConnectBar";
import { CorridorPanel } from "./components/CorridorPanel";
import { FrequencyDial } from "./components/console/FrequencyDial";
import { LockBrackets } from "./components/console/LockBrackets";
import { LogPanel } from "./components/LogPanel";
import { PowerPanel } from "./components/PowerPanel";
import { useDeviceTier, prefersReducedMotion } from "./hooks/useDeviceTier";
import { uiClick } from "./sound/sound";
import { useLegion } from "./state/store";
import { rfVisual } from "./three/rfVisual";
import { LiteRadar } from "./three/LiteRadar";

// FULL: 3D-сцена грузится лениво отдельным чанком; LITE: Canvas2D-радар.
// __LEGION_LITE__ — compile-time константа (vite define) → мёртвая ветка
// с dynamic import вырезается Rolldown при lite-сборке.
const Scene = __LEGION_LITE__
  ? null
  : lazy(() =>
      import("./three/Scene").then((m) => ({ default: m.Scene })),
    );

function App() {
  const [booted, setBooted] = useState(false);
  const [mount3d, setMount3d] = useState(false);
  const tier = useDeviceTier();

  // Отложенный монтаж 3D: сначала красим текстовый UI (FCP/LCP), затем WebGL
  // (Lighthouse: LCP 3.8с → цель <2.5с; тяжёлая сцена не блокирует первый кадр)
  useEffect(() => {
    if (!booted) return;
    if ("requestIdleCallback" in window) {
      const id = window.requestIdleCallback(() => setMount3d(true), { timeout: 800 });
      return () => window.cancelIdleCallback(id);
    }
    const t = setTimeout(() => setMount3d(true), 300);
    return () => clearTimeout(t);
  }, [booted]);
  const corridorRunning = useLegion((s) => s.corridorRunning);

  // Мост store → rfVisual (мутируемый объект, без ре-рендеров 3D)
  useEffect(
    () =>
      useLegion.subscribe((s) => {
        rfVisual.freqMhz = parseFloat(s.freqMhz) || 2475;
        rfVisual.lock = s.lock ?? false;
        rfVisual.corridorActive = s.corridorRunning;
        rfVisual.corrF1 = parseFloat(s.corrF1) || 2400;
        rfVisual.corrF2 = parseFloat(s.corrF2) || 2500;
        rfVisual.telemFreqMhz = s.telemFreq;
      }),
    [],
  );

  // Lenis smooth scroll (стандарт 2026; отключён при reduced-motion)
  useEffect(() => {
    if (prefersReducedMotion()) return;
    const lenis = new Lenis({ lerp: 0.11 });
    let raf = 0;
    const loop = (time: number) => {
      lenis.raf(time);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      lenis.destroy();
    };
  }, []);

  // Глобальный звук кнопок (S7)
  useEffect(() => {
    const h = (e: Event) => {
      if ((e.target as HTMLElement).closest("button, select, input")) uiClick();
    };
    document.addEventListener("pointerdown", h);
    return () => document.removeEventListener("pointerdown", h);
  }, []);

  return (
    <div className="legion-root legion-scanlines">
      {!booted && <BootSequence onDone={() => setBooted(true)} />}

      {/* HERO: RF-СФЕРА + дайл в скобках LOCK */}
      <section className="hero">
        <div className="hero-canvas">
          {__LEGION_LITE__ || Scene === null || !mount3d ? (
            <LiteRadar />
          ) : (
            <Suspense fallback={<LiteRadar />}>
              <Scene tier={tier} />
            </Suspense>
          )}
        </div>
        <div className="hero-overlay">
          <header className="hero-header">
            <span className="hero-logo">LEGION</span>
            <span className="hero-sub">УПРАВЛЕНИЕ СИНТЕЗАТОРОМ РЧ // ADF4351</span>
          </header>
          <LockBrackets>
            <FrequencyDial />
          </LockBrackets>
          <div className="hero-corr">
            {corridorRunning ? "ПОДАВЛЕНИЕ АКТИВНО" : "ОЖИДАНИЕ"}
          </div>
        </div>
      </section>

      {/* CONSOLE */}
      <section className="console">
        <ConnectBar />
        <div className="panel-grid">
          <PowerPanel />
          <CorridorPanel />
        </div>
        <LogPanel />
        <footer className="app-footer">
          LEGION v0.1 · ESP32→ADF4351 · 35–4400 МГц · ТОЛЬКО НАГРУЗКА 50Ω
        </footer>
      </section>
    </div>
  );
}

export default App;
