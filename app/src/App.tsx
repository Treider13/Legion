// LEGION — Фаза 0: скаффолд-заглушка.
// Полноценный Transport-слой (Tauri Serial / Web Serial / WebSocket) — фаза 2.
// Дизайн-система LEGION — фаза 5.
import "./App.css";

function App() {
  return (
    <main className="legion-boot">
      <pre className="legion-banner">{`
██╗     ███████╗ ██████╗ ██╗ ██████╗ ███╗   ██╗
██║     ██╔════╝██╔════╝ ██║██╔═══██╗████╗  ██║
██║     █████╗  ██║  ███╗██║██║   ██║██╔██╗ ██║
██║     ██╔══╝  ██║   ██║██║██║   ██║██║╚██╗██║
███████╗███████╗╚██████╔╝██║╚██████╔╝██║ ╚████║
╚══════╝╚══════╝ ╚═════╝ ╚═╝ ╚═════╝ ╚═╝  ╚═══╝
      `}</pre>
      <p className="legion-sub">RF SYNTH CONTROL // ADF4351 via ESP32</p>
      <p className="legion-status">SYSTEM SCAFFOLD OK — AWAITING PHASE 2</p>
    </main>
  );
}

export default App;
