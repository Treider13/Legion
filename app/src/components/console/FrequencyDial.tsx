// ============================================================================
// LEGION — частотный дайл-«энкодер» (signature moment S3):
// drag с кинетической инерцией, колесо мыши, Shift = fine, цифры-одометр.
// ============================================================================
import { useCallback, useEffect, useRef } from "react";

import { useLegion } from "../../state/store";
import { uiClick } from "../../sound/sound";

export function FrequencyDial() {
  const freqMhz = useLegion((s) => s.freqMhz);
  const setFreqMhz = useLegion((s) => s.setFreqMhz);
  const setFrequency = useLegion((s) => s.setFrequency);
  const connected = useLegion((s) => s.transportState === "connected");

  const drag = useRef({ active: false, lastY: 0, vel: 0, raf: 0 });
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const commit = useCallback(() => {
    if (commitTimer.current) clearTimeout(commitTimer.current);
    commitTimer.current = setTimeout(() => void setFrequency(), 280);
  }, [setFrequency]);

  const applyDelta = useCallback(
    (deltaMhz: number) => {
      const cur = parseFloat(useLegion.getState().freqMhz) || 2475;
      const next = Math.min(4400, Math.max(34.375, cur + deltaMhz));
      setFreqMhz(next.toFixed(4));
      commit();
    },
    [setFreqMhz, commit],
  );

  // Инерция после отпускания drag
  const inertia = useCallback(() => {
    const d = drag.current;
    d.vel *= 0.93;
    if (Math.abs(d.vel) < 0.0005) return;
    applyDelta(d.vel);
    d.raf = requestAnimationFrame(inertia);
  }, [applyDelta]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (!connected) return;
    drag.current.active = true;
    drag.current.lastY = e.clientY;
    drag.current.vel = 0;
    cancelAnimationFrame(drag.current.raf);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current.active) return;
    const dy = drag.current.lastY - e.clientY;
    drag.current.lastY = e.clientY;
    const step = e.shiftKey ? 0.0001 : 0.01; // Shift = fine
    const delta = dy * step * 0.1;
    drag.current.vel = delta;
    applyDelta(delta);
  };
  const onPointerUp = () => {
    if (!drag.current.active) return;
    drag.current.active = false;
    drag.current.raf = requestAnimationFrame(inertia);
    uiClick();
  };

  const onWheel = (e: React.WheelEvent) => {
    if (!connected) return;
    const step = e.shiftKey ? 0.001 : 0.1;
    applyDelta(e.deltaY < 0 ? step : -step);
  };

  useEffect(
    () => () => {
      cancelAnimationFrame(drag.current.raf);
      if (commitTimer.current) clearTimeout(commitTimer.current);
    },
    [],
  );

  // Цифры-одометр: каждая цифра — span с ключом (CSS-переход при смене)
  const digits = freqMhz.padStart(8, "0").split("");

  return (
    <div
      className={`freq-dial ${connected ? "" : "disabled"}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onWheel={onWheel}
      title="Drag ↕ / wheel — перестройка; Shift — точный шаг"
    >
      <div className="freq-dial-digits">
        {digits.map((d, i) => (
          <span key={i} className={`freq-digit ${d === "." ? "dot" : ""}`}>
            {d}
          </span>
        ))}
        <span className="freq-dial-unit">MHz</span>
      </div>
      <div className="freq-dial-hint">DRAG / WHEEL · SHIFT=FINE</div>
    </div>
  );
}
