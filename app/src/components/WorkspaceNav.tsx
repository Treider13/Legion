// LEGION — меню ролей стенда. Не смешиваем TX-коридор, RX-скан и SDR.
import { useLegion, type WorkspaceId } from "../state/store";

const TABS: Array<{ id: WorkspaceId; title: string; hint: string }> = [
  { id: "synth", title: "СИНТЕЗАТОР", hint: "режим ESP32 · без SDR" },
  { id: "corridor", title: "КОРИДОР TX", hint: "ESP32 сетка, не приём" },
  { id: "sdr", title: "SDR", hint: "режим SDR · Ethernet · офиц. FPGA" },
  { id: "scan", title: "СКАН RX", hint: "антенна SDR · полоса · ПЕРЕДАТЬ" },
  { id: "pa", title: "УСИЛИТЕЛЬ", hint: "ESP32 ток · нагрузка 50Ω" },
];

export function WorkspaceNav() {
  const workspace = useLegion((s) => s.workspace);
  const setWorkspace = useLegion((s) => s.setWorkspace);

  return (
    <nav className="workspace-nav" aria-label="Разделы стенда">
      {TABS.map((t) => (
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
    </nav>
  );
}
