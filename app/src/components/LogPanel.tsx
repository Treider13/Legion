// LEGION — журнал команд/ответов (фаза 2)
import { useEffect, useRef } from "react";

import { useLegion } from "../state/store";

export function LogPanel() {
  const log = useLegion((s) => s.log);
  const clearLog = useLegion((s) => s.clearLog);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Скроллим ТОЛЬКО контейнер лога, не страницу (scrollIntoView тянул
    // всю страницу вниз на 381px при маунте — найдено пробником)
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log.length]);

  return (
    <section className="panel log-panel">
      <span className="panel-title">
        ЖУРНАЛ
        <button className="btn-ghost btn-mini" onClick={clearLog}>
          ОЧИСТИТЬ
        </button>
      </span>
      <div className="log-scroll" ref={scrollRef}>
        {log.map((e, i) => (
          <div key={i} className={`log-line log-${e.dir}`}>
            <span className="log-ts">
              {new Date(e.ts).toLocaleTimeString("ru-RU", { hour12: false })}
            </span>
            <span className="log-dir">{e.dir === "tx" ? "▶" : e.dir === "rx" ? "◀" : "•"}</span>
            <span className="log-text">{e.text}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
