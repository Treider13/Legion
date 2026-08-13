import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// LEGION — Vite config.
// LEGION_LITE=1 → lite-сборка для ESP32 (без 3D/R3F — Canvas2D fallback).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __LEGION_LITE__: JSON.stringify(process.env.LEGION_LITE === "1"),
  },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 2500,
    // Vite 8 (Rolldown): manualChunks заменён на advancedChunks
    rollupOptions: {},
    // Разделение тяжёлых чанков для lazy-loading
    // (Rolldown API; при смене движка — удалить)
    // @ts-expect-error rolldown-specific
    advancedChunks: {
      groups: [
        { name: "three", test: /three|@react-three/ },
        { name: "gsap", test: /gsap/ },
      ],
    },
  },
});
