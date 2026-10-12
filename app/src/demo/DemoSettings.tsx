import { useEffect } from "react";

import { PositionPanel } from "../components/PositionPanel";
import type { SdrWalkPattern } from "../sense/modes";

const ESP32 = [
  ["synth", "СИНТЕЗАТОР", "USB → ESP32 → ADF4351"],
  ["corridor", "КОРИДОР TX", "сетка / скорость, без SDR"],
  ["pa", "УСИЛИТЕЛЬ ESP32", "ток · нагрузка 50Ω"],
  ["esp32Flash", "ПРОШИВКА ESP32", "pio env · chip_id · не SDR"],
] as const;

const SDR = [
  ["sdr", "SDR", "Ethernet · офиц. FPGA"],
  ["sdrFlash", "ПРОШИВКА SDR", "офиц. FPGA/FX3 · не ESP32"],
  ["sdrCustom", "КАСТОМ FPGA", "сборка legion · bladeRF-cli"],
  ["position", "ПОЗИЦИЯ", "трасса до антенны противника"],
] as const;

export type DemoWorkspace = (typeof ESP32)[number][0] | (typeof SDR)[number][0];

export function DemoSettings({
  mode,
  workspace,
  pattern: _pattern,
  scanning: _scanning,
  lookText: _lookText,
  busy: _busy,
  onWorkspace,
  onPattern: _onPattern,
  onLook: _onLook,
  onScan: _onScan,
  onClose,
}: {
  mode: "sdr" | "esp32";
  workspace: DemoWorkspace;
  pattern: SdrWalkPattern;
  scanning: boolean;
  lookText: string;
  busy: boolean;
  onWorkspace: (id: DemoWorkspace) => void;
  onPattern: (pattern: SdrWalkPattern) => void;
  onLook: (value: string) => void;
  onScan: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const tabs = mode === "esp32" ? ESP32 : SDR;

  return (
    <div className="cinema-settings" role="dialog" aria-modal="true" aria-label="Настройки">
      <header className="cinema-settings-bar">
        <p>Настройки · лаборатория</p>
        <button type="button" className="cinema-btn ghost" onClick={onClose}>Закрыть</button>
      </header>
      <div className="cinema-settings-body">
        <section className="console">
          <section className="panel connect-bar">
            <span className="panel-title">{mode === "sdr" ? "СВЯЗЬ SDR // USB 3.0 — НЕ ESP32" : "СВЯЗЬ ESP32 // USB"}</span>
            <span className="panel-note">
              {mode === "sdr"
                ? "Демо смотрит снимок Signal Hound. Кабель к плате отсюда не открывается."
                : "Демо рисует коридор синтезатора. По USB команда не уходит."}
            </span>
          </section>
          <nav className="workspace-nav-wrap" aria-label="Режимы стенда">
            <div className={`ws-group ${mode === "esp32" ? "ws-group-active" : ""}`}>
              <span className="ws-group-label">РЕЖИМ 2 · ESP32 (без SDR)</span>
              <div className="workspace-nav workspace-nav-4">
                {ESP32.map(([id, title, hint]) => (
                  <button key={id} type="button" data-workspace={id} className={workspace === id ? "ws-tab active" : "ws-tab"} title={hint} onClick={() => onWorkspace(id)}>
                    <span className="ws-tab-title">{title}</span>
                    <span className="ws-tab-hint">{hint}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className={`ws-group ${mode === "sdr" ? "ws-group-active" : ""}`}>
              <span className="ws-group-label">РЕЖИМ 1 · SDR (Ethernet, без ESP32)</span>
              <div className="workspace-nav workspace-nav-6">
                {SDR.map(([id, title, hint]) => (
                  <button key={id} type="button" data-workspace={id} className={workspace === id ? "ws-tab active" : "ws-tab"} title={hint} onClick={() => onWorkspace(id)}>
                    <span className="ws-tab-title">{title}</span>
                    <span className="ws-tab-hint">{hint}</span>
                  </button>
                ))}
              </div>
            </div>
          </nav>
          <div className="panel-grid panel-grid-one">
            {workspace === "position" ? (
              <PositionPanel />
            ) : (
              <section className="panel">
                <span className="panel-title">{tabs.find((tab) => tab[0] === workspace)?.[1] ?? "ПАНЕЛЬ"}</span>
                <p className="panel-note">{tabs.find((tab) => tab[0] === workspace)?.[2]}</p>
              </section>
            )}
          </div>
          <footer className="app-footer">LEGION v0.1 · демо-снимок · ТОЛЬКО НАГРУЗКА 50Ω</footer>
        </section>
      </div>
    </div>
  );
}
