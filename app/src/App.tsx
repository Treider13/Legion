// ============================================================================
// LEGION — главный кадр: 3D-глаз (не трогаем Scene/CyborgEye), полоса частот,
// один старт. Лаборатория — за Настройки.
// ============================================================================
import { lazy, Suspense, useEffect, useState } from "react";

import "./App.css";
import "./components/cinema/cinema.css";

import { BootSequence } from "./components/boot/BootSequence";
import { CinemaDock } from "./components/cinema/CinemaDock";
import { FrequencyField } from "./components/cinema/FrequencyField";
import { SettingsSheet } from "./components/cinema/SettingsSheet";
import { StartGate } from "./components/cinema/StartGate";
import { modeOf } from "./sense/modes";
import { useDeviceTier } from "./hooks/useDeviceTier";
import { uiClick } from "./sound/sound";
import { useLegion } from "./state/store";
import { rfVisual } from "./three/rfVisual";
import { LiteEye } from "./three/LiteEye";

const Scene = __LEGION_LITE__
  ? null
  : lazy(() =>
      import("./three/Scene").then((m) => ({ default: m.Scene })),
    );

function App() {
  const [booted, setBooted] = useState(false);
  const [mount3d, setMount3d] = useState(false);
  const [gate, setGate] = useState(false);
  const [settings, setSettings] = useState(false);
  const tier = useDeviceTier();
  const workspace = useLegion((s) => s.workspace);
  const mode = modeOf(workspace);
  const setWorkspace = useLegion((s) => s.setWorkspace);
  const transportKind = useLegion((s) => s.transportKind);
  const sl22 = transportKind === "htool-sl22";

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
  const scanRunning = useLegion((s) => s.scanRunning);
  const transmitArmed = useLegion((s) => s.transmitArmed);
  const fpgaArmed = useLegion((s) => s.fpgaArmed);
  const fpgaMode = useLegion((s) => s.fpgaMode);

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
      rfVisual.sdrTransmit = s.transmitArmed || s.fpgaArmed;
      rfVisual.sdrHitMhz = s.fpgaArmed ? null : s.lastInterceptMhz;
      rfVisual.sdrTxMhz = s.fpgaArmed ? null : s.lastForwardMhz;
      if (s.fpgaArmed) {
        // Не host-FFT. Показать припаркованный LO, не дефолт 2475.
        rfVisual.freqMhz = s.lastForwardMhz ?? (parseFloat(s.signalFreqMhz) || 2475);
      }
    });
  }, []);

  useEffect(() => {
    const h = (e: Event) => {
      if ((e.target as HTMLElement).closest("button, select, input")) uiClick();
    };
    document.addEventListener("pointerdown", h);
    return () => document.removeEventListener("pointerdown", h);
  }, []);

  return (
    <div className="legion-root cinema">
      {!booted && <BootSequence onDone={() => setBooted(true)} />}

      <section className="hero">
        <div className="hero-canvas">
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
              {mode === "sdr"
                ? sl22
                  ? "SDR"
                  : "SDR · Ethernet"
                : sl22
                  ? "HTOOL SL22"
                  : "ESP32 · USB"}
            </span>
          </header>
          <div className={`hero-status ${transmitArmed || corridorRunning || scanRunning || fpgaArmed ? "alert" : ""}`}>
            {fpgaArmed
              ? fpgaMode === "lb_gated"
                ? "РЕЖИМ SDR · FPGA+СКАНЕР · НАБЛЮДЕНИЕ"
                : "РЕЖИМ SDR · FPGA · ЗАДАЧА С НОУТБУКА"
              : transmitArmed
                ? "РЕЖИМ SDR · TX → УСИЛИТЕЛЬ"
                : scanRunning
                  ? "РЕЖИМ SDR · СКАН"
                  : corridorRunning
                    ? "РЕЖИМ ESP32 · КОРИДОР"
                    : "ОЖИДАНИЕ"}
          </div>
        </div>
      </section>

      <FrequencyField />

      <CinemaDock
        mode={mode}
        onMode={(m) => setWorkspace(m === "sdr" ? "scan" : "corridor")}
        onStart={() => setGate(true)}
        onSettings={() => setSettings(true)}
      />

      {gate && <StartGate mode={mode} onClose={() => setGate(false)} />}
      {settings && <SettingsSheet onClose={() => setSettings(false)} />}
    </div>
  );
}

export default App;
