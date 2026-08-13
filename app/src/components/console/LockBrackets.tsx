// ============================================================================
// LEGION — «TARGET LOCKED» (signature moment S5): HUD-скобки вокруг readout.
// LOCK: скобки смыкаются, amber→phosphor, звук захвата.
// ============================================================================
import { useEffect, useRef } from "react";

import { useLegion } from "../../state/store";
import { lockChirp, unlockTick } from "../../sound/sound";

export function LockBrackets({ children }: { children: React.ReactNode }) {
  const lock = useLegion((s) => s.lock);
  const prev = useRef<boolean | null>(null);

  useEffect(() => {
    if (prev.current === lock) return;
    if (prev.current !== null) {
      if (lock) {
        lockChirp();
      } else {
        unlockTick();
      }
    }
    prev.current = lock;
  }, [lock]);

  return (
    <div className={`lock-frame ${lock === null ? "idle" : lock ? "locked" : "lost"}`}>
      <span className="bracket tl" />
      <span className="bracket tr" />
      <span className="bracket bl" />
      <span className="bracket br" />
      <span className="lock-caption">
        {lock === null ? "ОЖИДАНИЕ" : lock ? "ЦЕЛЬ ЗАХВАЧЕНА" : "НЕТ ЗАХВАТА"}
      </span>
      {children}
    </div>
  );
}
