import { useEffect, useState } from "react";

import { DemoShell } from "./DemoShell";
import { loadCapture, type CaptureView } from "./recording";

export function DemoApp({ onExit }: { onExit: () => void }) {
  const [capture, setCapture] = useState<CaptureView | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const prev = document.title;
    document.title = "ЛЕГИОН — Графит";
    return () => { document.title = prev; };
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    loadCapture(ac.signal).then(setCapture).catch((err: unknown) => {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError(err instanceof Error ? err.message : "снимок не открылся");
    });
    return () => ac.abort();
  }, []);

  return (
    <>
      <DemoShell capture={capture} onExit={onExit} />
      {error && <p className="cinema-warn" role="alert">{error}</p>}
    </>
  );
}
