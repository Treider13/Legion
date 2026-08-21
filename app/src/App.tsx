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
import { LogPanel } from "./components/LogPanel";
import { PaPanel } from "./components/PaPanel";
import { Esp32FlashPanel } from "./components/Esp32FlashPanel";
import { ScanPanel } from "./components/ScanPanel";
import { SdrFlashPanel } from "./components/SdrFlashPanel";
import { SdrPanel } from "./components/SdrPanel";
import { SynthPanel } from "./components/SynthPanel";
import { WorkspaceNav } from "./components/WorkspaceNav";
import { modeOf } from "./sense/modes";
import { useDeviceTier, prefersReducedMotion } from "./hooks/useDeviceTier";
import { uiClick } from "./sound/sound";
import { useLegion } from "./state/store";
import { rfVisual } from "./three/rfVisual";
import { LiteEye } from "./three/LiteEye";

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
  const transportKind = useLegion((s) => s.transportKind);
  const sl22 = transportKind === "htool-sl22";

  // Мост store → rfVisual (мутируемый объект, без ре-рендеров 3D)
  useEffect(() => {
    return useLegion.subscribe((s) => {
        rfVisual.freqMhz =
          s.lastForwardMhz ??
          s.lastInterceptMhz ??
          s.scanCenterMhz ??
          (parseFloat(s.freqMhz) || 2475);
        rfVisual.lock = s.lock ?? false;
        rfVisual.corridorActive = s.corridorRunning;
        rfVisual.corrF1 = parseFloat(s.corrF1) || 2400;
        rfVisual.corrF2 = parseFloat(s.corrF2) || 2500;
        rfVisual.telemFreqMhz = s.telemFreq;
        rfVisual.sdrTransmit = s.transmitArmed;
        rfVisual.sdrHitMhz = s.lastInterceptMhz;
        rfVisual.sdrTxMhz = s.lastForwardMhz;
      });
  }, []);

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
          {/* LITE-сборка — Canvas2D-глаз. FULL — сразу 3D CyborgEye без
              промежуточного LiteEye: раньше он мелькал ~1–2 с при отложенном
              монтаже/загрузке чанка и подменялся новым глазом. Пустой fallback
              (null) убирает это мелькание — до готовности 3D просто фон hero. */}
          {__LEGION_LITE__ ? (
            <LiteEye />
          ) : Scene ? (
            <Suspense fallback={null}>{mount3d && <Scene tier={tier} />}</Suspense>
          ) : null}
        </div>
        <div className="hero-overlay">
          <header className="hero-header">
            <span className="hero-logo">LEGION</span>
            <span className="hero-sub">
              {sl22
                ? "УПРАВЛЕНИЕ ГЕНЕРАТОРОМ РЧ // HTOOL SL22"
                : "УПРАВЛЕНИЕ СИНТЕЗАТОРОМ РЧ // ADF4351"}
            </span>
          </header>
          <div className={`hero-status ${transmitArmed || corridorRunning || scanRunning ? "alert" : ""}`}>
            {transmitArmed
              ? "РЕЖИМ SDR · TX → УСИЛИТЕЛЬ"
              : scanRunning
                ? "РЕЖИМ SDR · СКАН"
                : corridorRunning
                  ? "РЕЖИМ ESP32 · КОРИДОР"
                  : "ОЖИДАНИЕ"}
          </div>
        </div>
      </section>

      {/* CONSOLE */}
      <section className="console">
        {modeOf(workspace) === "esp32" ? (
          <ConnectBar />
        ) : (
          <section className="panel connect-bar">
            <span className="panel-title">СВЯЗЬ SDR // ETHERNET — НЕ ESP32</span>
            <span className="panel-note">
              Кабель и IP — вкладка SDR. USB-UART синтезатора в этом режиме нет.
            </span>
          </section>
        )}
        <WorkspaceNav />
        <div className={workspace === "synth" ? "panel-grid" : "panel-grid panel-grid-one"}>
          {workspace === "synth" && <SynthPanel />}
          {workspace === "corridor" && <CorridorPanel />}
          {workspace === "sdr" && <SdrPanel />}
          {workspace === "sdrFlash" && <SdrFlashPanel />}
          {workspace === "scan" && <ScanPanel />}
          {workspace === "pa" && <PaPanel />}
          {workspace === "esp32Flash" && <Esp32FlashPanel />}
        </div>
        <LogPanel />
        <footer className="app-footer">
          {sl22
            ? "LEGION v0.1 · USB HTOOL SL22 · 45–22600 МГц · ТОЛЬКО НАГРУЗКА 50Ω"
            : "LEGION v0.1 · ESP32→ADF4351 · 35–4400 МГц · ТОЛЬКО НАГРУЗКА 50Ω"}
        </footer>
      </section>
    </div>
  );
}

export default App;
