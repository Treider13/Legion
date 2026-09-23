import type { ReactNode } from "react";
import { GraphiteFacts } from "./GraphiteInsight";

export function GraphiteNav({
  onSettings,
  onPosition,
  motion,
  reduced,
  onMotion,
}: {
  onSettings: () => void;
  onPosition: () => void;
  motion: boolean;
  reduced: boolean;
  onMotion: () => void;
}) {
  return (
    <>
      <nav className="graphite-nav" aria-label="Главная навигация">
        <a href="#graphite-overview">Обзор</a>
        <a href="#graphite-spectrum">Спектр</a>
        <button type="button" onClick={onPosition}>
          Позиция
        </button>
        <button type="button" onClick={onSettings}>
          Настройки
        </button>
      </nav>
      <div className="graphite-edition">
        <span>13 / ГРАФИТ</span>
        <button
          type="button"
          onClick={onMotion}
          aria-pressed={motion}
          disabled={reduced}
          title={reduced ? "Уменьшение движения включено в системе" : "Движение фона"}
        >
          {motion ? "SLOW MOTION" : "СТАТИЧНО"}
        </button>
      </div>
    </>
  );
}

export function GraphiteConsole({
  source,
  sourceNote,
  range,
  rangeNote,
  spectrum,
  history,
}: {
  source: string;
  sourceNote: string;
  range: string;
  rangeNote: string;
  spectrum?: ReactNode;
  history: ReactNode;
}) {
  return (
    <section className="graphite-console" id="graphite-spectrum" aria-label="Спектр и история">
      <header className="graphite-console-heading">
        <h1>СПЕКТР</h1>
        <span>СПЕКТРАЛЬНЫЙ АНАЛИЗАТОР</span>
        <span className="graphite-console-source">{source}</span>
      </header>
      <GraphiteFacts source={source} sourceNote={sourceNote} range={range} rangeNote={rangeNote} />
      {spectrum && <div className="graphite-spectrum">{spectrum}</div>}
      <section className="graphite-history" id="graphite-history" aria-label="История спектра">
        <header>
          <span>История спектра</span>
          <small>Штатное отображение данных</small>
        </header>
        {history}
      </section>
    </section>
  );
}
