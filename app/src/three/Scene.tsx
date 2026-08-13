// ============================================================================
// LEGION — 3D-сцена: Canvas + камера с pointer-parallax + постпроцессинг
// (Bloom/Noise/Vignette — @react-three/postprocessing, стандарт 2026).
// ============================================================================
import { useRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Bloom, EffectComposer, Noise, Vignette } from "@react-three/postprocessing";
import * as THREE from "three";

import { RfSphere } from "./RfSphere";

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
      <RfSphere tier={tier} />
      {tier === "high" && (
        <EffectComposer multisampling={0}>
          <Bloom
            intensity={0.85}
            luminanceThreshold={0.18}
            luminanceSmoothing={0.75}
            mipmapBlur
          />
          <Noise opacity={0.05} />
          <Vignette eskil={false} offset={0.18} darkness={0.85} />
        </EffectComposer>
      )}
    </Canvas>
  );
}
