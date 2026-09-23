import { useEffect, useMemo, useState } from "react";

import { GridStage, LampStage, MapStage, SeekStage, TapeStage, WalkStage } from "./DemoStage";
import { DEMO_MODES, modeById, slidesFor, stageFor, type DemoModeId } from "./modes";
import { loadCapture, sourceHref, type CaptureView } from "./recording";
import { useCue } from "./useCue";
import "./demo.css";

export function DemoApp({ onExit }: { onExit: () => void }) {
  const [capture, setCapture] = useState<CaptureView | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const prev = document.title;
    document.title = "ЛЕГИОН — демо";
    return () => {
      document.title = prev;
    };
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    loadCapture(ac.signal).then(setCapture).catch((err: unknown) => {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError(err instanceof Error ? err.message : "снимок не открылся");
    });
    return () => ac.abort();
  }, []);

  return (
    <div className="demo-root" data-contour="demo">
      <header className="demo-top">
        <div>
          <p className="demo-brand">ЛЕГИОН</p>
          <p className="demo-kicker">Демо · снимок, не плата</p>
        </div>
        <button type="button" className="demo-exit" onClick={onExit}>
          К выбору
        </button>
      </header>
      {error ? (
        <p className="demo-error" role="alert">{error}</p>
      ) : capture ? (
        <Player capture={capture} />
      ) : (
        <p className="demo-loading">Читаю снимок с диска приложения…</p>
      )}
    </div>
  );
}

function Player({ capture }: { capture: CaptureView }) {
  const [modeId, setModeId] = useState<DemoModeId>("attack");
  const [paused, setPaused] = useState(false);
  const mode = modeById(modeId);
  const slides = useMemo(() => slidesFor(modeId, capture), [modeId, capture]);
  const cue = useCue(slides, paused, modeId);
  const slide = slides.find((item) => item.key === cue.key) ?? slides[0];
  const stage = stageFor(modeId, slide.key);
  const href = sourceHref(capture.meta);

  return (
    <div className="demo-body">
      <nav className="demo-nav" aria-label="Режимы демо">
        {(["SDR", "ESP32", "Карта"] as const).map((group) => (
          <div key={group}>
            <p className="demo-kicker">{group}</p>
            {DEMO_MODES.filter((item) => item.group === group).map((item) => (
              <button
                key={item.id}
                type="button"
                aria-pressed={item.id === modeId}
                className={item.id === modeId ? "on" : ""}
                onClick={() => setModeId(item.id)}
              >
                {item.title}
              </button>
            ))}
          </div>
        ))}
      </nav>
      <section className="demo-main" data-demo-mode={modeId}>
        <header>
          <h1>{mode.title}</h1>
          <p>{mode.summary}</p>
          <ul className="demo-chips">
            <li>Сканер: {mode.scanner ? "участвует" : "не участвует"}</li>
            <li>Подсказки хоста: {mode.hostHints ? "по снимку" : "нет"}</li>
            <li>Плата: в этом контуре нет</li>
          </ul>
        </header>
        <div className="demo-stage" data-stage={stage}>
          {stage === "seek" && <SeekStage capture={capture} progress={cue.progress} />}
          {stage === "tape" && <TapeStage capture={capture} />}
          {stage === "walk" && (modeId === "sweep" || modeId === "band" || modeId === "hop") && (
            <WalkStage pattern={modeId} capture={capture} />
          )}
          {stage === "grid" && (
            <GridStage
              capture={capture}
              noun={modeId === "esp32" ? "Сетка синтезатора" : "Сетка генерации FPGA"}
            />
          )}
          {stage === "lamp" && <LampStage capture={capture} mode={modeId} />}
          {stage === "map" && <MapStage />}
        </div>
        <article
          className="demo-cue"
          data-cue-key={slide.key}
          onMouseEnter={() => setPaused(true)}
          onMouseLeave={() => setPaused(false)}
        >
          <div className="demo-cue-head">
            <p className="demo-kicker">{slide.kicker}</p>
            <p className="demo-cue-hold">{paused ? "пауза" : "4 с"}</p>
          </div>
          <h2>{slide.title}</h2>
          <p aria-live="polite">{slide.text}</p>
          <div className="demo-meter" aria-hidden="true">
            <span style={{ width: `${cue.progress * 100}%` }} />
          </div>
          <div className="demo-dots" aria-hidden="true">
            {slides.map((item) => (
              <i key={item.key} className={item.key === slide.key ? "on" : ""} />
            ))}
          </div>
        </article>
        <p className="demo-source">
          {capture.meta.device} · центр {mhz(capture.meta.centerHz)} МГц ·{" "}
          {(capture.meta.sampleRate / 1e6).toLocaleString("ru-RU")} МГц/с ·{" "}
          {capture.sampleCount.toLocaleString("ru-RU")} комплексных int16 ·{" "}
          <a href={href} target="_blank" rel="noreferrer">
            sigmf/example_nonsigmf_recordings
          </a>
        </p>
      </section>
    </div>
  );
}

function mhz(hz: number): string {
  return (hz / 1e6).toLocaleString("ru-RU", {
    minimumFractionDigits: 3,
    maximumFractionDigits: 3,
  });
}
