// LEGION — два режима, две группы вкладок. Не смешиваем тракты.
import { modeOf } from "../sense/modes";
import { useLegion, type WorkspaceId } from "../state/store";

const ESP32: Array<{ id: WorkspaceId; title: string; hint: string }> = [
  { id: "synth", title: "СИНТЕЗАТОР", hint: "USB → ESP32 → ADF4351" },
  { id: "corridor", title: "КОРИДОР TX", hint: "сетка / скорость, без SDR" },
  { id: "pa", title: "УСИЛИТЕЛЬ ESP32", hint: "ток · нагрузка 50Ω" },
  { id: "esp32Flash", title: "ПРОШИВКА ESP32", hint: "pio env · chip_id · не SDR" },
];

const SDR: Array<{ id: WorkspaceId; title: string; hint: string }> = [
  { id: "sdr", title: "SDR", hint: "Ethernet · офиц. FPGA" },
  { id: "scan", title: "СКАН + TX SDR", hint: "антенна и усилитель на SDR" },
  { id: "signal", title: "ТИП СИГНАЛА", hint: "baseband → SDR · нагрузка 50Ω" },
  { id: "sdrFlash", title: "ПРОШИВКА SDR", hint: "офиц. FPGA/FX3 · не ESP32" },
];

export function WorkspaceNav() {
  const workspace = useLegion((s) => s.workspace);
  const setWorkspace = useLegion((s) => s.setWorkspace);
  const mode = modeOf(workspace);

  return (
    <nav className="workspace-nav-wrap" aria-label="Режимы стенда">
      <div className={`ws-group ${mode === "esp32" ? "ws-group-active" : ""}`}>
        <span className="ws-group-label">РЕЖИМ 2 · ESP32 (без SDR)</span>
        <div className="workspace-nav workspace-nav-4">
          {ESP32.map((t) => (
            <button
              key={t.id}
              type="button"
              data-workspace={t.id}
              className={workspace === t.id ? "ws-tab active" : "ws-tab"}
              onClick={() => setWorkspace(t.id)}
              title={t.hint}
            >
              <span className="ws-tab-title">{t.title}</span>
              <span className="ws-tab-hint">{t.hint}</span>
            </button>
          ))}
        </div>
      </div>
      <div className={`ws-group ${mode === "sdr" ? "ws-group-active" : ""}`}>
        <span className="ws-group-label">РЕЖИМ 1 · SDR (Ethernet, без ESP32)</span>
        <div className="workspace-nav workspace-nav-4">
          {SDR.map((t) => (
            <button
              key={t.id}
              type="button"
              data-workspace={t.id}
              className={workspace === t.id ? "ws-tab active" : "ws-tab"}
              onClick={() => setWorkspace(t.id)}
              title={t.hint}
            >
              <span className="ws-tab-title">{t.title}</span>
              <span className="ws-tab-hint">{t.hint}</span>
            </button>
          ))}
        </div>
      </div>
    </nav>
  );
}
