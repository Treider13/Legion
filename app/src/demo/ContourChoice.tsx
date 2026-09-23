import "./demo.css";

export function ContourChoice({ onChoose }: { onChoose: (contour: "live" | "demo") => void }) {
  return (
    <main className="demo-choice">
      <div className="demo-choice-card">
        <p className="demo-brand">ЛЕГИОН</p>
        <p className="demo-kicker">Запуск</p>
        <h1>Какой контур открыть</h1>
        <div className="demo-picks">
          <button type="button" className="demo-pick" onClick={() => onChoose("live")}>
            <span className="demo-kicker">Система</span>
            <strong>Боевой</strong>
            <span>Текущее приложение: плата, сканер, передача, позиция.</span>
          </button>
          <button type="button" className="demo-pick demo-pick-demo" onClick={() => onChoose("demo")}>
            <span className="demo-kicker">Отдельный контур</span>
            <strong>Демо</strong>
            <span>Снимок Signal Hound с GitHub. Режимы листаются по записи, команды на плату отсюда не уходят.</span>
          </button>
        </div>
      </div>
    </main>
  );
}
