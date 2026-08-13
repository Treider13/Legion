// LEGION — Фаза 2: функциональный интерфейс управления.
// Полная дизайн-система LEGION (boot, RF-СФЕРА, дайл, range gate) — фаза 5.
import "./App.css";

import { ConnectBar } from "./components/ConnectBar";
import { FrequencyPanel } from "./components/FrequencyPanel";
import { LogPanel } from "./components/LogPanel";
import { PowerPanel } from "./components/PowerPanel";

function App() {
  return (
    <main className="legion-app">
      <header className="app-header">
        <span className="app-title">LEGION</span>
        <span className="app-subtitle">RF SYNTH CONTROL // ADF4351</span>
      </header>
      <ConnectBar />
      <div className="panel-grid">
        <FrequencyPanel />
        <PowerPanel />
      </div>
      <LogPanel />
    </main>
  );
}

export default App;
