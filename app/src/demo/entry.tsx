import { lazy, Suspense, useState } from "react";

import { ContourChoice } from "./ContourChoice";

const LiveApp = lazy(() => import("../App.tsx"));
const DemoApp = lazy(() => import("./DemoApp.tsx").then((mod) => ({ default: mod.DemoApp })));

const CONTOUR_KEY = "legion_contour";

function readContour(): "live" | "demo" | null {
  const value = sessionStorage.getItem(CONTOUR_KEY);
  return value === "live" || value === "demo" ? value : null;
}

export function LegionEntry() {
  const [contour, setContour] = useState<"live" | "demo" | null>(readContour);

  const choose = (next: "live" | "demo") => {
    sessionStorage.setItem(CONTOUR_KEY, next);
    setContour(next);
  };

  if (contour === "demo") {
    return (
      <Suspense fallback={null}>
        <DemoApp
          onExit={() => {
            sessionStorage.removeItem(CONTOUR_KEY);
            setContour(null);
          }}
        />
      </Suspense>
    );
  }

  if (contour === "live") {
    return (
      <Suspense fallback={null}>
        <LiveApp />
      </Suspense>
    );
  }

  return <ContourChoice onChoose={choose} />;
}
