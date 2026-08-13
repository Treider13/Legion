// ============================================================================
// LEGION — 3D-сцена: Canvas + камера с pointer-parallax + постпроцессинг
// (Bloom/Noise/Vignette — @react-three/postprocessing, стандарт 2026).
// ============================================================================
import { useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Bloom, EffectComposer, Noise, Vignette } from "@react-three/postprocessing";
import * as THREE from "three";

import { CyberEye } from "./CyberEye";

interface SceneProps {
  tier: "low" | "high";
}

/** Камера: лёгкий дрейф + параллакс от указателя (без React-стейта) */
function CameraRig() {
  const { camera, pointer } = useThree();
  const target = useRef(new THREE.Vector3(0, 0, 0));
  void target;
  useFrame((state) => {
    const t = state.clock.elapsedTime;
    camera.position.x = THREE.MathUtils.lerp(
      camera.position.x,
      pointer.x * 0.35 + Math.sin(t * 0.11) * 0.12,
      0.04,
    );
    camera.position.y = THREE.MathUtils.lerp(
      camera.position.y,
      0.6 + pointer.y * 0.25 + Math.cos(t * 0.13) * 0.08,
      0.04,
    );
    camera.lookAt(0, 0, 0);
  });
  return null;
}

export function Scene({ tier }: SceneProps) {
  const dpr = Math.min(2, window.devicePixelRatio || 1); // cap DPR ≤ 2 (SOTD-2026)
  return (
    <Canvas
      dpr={dpr}
      camera={{ position: [0, 0.6, 3.4], fov: 42 }}
      gl={{ antialias: false, powerPreference: "high-performance" }}
      style={{ background: "transparent" }}
    >
      <CameraRig />
      <CyberEye tier={tier} />
      {tier === "high" && <FxWithGuard />}
    </Canvas>
  );
}

/** Постпроцессинг с runtime-защитой: если FPS < 30 устойчиво — снимаем эффекты
 *  (динамическая деградация, тренд 2026: device-tier не только на старте). */
function FxWithGuard() {
  const [enabled, setEnabled] = useState(true);
  const acc = useRef({ frames: 0, t: 0, slow: 0 });

  useFrame((_, delta) => {
    if (!enabled) return;
    const a = acc.current;
    a.frames++;
    a.t += delta;
    if (a.t >= 1) {
      const fps = a.frames / a.t;
      a.slow = fps < 30 ? a.slow + 1 : 0;
      if (a.slow >= 2) setEnabled(false); // 2 секунды подряд <30 fps
      a.frames = 0;
      a.t = 0;
    }
  });

  if (!enabled) return null;
  return (
    <EffectComposer multisampling={0}>
      <Bloom
        intensity={0.55}
        luminanceThreshold={0.7}
        luminanceSmoothing={0.9}
        mipmapBlur
      />
      <Noise opacity={0.035} />
      <Vignette eskil={false} offset={0.22} darkness={0.7} />
    </EffectComposer>
  );
}
