import { useEffect } from "react";

import { ConnectBar } from "../ConnectBar";
import { CorridorPanel } from "../CorridorPanel";
import { LogPanel } from "../LogPanel";
import { PaPanel } from "../PaPanel";
import { Esp32FlashPanel } from "../Esp32FlashPanel";
import { LegionFlashPanel } from "../LegionFlashPanel";
import { ScanPanel } from "../ScanPanel";
import { SdrFlashPanel } from "../SdrFlashPanel";
import { SignalPanel } from "../SignalPanel";
import { SdrPanel } from "../SdrPanel";
import { SynthPanel } from "../SynthPanel";
import { WorkspaceNav } from "../WorkspaceNav";
import { modeOf } from "../../sense/modes";
import { useLegion } from "../../state/store";

interface Props {
  onClose: () => void;
}

export function SettingsSheet({ onClose }: Props) {
  const workspace = useLegion((s) => s.workspace);
  const transportKind = useLegion((s) => s.transportKind);
  const sl22 = transportKind === "htool-sl22";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="cinema-settings" role="dialog" aria-modal="true" aria-label="Настройки">
      <header className="cinema-settings-bar">
        <p>Настройки · лаборатория</p>
        <button type="button" className="cinema-btn ghost" onClick={onClose}>
          Закрыть
        </button>
      </header>
      <div className="cinema-settings-body">
        <section className="console">
          {modeOf(workspace) === "esp32" ? (
            <ConnectBar />
          ) : (
            <section className="panel connect-bar">
              <span className="panel-title">СВЯЗЬ SDR // ETHERNET — НЕ ESP32</span>
              <span className="panel-note">
                Кабель и IP — вкладка SDR. USB-UART синтезатора в этом режиме нет.
              </span>
            </section>
          )}
          <WorkspaceNav />
          <div className={workspace === "synth" ? "panel-grid" : "panel-grid panel-grid-one"}>
            {workspace === "synth" && <SynthPanel />}
            {workspace === "corridor" && <CorridorPanel />}
            {workspace === "sdr" && <SdrPanel />}
            {workspace === "sdrFlash" && <SdrFlashPanel />}
            {workspace === "sdrCustom" && <LegionFlashPanel />}
            {workspace === "scan" && <ScanPanel />}
            {workspace === "signal" && <SignalPanel />}
            {workspace === "pa" && <PaPanel />}
            {workspace === "esp32Flash" && <Esp32FlashPanel />}
          </div>
          <LogPanel />
          <footer className="app-footer">
            {sl22
              ? "LEGION v0.1 · USB HTOOL SL22 · 45–22600 МГц · ТОЛЬКО НАГРУЗКА 50Ω"
              : "LEGION v0.1 · ESP32→ADF4351 · 35–4400 МГц · ТОЛЬКО НАГРУЗКА 50Ω"}
          </footer>
        </section>
      </div>
    </div>
  );
}
