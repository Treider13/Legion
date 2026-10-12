import { useState } from "react";

import "../App.css";
import "../components/cinema/cinema.css";
import "../components/graphite/graphite.css";
import { LegionFlashPanel } from "../components/LegionFlashPanel";

/** Экран приложения: старой умной атаки нет. Окно оператора — отдельный процесс. */
export function OperatorHome() {
  const [build, setBuild] = useState(false);

  return (
    <div className="legion-root cinema graphite" data-contour="operator">
      <div className="cinema-gate" role="presentation">
        <div className="cinema-gate-card" role="dialog" aria-modal="true" aria-labelledby="operator-title">
          <p className="cinema-kicker">LEGION</p>
          <h2 id="operator-title">Окно оператора</h2>
          <p className="cinema-gate-lead">
            Кнопки, мониторинг и живой водопад открываются одной командой
            {" "}
            <code>python -m host.legion_rx.main_app</code>
            . После сборки образа FPGA та же программа стоит в меню под иконкой LEGION.
          </p>
          <div className="cinema-gate-actions">
            <button type="button" className="cinema-btn solid" onClick={() => setBuild(true)}>
              Сборка образа FPGA
            </button>
          </div>
        </div>
      </div>
      {build && (
        <div className="cinema-settings" role="dialog" aria-modal="true" aria-label="Сборка образа FPGA">
          <header className="cinema-settings-bar">
            <p>Сборка образа FPGA</p>
            <button type="button" className="cinema-btn ghost" onClick={() => setBuild(false)}>
              Закрыть
            </button>
          </header>
          <div className="cinema-settings-body">
            <LegionFlashPanel />
          </div>
        </div>
      )}
    </div>
  );
}
