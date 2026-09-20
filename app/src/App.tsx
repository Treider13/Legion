// ============================================================================
// LEGION — главный кадр: 3D-глаз (не трогаем Scene/CyborgEye), полоса частот,
// один старт. Лаборатория — за Настройки.
// ============================================================================
import { lazy, Suspense, useEffect, useState } from "react";

import "./App.css";
import "./components/cinema/cinema.css";
import "./components/graphite/graphite.css";
import { GraphiteConsole, GraphiteNav } from "./components/graphite/GraphiteChrome";
import { useGraphiteMotion } from "./components/graphite/useGraphiteMotion";
import { SpectrumScope } from "./components/SpectrumScope";

import { BootSequence } from "./components/boot/BootSequence";
import { CinemaDock } from "./components/cinema/CinemaDock";
import { FrequencyField } from "./components/cinema/FrequencyField";
import { SettingsSheet } from "./components/cinema/SettingsSheet";
import { StartGate } from "./components/cinema/StartGate";
import { coolingWarn, heroStatusLine } from "./components/cinema/status";
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
  const { rootRef, motion, reduced, toggleMotion } = useGraphiteMotion();
  const [booted, setBooted] = useState(false);
  const [mount3d, setMount3d] = useState(false);
  const [gate, setGate] = useState(false);
  const [settings, setSettings] = useState(false);
  // Одноразовая заметка про стендовую приёмку: приложение не может знать,
  // прогонял ли оператор E1–E6 на своей плате — честно напоминаем один раз
  // (персист в localStorage; без него — просто не показываем).
  const [acceptNote, setAcceptNote] = useState(() => {
    try {
      return !window.localStorage.getItem("legion.acceptanceNoteSeen");
    } catch {
      return false;
    }
  });
  const dismissAcceptNote = () => {
    try {
      window.localStorage.setItem("legion.acceptanceNoteSeen", "1");
    } catch {
      // без персиста заметка вернётся при следующем запуске — допустимо
    }
    setAcceptNote(false);
  };
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
  const signalTxActive = useLegion((s) => s.signalTxActive);
  const fpgaArmed = useLegion((s) => s.fpgaArmed);
  const fpgaBusy = useLegion((s) => s.fpgaBusy);
  const fpgaMode = useLegion((s) => s.fpgaMode);
  const fpgaStatus = useLegion((s) => s.fpgaStatus);
  const lastForwardMhz = useLegion((s) => s.lastForwardMhz);
  const lastInterceptMhz = useLegion((s) => s.lastInterceptMhz);
  const scanCenterMhz = useLegion((s) => s.scanCenterMhz);
  const telemFreq = useLegion((s) => s.telemFreq);
  const freqMhz = useLegion((s) => s.freqMhz);
  const sdrF1 = useLegion((s) => s.sdrF1);
  const sdrF2 = useLegion((s) => s.sdrF2);
  // Idle-частота по контексту режима: в SDR — центр рабочего коридора,
  // в ESP32 — поле синтезатора. Иначе в SDR idle показывалась бы частота
  // чужого тракта (ADF4351), не имеющая отношения к плате bladeRF.
  const idleFreqMhz =
    mode === "sdr"
      ? String(((parseFloat(sdrF1) || 2400) + (parseFloat(sdrF2) || 2500)) / 2)
      : freqMhz;
  const hero = heroStatusLine({
    scanRunning,
    transmitArmed,
    corridorRunning,
    signalTxActive,
    fpgaArmed,
    fpgaBusy,
    fpgaMode,
    fpgaStatus,
    lastForwardMhz,
    lastInterceptMhz,
    scanCenterMhz,
    telemFreq,
    freqMhz: idleFreqMhz,
  });
  const cooling = coolingWarn({ fpgaArmed, fpgaStatus });

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
    <div ref={rootRef} className="legion-root cinema graphite" data-motion={motion ? "on" : "off"}>
      {!booted && <BootSequence onDone={() => setBooted(true)} />}

      <section className="hero" id="graphite-overview">
        <div className="graphite-backdrop" aria-hidden="true" />
        <div className="hero-canvas">
          {__LEGION_LITE__ ? (
            <LiteEye />
          ) : Scene ? (
            <Suspense fallback={null}>{mount3d && <Scene tier={tier} graphite={{ motion }} />}</Suspense>
          ) : null}
        </div>
        <div className="hero-overlay">
          <header className="hero-header">
            <span className="hero-logo">ЛЕГИОН</span>
            <GraphiteNav onSettings={() => setSettings(true)} motion={motion} reduced={reduced} onMotion={toggleMotion} />
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
          <div className="graphite-hero-caption" aria-hidden="true">РАДИО<br/>ТЕХНОЛОГИИ<br/>НАБЛЮДЕНИЕ<br/>АНАЛИЗ</div>
          <div className={`hero-status st-${hero.kind}`} role="status" aria-live="polite">
            <span>{hero.text}</span>
            {hero.detail && <span className="hero-status-detail">{hero.detail}</span>}
          </div>
        </div>
      </section>

      <GraphiteConsole
        source={mode === "sdr" ? (sl22 ? "SDR" : "SDR · Ethernet") : (sl22 ? "HTOOL SL22" : "ESP32 · USB")}
        range={mode === "sdr" ? `${sdrF1}–${sdrF2} МГц` : "По настройкам режима"}
        motion={motion}
        lite={__LEGION_LITE__}
        spectrum={mode === "sdr" ? <SpectrumScope /> : undefined}
        history={<FrequencyField />}
      />

      {cooling && (
        <div className="cinema-warn" role="alert">
          <span>ОХЛАЖДЕНИЕ: {cooling}</span>
        </div>
      )}

      {acceptNote && mode === "sdr" && (
        <div className="cinema-accept" role="note">
          <span>
            Перед боевым применением прогоните стендовую приёмку E1–E6 на своей плате
            (INSTALL.md §6, fpga/test/run_acceptance_and_commit.sh) — без зелёного прогона
            стабильность системы не гарантируется.
          </span>
          <button type="button" className="cinema-btn ghost" onClick={dismissAcceptNote}>
            Понятно
          </button>
        </div>
      )}

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
