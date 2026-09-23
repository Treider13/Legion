import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { LegionEntry } from "./demo/entry.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LegionEntry />
  </StrictMode>,
);
