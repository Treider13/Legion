import { lazy, Suspense, useEffect, useMemo, useState } from "react";

import "../App.css";
import "../components/cinema/cinema.css";
import "../components/graphite/graphite.css";
import { BootSequence } from "../components/boot/BootSequence";
import { SceneBoundary } from "../components/SceneBoundary";
import { GraphiteNav } from "../components/graphite/GraphiteChrome";
import { connectionLabel } from "../components/graphite/connectionLabel";
import { useGraphiteMotion } from "../components/graphite/useGraphiteMotion";
import { formatDisplayRange } from "../components/displayRange";
import { heroStatusLine } from "../components/cinema/status";
import { useDeviceTier } from "../hooks/useDeviceTier";
import { catalogById } from "../sdr/catalog";
import { makeSoloWalker, planFpgaSoloWalk } from "../sense/fpgaSoloWalk";
import { modeConflict, patternLabelRu, type SdrWalkPattern } from "../sense/modes";
import { DemoGate } from "./DemoGate";
import { DemoScope, DemoWaterfall } from "./DemoScope";
import { DemoSettings, type DemoWorkspace } from "./DemoSettings";
import { slidesFor, type DemoModeId } from "./modes";
import type { CaptureView } from "./recording";
import { useCue } from "./useCue";
import { DEMO_ESP_DRAW_MS, DEMO_LOOK_MHZ, espSweepNext, hostTxWalker, isOpenLoop } from "./walk";

const Scene = lazy(() => import("../three/Scene").then((m) => ({ default: m.Scene })));

const ESP32_TABS = new Set(["synth", "corridor", "pa", "esp32Flash"]);

