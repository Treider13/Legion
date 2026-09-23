import "../App.css";
import "../components/cinema/cinema.css";
import "../components/graphite/graphite.css";

export function ContourChoice({ onChoose }: { onChoose: (contour: "live" | "demo") => void }) {
  return (
    <div className="legion-root cinema graphite" data-contour="choice">
      <div className="cinema-gate" role="presentation">
        <div className="cinema-gate-card" role="dialog" aria-modal="true" aria-labelledby="contour-title">
          <p className="cinema-kicker">Запуск</p>
          <h2 id="contour-title">Какой контур открыть</h2>
          <p className="cinema-gate-lead">Демо — тот же экран, что боевой. Снимок с GitHub вместо платы.</p>
          <div className="cinema-paths" role="group" aria-label="Контур">
            <button type="button" className="cinema-path" onClick={() => onChoose("live")}>
              <strong>Боевой</strong>
              <span>Текущее приложение: плата, сканер, передача, позиция.</span>
            </button>
            <button type="button" className="cinema-path on" onClick={() => onChoose("demo")}>
              <strong>Демо</strong>
              <span>Тот же интерфейс на снимке Signal Hound. Команды на плату отсюда не уходят.</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
