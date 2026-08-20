// LEGION — меню ролей стенда. Не смешиваем TX-коридор, RX-скан и SDR.
import { useLegion, type WorkspaceId } from "../state/store";

const TABS: Array<{ id: WorkspaceId; title: string; hint: string }> = [
  { id: "synth", title: "СИНТЕЗАТОР", hint: "ADF4351 · частота · мощность" },
  { id: "corridor", title: "КОРИДОР TX", hint: "передача по сетке, не приём" },
  { id: "sdr", title: "SDR", hint: "BladeRF и другие · прошивка" },
  { id: "scan", title: "СКАН RX", hint: "allowlist · обнаружение" },
  { id: "pa", title: "УСИЛИТЕЛЬ", hint: "нагрузка 50Ω · ток · наведение" },
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