export function DemoShell({ capture, onExit }: { capture: CaptureView | null; onExit: () => void }) {
  const { rootRef, motion, reduced, toggleMotion } = useGraphiteMotion();
  const tier = useDeviceTier();
  const [booted, setBooted] = useState(false);
  const [mount3d, setMount3d] = useState(false);
  const [gate, setGate] = useState(false);
  const [settings, setSettings] = useState(false);
  const [acceptNote, setAcceptNote] = useState(() => {
    try { return !window.localStorage.getItem("legion.demo.acceptanceNoteSeen"); } catch { return false; }
  });
  const [mode, setMode] = useState<"sdr" | "esp32">("sdr");
  const [workspace, setWorkspace] = useState<DemoWorkspace>("scan");
  const [pattern, setPattern] = useState<SdrWalkPattern>("auto");
  const [scanning, setScanning] = useState(false);
  const [transmitArmed, setTransmitArmed] = useState(false);
  const [fpgaArmed, setFpgaArmed] = useState(false);
  const [fpgaMode, setFpgaMode] = useState("lb_gated");
  const [corridorRunning, setCorridorRunning] = useState(false);
  const [f1, setF1] = useState(capture ? String(capture.loHz / 1e6) : "96");
  const [f2, setF2] = useState(capture ? String(capture.hiHz / 1e6) : "104");
  const [lookText, setLookText] = useState(String(DEMO_LOOK_MHZ));
  const [walkMhz, setWalkMhz] = useState<number | null>(null);
  const [startPath, setStartPath] = useState<"auto" | "air" | "solo" | "esp32" | null>(null);
  const [refuse, setRefuse] = useState("");

  useEffect(() => {
    if (!capture) return;
    setF1(String(capture.loHz / 1e6));
    setF2(String(capture.hiHz / 1e6));
    setScanning(true);
  }, [capture]);

  useEffect(() => {
    if (!booted) return;
    if ("requestIdleCallback" in window) {
      const id = window.requestIdleCallback(() => setMount3d(true), { timeout: 800 });
      return () => window.cancelIdleCallback(id);
    }
    const t = setTimeout(() => setMount3d(true), 300);
    return () => clearTimeout(t);
  }, [booted]);

  const board = catalogById("bladerf-micro-xa4");
  const link = connectionLabel(board?.iface);
  const analog = board?.analogBwMhz ?? 56;
  const connection = mode === "sdr" ? link : { value: "USB", note: "ESP32 · подключение USB" };
  const lo = parseFloat(f1);
  const hi = parseFloat(f2);
  const lookRaw = parseFloat(lookText);
  const lookMhz = Number.isFinite(lookRaw) && lookRaw > 0 ? lookRaw : DEMO_LOOK_MHZ;
  const range = Number.isFinite(lo) && Number.isFinite(hi) ? { f1: lo, f2: hi } : null;
  const center = range ? (range.f1 + range.f2) / 2 : 100;
  const hostRx = Boolean(capture && pattern === "auto" && mode === "sdr" && !fpgaArmed && (scanning || transmitArmed));
  const showTrace = hostRx;
  const rxMhz = hostRx && capture ? capture.peakHz / 1e6 : null;
  const openLoop = mode === "sdr" && !fpgaArmed && transmitArmed && isOpenLoop(pattern);
  const solo = mode === "sdr" && fpgaArmed && fpgaMode === "nco";
  const corridorDraw = mode === "esp32" && corridorRunning;
  const live = scanning || transmitArmed || corridorRunning || fpgaArmed;

  useEffect(() => {
    const bandOk = Number.isFinite(lo) && Number.isFinite(hi) && hi >= lo && lo > 0;
    if (corridorDraw && bandOk) {
      let cur = lo;
      setWalkMhz(cur);
      const id = window.setInterval(() => {
        cur = espSweepNext(cur, lo, hi);
        setWalkMhz(cur);
      }, DEMO_ESP_DRAW_MS);
      return () => window.clearInterval(id);
    }
    if (solo && bandOk) {
      const plan = planFpgaSoloWalk({
        f1Mhz: lo,
        f2Mhz: hi,
        windowMhz: lookMhz,
        analogMaxMhz: analog,
        pattern: "sweep",
        wave: "tone",
      });
      if (!plan.ok || plan.centers.length === 0) {
        setWalkMhz(null);
        return;
      }
      const walker = makeSoloWalker(plan, 1);
      const step = () => {
        const next = walker.next().centerMhz;
        if (next) setWalkMhz(next);
      };
      step();
      if (!plan.hop) return;
      const id = window.setInterval(step, plan.dwellMs);
      return () => window.clearInterval(id);
    }
    if (openLoop && bandOk && isOpenLoop(pattern)) {
      const walker = hostTxWalker(pattern, lo, hi, lookMhz, analog);
      const step = () => {
        const next = walker.next().centerMhz;
        if (next) setWalkMhz(next);
      };
      step();
      const id = window.setInterval(step, walker.tickMs);
      return () => window.clearInterval(id);
    }
    setWalkMhz(null);
  }, [analog, corridorDraw, hi, lo, lookMhz, openLoop, pattern, solo]);

  const moving = openLoop || solo || corridorDraw ? walkMhz : null;
  const hero = heroStatusLine({
    scanRunning: hostRx && !transmitArmed,
    transmitArmed: transmitArmed && !fpgaArmed,
    corridorRunning,
    signalTxActive: false,
    fpgaArmed,
    fpgaBusy: false,
    fpgaMode,
    fpgaStatus: null,
    lastForwardMhz: solo || openLoop ? (moving ?? center) : transmitArmed ? (rxMhz ?? center) : null,
    lastInterceptMhz: rxMhz,
    scanCenterMhz: hostRx ? center : null,
    telemFreq: corridorDraw ? moving : null,
    freqMhz: String(moving ?? rxMhz ?? center),
  });

  const cueId: DemoModeId | "wait" = showTrace
    ? "attack"
    : openLoop && isOpenLoop(pattern)
      ? pattern
      : solo
        ? "solo"
        : corridorDraw
          ? "esp32"
          : fpgaArmed
            ? startPath === "air" ? "air" : "fpga"
            : "wait";

  const attackSlides = useMemo(() => {
    const wait = [{
      key: "wait",
      kicker: "Помощник",
      title: "Ждёт сигнал",
      text: "Когда в эфире появится след, здесь по очереди будут его тип и совет. Каждый шаг держится 4 секунды.",
      why: "",
      freqMhz: null as number | null,
      typeLabel: null as string | null,
    }];
    if (!capture || cueId === "wait") return wait;
    const peak = capture.peakHz / 1e6;
    return slidesFor(cueId, capture).map((slide) => ({
      key: slide.key,
      kicker: slide.kicker,
      title: slide.title,
      text: slide.text,
      why: "",
      freqMhz: cueId === "attack" ? peak : null,
      typeLabel: cueId === "attack" ? "энергия" : null,
    }));
  }, [capture, cueId]);

  const [cuePaused, setCuePaused] = useState(false);
  const cue = useCue(attackSlides, cuePaused, cueId);
  const slide = attackSlides.find((item) => item.key === cue.key) ?? attackSlides[0];

  const read = showTrace && rxMhz != null
    ? `${rxMhz.toFixed(3)} МГц · ${transmitArmed ? "RX → TX · на усилитель" : "водопад · слушает"}`
    : moving != null && solo
      ? `${moving.toFixed(3)} МГц · FPGA · тон`
      : moving != null && corridorDraw
        ? `${moving.toFixed(3)} МГц · коридор`
        : moving != null && openLoop
          ? `${moving.toFixed(3)} МГц · на усилитель`
          : fpgaArmed
            ? `${center.toFixed(3)} МГц · нет телеметрии гейта`
            : "—";

  const whisper = refuse
    ? refuse
    : solo && moving != null
      ? `Только FPGA: тон ${moving.toFixed(3)} МГц по сетке. На плату команда не уходит.`
      : fpgaArmed
        ? "Умная атака / эфир: хост-сканер не в круге. Платы нет — гейт без телеметрии, ретрансляцию не рисуем."
        : hostRx && transmitArmed && rxMhz != null
          ? `RX поймал ${rxMhz.toFixed(3)} МГц в снимке. TX несёт эту частоту.`
          : hostRx && rxMhz != null
            ? `Снимок уже на сканере. RX видит ${rxMhz.toFixed(3)} МГц. «Передать» ставит её на TX.`
            : openLoop && moving != null && isOpenLoop(pattern)
              ? `${patternLabelRu(pattern)}: TX ${moving.toFixed(3)} МГц, шаг ${lookMhz} МГц. Сканер не участвует. На плату команда не уходит.`
              : corridorDraw && moving != null
                ? `ESP32: синтезатор ${moving.toFixed(3)} МГц, шаг 1 МГц. На рисунке шаг 200 мс (в прошивке 10 мс). По USB команда не уходит.`
                : "Запустить → коридор → умная атака, эфир+FPGA или только FPGA.";

  const openWorkspace = (id: DemoWorkspace) => {
    setWorkspace(id);
    setMode(ESP32_TABS.has(id) ? "esp32" : "sdr");
    setSettings(true);
  };

  return (
    <div ref={rootRef} className="legion-root cinema graphite" data-motion={motion ? "on" : "off"} data-contour="demo">
      {!booted && <BootSequence onDone={() => setBooted(true)} />}
      <section className="hero" id="graphite-overview">
        <div className="graphite-backdrop" aria-hidden="true" />
        <div className="hero-canvas">
          <SceneBoundary>
            <Suspense fallback={null}>{mount3d && !settings && <Scene tier={tier} graphite={{ motion }} />}</Suspense>
          </SceneBoundary>
        </div>
        <div className="hero-overlay">
          <header className="hero-header">
            <span className="hero-logo">ЛЕГИОН</span>
            <GraphiteNav
              onSettings={() => setSettings(true)}
              onPosition={() => openWorkspace("position")}
              motion={motion}
              reduced={reduced}
              onMotion={toggleMotion}
            />
            <span className="hero-sub">{connection.value}</span>
          </header>
          <div className="graphite-hero-caption" aria-hidden="true">РАДИО<br />ТЕХНОЛОГИИ<br />НАБЛЮДЕНИЕ<br />АНАЛИЗ</div>
          <div className={`hero-status st-${hero.kind}`} role="status" aria-live="polite">
            <span>{hero.text}</span>
            {hero.detail && <span className="hero-status-detail">{hero.detail}</span>}
          </div>
        </div>
      </section>

      <section className="graphite-console" id="graphite-spectrum" aria-label="Спектр и история">
        <header className="graphite-console-heading">
          <h1>СПЕКТР</h1>
          <span>СПЕКТРАЛЬНЫЙ АНАЛИЗАТОР</span>
          <span className="graphite-console-source">{connection.value}</span>
        </header>
        <div className="graphite-stats">
          <div className="graphite-stat">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" aria-hidden="true">
              <path d="M12 13v7m-3 0h6M8.5 15a5 5 0 0 1 0-7M15.5 8a5 5 0 0 1 0 7M5.5 18a9 9 0 0 1 0-13M18.5 5a9 9 0 0 1 0 13" />
              <circle cx="12" cy="11.5" r="1.5" />
            </svg>
            <div>
              <span className="graphite-stat-label">Подключение</span>
              <span className="graphite-stat-value">{connection.value}</span>
            </div>
            <small>{connection.note}</small>
          </div>
          <div className="graphite-stat">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" aria-hidden="true">
              <path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M9 9h6v6H9z" />
            </svg>
            <div>
              <span className="graphite-stat-label">Диапазон</span>
              <span className="graphite-stat-value">{formatDisplayRange(range)}</span>
            </div>
            <small>границы F1–F2</small>
          </div>
          <div className="graphite-stat">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" aria-hidden="true">
              <path d="M5 18V7m7 11V4m7 14v-8" />
            </svg>
            <div>
              <span className="graphite-stat-label">Сигнал</span>
              <span className="graphite-stat-value">{slide.typeLabel ?? "нет сигнала"}</span>
            </div>
            <small>{slide.freqMhz != null ? `${slide.freqMhz.toFixed(3)} МГц` : "ожидание"}</small>
          </div>
        </div>
        <section
          className={cuePaused ? "graphite-assist is-paused" : "graphite-assist"}
          aria-live="polite"
          aria-atomic="true"
          aria-label="Советы помощника"
          data-cue-key={slide.key}
          onMouseEnter={() => setCuePaused(true)}
          onMouseLeave={() => setCuePaused(false)}
        >
          <div className="graphite-assist-kicker">
            <span>Помощник</span>
            <span>{slide.kicker}</span>
          </div>
          <div key={slide.key} className="graphite-assist-body">
            <h2>{slide.title}</h2>
            <p>{slide.text}</p>
          </div>
          {attackSlides.length > 1 && (
            <div className="graphite-assist-side">
              <div className="graphite-assist-dots">
                {attackSlides.map((item, n) => (
                  <button key={item.key} type="button" className={item.key === slide.key ? "on" : ""} aria-label={`Шаг ${n + 1}: ${item.title}`} aria-current={item.key === slide.key ? "step" : undefined} />
                ))}
              </div>
            </div>
          )}
          {attackSlides.length > 1 && <span key={`meter-${slide.key}`} className="graphite-assist-meter" aria-hidden="true" />}
        </section>
        <div className="graphite-spectrum">
          <DemoScope f1={lo} f2={hi} capture={capture} showTrace={showTrace} scanning={showTrace} markerMhz={showTrace ? null : moving} />
        </div>
        <section className="graphite-history" id="graphite-history" aria-label="История спектра">
          <header>
            <span>История спектра</span>
            <small>Штатное отображение данных</small>
          </header>
          <DemoWaterfall f1={lo} f2={hi} capture={capture} showTrace={showTrace} read={read} live={live} markerMhz={showTrace ? null : moving} />
        </section>
      </section>

      {acceptNote && mode === "sdr" && (
        <div className="cinema-accept" role="note">
          <span>
            Перед боевым применением прогоните стендовую приёмку E1–E6 на своей плате
            (INSTALL.md §6, fpga/test/run_acceptance_and_commit.sh) — без зелёного прогона
            стабильность системы не гарантируется.
          </span>
          <button type="button" className="cinema-btn ghost" onClick={() => {
            try { window.localStorage.setItem("legion.demo.acceptanceNoteSeen", "1"); } catch { /* без персиста */ }
            setAcceptNote(false);
          }}>Понятно</button>
        </div>
      )}

      <footer className="cinema-dock">
        <div className="cinema-modes" role="group" aria-label="Режим">
          <button type="button" className={mode === "sdr" ? "cinema-mode on" : "cinema-mode"} onClick={() => { if (!live) { setMode("sdr"); setWorkspace("scan"); } }}>
            Умный<span>{connection.value === "USB" ? "USB 3.0" : link.value}</span>
          </button>
          <button type="button" className={mode === "esp32" ? "cinema-mode on" : "cinema-mode"} onClick={() => { if (!live) { setMode("esp32"); setWorkspace("corridor"); } }}>
            Простой<span>ESP32 · USB</span>
          </button>
        </div>
        <div className="cinema-go-row">
          {live ? (
            <button type="button" className="cinema-go stop" onClick={() => { setScanning(false); setFpgaArmed(false); setCorridorRunning(false); setTransmitArmed(false); setRefuse(""); }}>Стоп</button>
          ) : (
            <button type="button" className="cinema-go" onClick={() => setGate(true)}>Запустить</button>
          )}
          {transmitArmed ? (
            <button type="button" className="cinema-go stop" onClick={() => { setTransmitArmed(false); setRefuse(""); }}>Стоп передачу</button>
          ) : (
            <button type="button" className="cinema-go" onClick={() => {
              const blocked = modeConflict("sdr", corridorRunning, false, fpgaArmed);
              if (fpgaArmed) {
                setRefuse("ПЕРЕДАТЬ: FPGA ARM занял USB — сначала Стоп. Это хост-путь, не круг платы.");
                return;
              }
              if (blocked) {
                setRefuse(blocked);
                return;
              }
              setRefuse("");
              setTransmitArmed(true);
            }}>Передать</button>
          )}
        </div>
        <div className="cinema-dock-end">
          <p className="cinema-whisper" title={whisper}>{whisper}</p>
          <button type="button" className="cinema-btn ghost" onClick={onExit}>К выбору</button>
          <button type="button" className="cinema-btn ghost" onClick={() => setSettings(true)}>Настройки</button>
        </div>
      </footer>

      {gate && (
        <DemoGate
          mode={mode}
          f1={f1}
          f2={f2}
          onClose={() => setGate(false)}
          onRun={(run) => {
            setF1(run.f1);
            setF2(run.f2);
            setGate(false);
            setTransmitArmed(false);
            setRefuse("");
            setStartPath(run.path);
            if (run.path === "esp32") {
              setCorridorRunning(true);
              setScanning(false);
              setFpgaArmed(false);
              return;
            }
            if (run.path === "solo") {
              setFpgaArmed(true);
              setFpgaMode("nco");
              setScanning(false);
              return;
            }
            setFpgaArmed(true);
            setFpgaMode("lb_gated");
            setScanning(false);
          }}
        />
      )}
      {settings && (
        <DemoSettings
          mode={mode}
          workspace={workspace}
          pattern={pattern}
          scanning={scanning}
          onWorkspace={openWorkspace}
          lookText={lookText}
          busy={live}
          onLook={setLookText}
          onPattern={(next) => {
            setPattern(next);
            setScanning(false);
            if (next === "fpga") setTransmitArmed(false);
          }}
          onScan={() => setScanning((value) => !value)}
          onClose={() => setSettings(false)}
        />
      )}
    </div>
  );
}
