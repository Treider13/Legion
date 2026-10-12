import { lazy, Suspense } from "react";

const LiveApp = lazy(() => import("../App.tsx"));

export function LegionEntry() {
  return (
    <Suspense fallback={null}>
      <LiveApp />
    </Suspense>
  );
}
