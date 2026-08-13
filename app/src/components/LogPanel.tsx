// LEGION — журнал команд/ответов (фаза 2)
import { useEffect, useRef } from "react";

import { useLegion } from "../state/store";

export function LogPanel() {
  const log = useLegion((s) => s.log);
  const clearLog = useLegion((s) => s.clearLog);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "instant", block: "end" });
  }, [log.length]);

  return (
    <section className="panel log-panel">
      <span className="panel-title">
        LOG
        <button className="btn-ghost btn-mini" onClick={clearLog}>
          CLEAR
        </button>
      </span>
      <div className="log-scroll">
        {log.map((e, i) => (
          <div key={i} className={`log-line log-${e.dir}`}>
            <span className="log-ts">
              {new Date(e.ts).toLocaleTimeString("ru-RU", { hour12: false })}
            </span>
            <span className="log-dir">{e.dir === "tx" ? "▶" : e.dir === "rx" ? "◀" : "•"}</span>
            <span className="log-text">{e.text}</span>
          </div>
        ))}
        <div ref={endRef} />
      </div>
    </section>
  );
}
