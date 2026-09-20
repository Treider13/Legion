import type { ReactNode } from "react";

function Icon({ kind }: { kind: "source" | "range" | "display" | "clock" }) {
  const paths = {
    source: <><path d="M12 13v7m-3 0h6M8.5 15a5 5 0 0 1 0-7M15.5 8a5 5 0 0 1 0 7M5.5 18a9 9 0 0 1 0-13M18.5 5a9 9 0 0 1 0 13"/><circle cx="12" cy="11.5" r="1.5"/></>,
    range: <><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M9 9h6v6H9z"/></>,
    display: <path d="M5 18V7m7 11V4m7 14v-8"/>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/></>,
  };
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" aria-hidden="true">{paths[kind]}</svg>;
}

export function GraphiteNav({ onSettings, motion, reduced, onMotion }: {
  onSettings: () => void; motion: boolean; reduced: boolean; onMotion: () => void;
}) {
  return <>
    <nav className="graphite-nav" aria-label="Главная навигация">
      <a href="#graphite-overview">Обзор</a>
      <a href="#graphite-spectrum">Спектр</a>
      <a href="#graphite-history">История</a>
      <button type="button" onClick={onSettings}>Настройки</button>
    </nav>
    <div className="graphite-edition"><span>13 / ГРАФИТ</span><button type="button" onClick={onMotion} aria-pressed={motion} disabled={reduced} title={reduced ? "Уменьшение движения включено в системе" : "Движение фона"}>{motion ? "SLOW MOTION" : "СТАТИЧНО"}</button></div>
  </>;
}

export function GraphiteConsole({ source, range, rangeNote, motion, lite, spectrum, history }: {
  source: string; range: string; rangeNote: string; motion: boolean; lite: boolean;
  spectrum?: ReactNode; history: ReactNode;
}) {
  const cards = [
    { kind: "source" as const, label: "Интерфейс", value: source, note: "выбранный источник" },
    { kind: "range" as const, label: "Диапазон", value: range, note: rangeNote },
    { kind: "display" as const, label: "Графика", value: lite ? "Canvas 2D" : "Three.js / WebGL", note: "отображение" },
    { kind: "clock" as const, label: "Движение фона", value: motion ? "SLOW MOTION" : "СТАТИЧНО", note: "оформление" },
  ];
  return <section className="graphite-console" id="graphite-spectrum" aria-label="Спектр и история">
    <header className="graphite-console-heading"><h1>СПЕКТР</h1><span>СПЕКТРАЛЬНЫЙ АНАЛИЗАТОР</span><span className="graphite-console-source">{source}</span></header>
    <div className="graphite-stats">{cards.map(card => <div className="graphite-stat" key={card.kind}><Icon kind={card.kind}/><div><span className="graphite-stat-label">{card.label}</span><span className="graphite-stat-value">{card.value}</span></div><small>{card.note}</small></div>)}</div>
    {spectrum && <div className="graphite-spectrum">{spectrum}</div>}
    <section className="graphite-history" id="graphite-history" aria-label="История спектра"><header><span>История спектра</span><small>Штатное отображение данных</small></header>{history}</section>
  </section>;
}
