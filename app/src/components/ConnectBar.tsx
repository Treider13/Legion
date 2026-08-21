// LEGION — панель подключения: транспорт / порт / connect (фаза 2)
import { useEffect } from "react";

import { useLegion } from "../state/store";
import { isTauriRuntime, isWebSerialSupported, type TransportKind } from "../transport/types";

const TRANSPORTS: Array<{ kind: TransportKind; label: string; tauriOnly?: boolean }> = [
  { kind: "tauri-serial", label: "USB ESP32 (ADF4351)", tauriOnly: true },
  { kind: "htool-sl22", label: "USB HTOOL SL22", tauriOnly: true },
  { kind: "web-serial", label: "USB (Web Serial)" },
  { kind: "websocket", label: "WiFi (WebSocket)" },
  { kind: "mock", label: "Эмуляция (без железа)" },
];

const STATE_LABELS: Record<string, string> = {
  disconnected: "ОТКЛЮЧЕНО",
  connecting: "ПОДКЛЮЧЕНИЕ",
  connected: "ПОДКЛЮЧЕНО",
  error: "ОШИБКА",
};

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
    if (
      (s.transportKind === "tauri-serial" || s.transportKind === "htool-sl22") &&
      s.transportState === "disconnected"
    ) {
      void s.refreshPorts();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.transportKind]);

  const connected = s.transportState === "connected";
  const tauri = isTauriRuntime();
  const transports = TRANSPORTS.filter((t) => !t.tauriOnly || tauri);

  return (
    <section className="panel connect-bar">
      <span className="panel-title">СВЯЗЬ ESP32 // USB-UART — НЕ SDR</span>
      <select
        aria-label="Транспорт подключения"
        value={s.transportKind}
        onChange={(e) => s.setTransportKind(e.target.value as TransportKind)}
        disabled={connected}
      >
        {transports.map((t) => (
          <option key={t.kind} value={t.kind}>
            {t.label}
          </option>
        ))}
      </select>

      {(s.transportKind === "tauri-serial" || s.transportKind === "htool-sl22") && (
        <>
          {/* datalist: dropdown найденных портов + ручной ввод пути.
              Факт: serialport.available_ports на Linux перечисляет только
              udev-железо (ttyUSB/ttyACM); виртуальные PTY — ручным вводом. */}
          <input
            list="legion-ports"
            aria-label="Serial-порт"
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
          aria-label="WebSocket URL"
          value={s.wsUrl}
          onChange={(e) => s.setWsUrl(e.target.value)}
          disabled={connected}
          spellCheck={false}
        />
      )}

      {connected ? (
        <button className="btn-danger" onClick={() => void s.disconnect()}>
          ОТКЛЮЧИТЬ
        </button>
      ) : (
        <button className="btn-primary" onClick={() => void s.connect()}>
          ПОДКЛЮЧИТЬ
        </button>
      )}

      <span className={`state-badge state-${s.transportState}`}>
        {STATE_LABELS[s.transportState] ?? s.transportState.toUpperCase()}
      </span>
      {s.transportKind === "mock" && <span className="mock-badge">ЭМУЛЯЦИЯ</span>}
      {s.transportKind === "htool-sl22" && <span className="mock-badge">SL22 SCPI</span>}
    </section>
  );
}
