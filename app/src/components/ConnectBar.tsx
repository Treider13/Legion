// LEGION — панель подключения: транспорт / порт / connect (фаза 2)
import { useEffect } from "react";

import { useLegion } from "../state/store";
import { isTauriRuntime, isWebSerialSupported, type TransportKind } from "../transport/types";

const TRANSPORTS: Array<{ kind: TransportKind; label: string }> = [
  { kind: "tauri-serial", label: "USB (Tauri)" },
  { kind: "web-serial", label: "USB (Web Serial)" },
  { kind: "websocket", label: "WiFi (WebSocket)" },
  { kind: "mock", label: "MOCK (без железа)" },
];

export function ConnectBar() {
  const s = useLegion();

  useEffect(() => {
    // В Tauri по умолчанию serial; в браузере — Web Serial если есть
    if (isTauriRuntime()) {
      s.setTransportKind("tauri-serial");
      // Хук автоматизации: начальный порт из LEGION_PORT (см. src-tauri)
      import("@tauri-apps/api/core")
        .then(({ invoke }) => invoke<string | null>("legion_default_port"))
        .then((p) => {
          if (p) s.setSelectedPort(p);
        })
        .catch(() => {});
    } else if (isWebSerialSupported()) {
      s.setTransportKind("web-serial");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (s.transportKind === "tauri-serial" && s.transportState === "disconnected") {
      void s.refreshPorts();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.transportKind]);

  const connected = s.transportState === "connected";

  return (
    <section className="panel connect-bar">
      <span className="panel-title">LINK</span>
      <select
        value={s.transportKind}
        onChange={(e) => s.setTransportKind(e.target.value as TransportKind)}
        disabled={connected}
      >
        {TRANSPORTS.map((t) => (
          <option key={t.kind} value={t.kind}>
            {t.label}
          </option>
        ))}
      </select>

      {s.transportKind === "tauri-serial" && (
        <>
          {/* datalist: dropdown найденных портов + ручной ввод пути.
              Факт: serialport.available_ports на Linux перечисляет только
              udev-железо (ttyUSB/ttyACM); виртуальные PTY — ручным вводом. */}
          <input
            list="legion-ports"
            placeholder="/dev/ttyUSB0"
            value={s.selectedPort}
            onChange={(e) => s.setSelectedPort(e.target.value)}
            disabled={connected}
            spellCheck={false}
          />
          <datalist id="legion-ports">
            {s.ports.map((p) => (
              <option key={p.path} value={p.path}>
                {p.label}
              </option>
            ))}
          </datalist>
          <button onClick={() => void s.refreshPorts()} disabled={connected}>
            ⟳
          </button>
        </>
      )}

      {s.transportKind === "websocket" && (
        <input
          value={s.wsUrl}
          onChange={(e) => s.setWsUrl(e.target.value)}
          disabled={connected}
          spellCheck={false}
        />
      )}

      {connected ? (
        <button className="btn-danger" onClick={() => void s.disconnect()}>
          DISCONNECT
        </button>
      ) : (
        <button className="btn-primary" onClick={() => void s.connect()}>
          CONNECT
        </button>
      )}

      <span className={`state-badge state-${s.transportState}`}>
        {s.transportState.toUpperCase()}
      </span>
      {s.transportKind === "mock" && <span className="mock-badge">MOCK</span>}
    </section>
  );
}
